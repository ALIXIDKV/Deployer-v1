import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import Busboy from 'busboy';
import AdmZip from 'adm-zip';
import {
  GITHUB_TOKEN,
  VERCEL_TOKEN,
  MAX_HTML_SIZE,
  MAX_ZIP_SIZE,
  MAX_FILES_PER_DEPLOY,
  MAX_TOTAL_EXTRACTED_SIZE,
  MAX_BATCH_PER_SESSION,
  TEMP_DIR,
} from '../../config.js';
import {
  getClientIp,
  hashValue,
  buildRateLimitKeys,
  checkDeployRateLimit,
  markDeployStarted,
  markDeploySuccess,
  clearFailedDeployLock,
  getCooldownRemaining,
} from '../../lib/rateLimit.js';
import {
  createSession,
  getSession,
  updateSession,
  markSessionSuccess,
  markSessionFailed,
  expireSession,
  addDeploy,
} from '../../peyimpanan/database.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

function parseFormData(req) {
  return new Promise((resolve, reject) => {
    const fields = {};
    const files = [];
    const busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_ZIP_SIZE },
    });

    busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
      const chunks = [];
      file.on('data', (chunk) => chunks.push(chunk));
      file.on('end', () => {
        files.push({ fieldname, filename, mimetype, buffer: Buffer.concat(chunks) });
      });
    });

    busboy.on('field', (name, value) => {
      fields[name] = value;
    });

    busboy.on('finish', () => resolve({ fields, files }));
    busboy.on('error', reject);
    req.pipe(busboy);
  });
}

async function createProjectDir(projectId) {
  const dir = path.join(TEMP_DIR, projectId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function cleanupProjectDir(dir) {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (e) {
    console.error('Gagal hapus temp:', e);
  }
}

async function getAllFiles(dir, basePath = dir) {
  let results = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(basePath, fullPath).split(path.sep).join('/');
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.env' || entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      const subFiles = await getAllFiles(fullPath, basePath);
      results = results.concat(subFiles);
    } else {
      results.push({ relativePath: relPath, absolutePath: fullPath });
    }
  }
  return results;
}

async function findDeployRoot(baseDir) {
  try {
    await fs.access(path.join(baseDir, 'index.html'));
    return baseDir;
  } catch {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subPath = path.join(baseDir, entry.name);
        try {
          await fs.access(path.join(subPath, 'index.html'));
          return subPath;
        } catch {}
      }
    }
    throw new Error('Tidak ditemukan index.html di dalam paket.');
  }
}

function validateZipEntries(zip) {
  const entries = zip.getEntries();
  for (const entry of entries) {
    if (entry.entryName.includes('..')) {
      throw new Error('ZIP mengandung path traversal yang tidak diizinkan.');
    }
  }
}

async function createGitHubRepo(owner, repoName, token) {
  const res = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'vanz-deployer',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: repoName, private: false, auto_init: false }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Gagal membuat repo GitHub: ${err.message || res.statusText}`);
  }
  return res.json();
}

async function uploadFileToGitHub(owner, repo, filePath, contentBase64, token) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'vanz-deployer',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: `Add ${filePath}`,
      content: contentBase64,
      branch: 'main',
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Gagal upload ${filePath} ke GitHub: ${err.message || res.statusText}`);
  }
}

async function deployToVercel(projectName, filesArray, token) {
  const res = await fetch('https://api.vercel.com/v13/deployments', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: projectName,
      files: filesArray,
      projectSettings: { framework: null },
      target: 'production',
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Gagal deploy ke Vercel: ${err.message || res.statusText}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  // Cek token server
  if (!GITHUB_TOKEN || !VERCEL_TOKEN) {
    return res.status(500).json({ success: false, message: 'Server belum dikonfigurasi (token).' });
  }

  let projectDir;
  let sessionId = null;

  try {
    // 1. Parse form data
    const { fields, files } = await parseFormData(req);
    const rawName = fields.repoName;
    let htmlContentFromField = fields.htmlContent || '';
    const visitorId = fields.visitorId || null;

    if (!rawName || typeof rawName !== 'string') {
      return res.status(400).json({ success: false, message: 'Nama project/repo wajib diisi.' });
    }

    // Sanitasi repo name
    const repoName = rawName.trim()
      .replace(/[^a-zA-Z0-9-_]/g, '-')
      .toLowerCase()
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 100);
    if (!repoName) {
      return res.status(400).json({ success: false, message: 'Nama repo tidak valid.' });
    }

    // 2. Rate Limit Check (sebelum resource apa pun dibuat)
    const rateLimitResult = await checkDeployRateLimit(req, visitorId);
    if (rateLimitResult && rateLimitResult.blocked) {
      const remaining = rateLimitResult.remainingSeconds;
      return res.status(429).json({
        success: false,
        message: `Kamu sudah deploy. Coba lagi dalam ${Math.ceil(remaining / 60)} menit.`,
        cooldownSeconds: remaining,
        cooldownUntil: Date.now() + remaining * 1000,
      });
    }

    // 3. Validasi input file/html
    const fileUpload = files.length > 0 ? files[0] : null;
    if (!fileUpload && !htmlContentFromField) {
      return res.status(400).json({ success: false, message: 'Upload file atau tempel kode HTML.' });
    }

    // 4. Buat session (sebelum mark deploy started)
    const fingerprintHash = buildRateLimitKeys(req, visitorId).fingerprintHash;
    const session = createSession({ repoName, fingerprintHash, visitorId });
    sessionId = session.id;

    // 5. Tandai deploy dimulai (active lock)
    await markDeployStarted(req, visitorId);

    // 6. Siapkan project dir
    const projectId = `${repoName}-${crypto.randomBytes(3).toString('hex')}`;
    projectDir = await createProjectDir(projectId);

    // 7. Proses file
    if (fileUpload) {
      const { filename, mimetype, buffer } = fileUpload;
      const ext = path.extname(filename).toLowerCase();
      if (ext === '.html' || mimetype === 'text/html') {
        if (buffer.length > MAX_HTML_SIZE) throw new Error('Ukuran file HTML melebihi 1 MB.');
        await fs.writeFile(path.join(projectDir, 'index.html'), buffer);
      } else if (ext === '.zip' || mimetype === 'application/zip' || mimetype === 'application/x-zip-compressed') {
        if (buffer.length > MAX_ZIP_SIZE) throw new Error('Ukuran ZIP melebihi 10 MB.');
        const zip = new AdmZip(buffer);
        validateZipEntries(zip);
        zip.extractAllTo(projectDir, true);
      } else {
        throw new Error('Format file tidak didukung. Hanya .html atau .zip.');
      }
    } else {
      if (Buffer.byteLength(htmlContentFromField, 'utf8') > MAX_HTML_SIZE) throw new Error('Kode HTML melebihi 1 MB.');
      await fs.writeFile(path.join(projectDir, 'index.html'), htmlContentFromField, 'utf8');
    }

    // 8. Cari root dengan index.html
    const deployRoot = await findDeployRoot(projectDir);

    // 9. Dapatkan semua file (batasi jumlah & total ukuran)
    const fileList = await getAllFiles(deployRoot, deployRoot);
    if (fileList.length === 0) throw new Error('Tidak ada file untuk dideploy.');
    if (fileList.length > MAX_FILES_PER_DEPLOY) throw new Error(`Maksimum ${MAX_FILES_PER_DEPLOY} file per deploy.`);

    let totalSize = 0;
    const filesForUpload = [];
    for (const file of fileList) {
      const content = await fs.readFile(file.absolutePath);
      totalSize += content.length;
      if (totalSize > MAX_TOTAL_EXTRACTED_SIZE) throw new Error('Total ukuran file setelah ekstrak melebihi 25 MB.');
      filesForUpload.push({
        relativePath: file.relativePath,
        data: content.toString('base64'),
      });
    }

    // 10. GitHub
    const userRes = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'vanz-deployer' },
    });
    if (!userRes.ok) throw new Error('Token GitHub tidak valid.');
    const userData = await userRes.json();
    const owner = userData.login;

    // Cek repo exist
    const checkRepo = await fetch(`https://api.github.com/repos/${owner}/${repoName}`, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, 'User-Agent': 'vanz-deployer' },
    });
    if (checkRepo.ok) throw new Error(`Repository "${repoName}" sudah ada.`);
    if (checkRepo.status !== 404) throw new Error('Gagal memeriksa repository.');

    // Buat repo
    const repoData = await createGitHubRepo(owner, repoName, GITHUB_TOKEN);
    const repoUrl = repoData.html_url;

    // Upload semua file ke GitHub
    for (const file of filesForUpload) {
      await uploadFileToGitHub(owner, repoName, file.relativePath, file.data, GITHUB_TOKEN);
    }

    // 11. Deploy Vercel
    const vercelProjectName = `${repoName}-${crypto.randomBytes(2).toString('hex')}`;
    const deployData = await deployToVercel(
      vercelProjectName,
      filesForUpload.map(f => ({ file: f.relativePath, data: f.data })),
      VERCEL_TOKEN
    );
    const deployUrl = deployData.url || (deployData.alias && deployData.alias[0]);
    if (!deployUrl) throw new Error('Vercel tidak mengembalikan URL.');
    const finalUrl = deployUrl.startsWith('http') ? deployUrl : `https://${deployUrl}`;

    // 12. Sukses — tandai cooldown, session sukses
    await markDeploySuccess(req, visitorId);
    markSessionSuccess(sessionId);
    addDeploy({ repo: repoUrl, url: finalUrl, projectName: vercelProjectName });

    return res.status(200).json({
      success: true,
      message: 'Deployment berhasil!',
      url: finalUrl,
      repo: repoUrl,
      projectName: vercelProjectName,
    });

  } catch (error) {
    console.error('Deploy error:', error);

    // Jika error terjadi setelah active lock terpasang, jangan hapus lock sembarangan,
    // tapi pastikan session di-mark failed.
    if (sessionId) {
      markSessionFailed(sessionId);
    }

    return res.status(400).json({
      success: false,
      message: error.message,
    });
  } finally {
    // Bersihkan folder temp
    if (projectDir) {
      await cleanupProjectDir(projectDir);
    }
  }
}
