import { createHash } from 'crypto';
import {
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  DEPLOY_COOLDOWN_SECONDS,
  ACTIVE_DEPLOY_LOCK_SECONDS,
  isRedisEnabled,
} from '../config.js';

// Koneksi ke Upstash Redis (REST based)
let redis;
if (isRedisEnabled()) {
  const { Redis } = await import('@upstash/redis');
  redis = new Redis({
    url: UPSTASH_REDIS_REST_URL,
    token: UPSTASH_REDIS_REST_TOKEN,
  });
}

// Fallback in-memory storage (hanya untuk development)
const memoryStore = new Map();
function memoryGet(key) {
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value;
}
function memorySet(key, value, ttlSeconds) {
  memoryStore.set(key, {
    value,
    expiry: Date.now() + ttlSeconds * 1000,
  });
}
function memoryDel(key) {
  memoryStore.delete(key);
}
function memoryExists(key) {
  return memoryGet(key) !== null;
}

// Helper Redis (async)
async function redisGet(key) {
  if (isRedisEnabled()) return await redis.get(key);
  return memoryGet(key);
}
async function redisSet(key, value, ttlSeconds) {
  if (isRedisEnabled()) {
    await redis.set(key, value, { ex: ttlSeconds });
  } else {
    memorySet(key, value, ttlSeconds);
  }
}
async function redisDel(key) {
  if (isRedisEnabled()) await redis.del(key);
  else memoryDel(key);
}
async function redisExists(key) {
  if (isRedisEnabled()) return (await redis.exists(key)) === 1;
  return memoryExists(key);
}
async function redisTTL(key) {
  if (isRedisEnabled()) return await redis.ttl(key);
  const entry = memoryStore.get(key);
  if (!entry) return -2;
  const remaining = Math.ceil((entry.expiry - Date.now()) / 1000);
  return remaining > 0 ? remaining : -2;
}

// === Fungsi Rate Limit ===

/**
 * Ambil IP client dari request.
 */
export function getClientIp(req) {
  const xForwarded = req.headers['x-forwarded-for'];
  if (xForwarded) {
    return xForwarded.split(',')[0].trim();
  }
  const realIp = req.headers['x-real-ip'] || req.headers['cf-connecting-ip'];
  return realIp || req.socket?.remoteAddress || 'unknown';
}

/**
 * Hash nilai agar tidak menyimpan data mentah di Redis.
 */
export function hashValue(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Bangun kunci rate limit berdasarkan data request.
 */
export function buildRateLimitKeys(req, visitorId) {
  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || 'unknown';
  const ipHash = hashValue(ip);
  const uaHash = hashValue(ua);
  const visitorHash = visitorId ? hashValue(visitorId) : null;
  const fingerprintHash = hashValue(`${ipHash}:${uaHash}`);

  return {
    visitorHash,
    ipHash,
    fingerprintHash,
    // Kunci Redis
    limitVisitor: visitorHash ? `limit:visitor:${visitorHash}` : null,
    limitIp: `limit:ip:${ipHash}`,
    limitFingerprint: `limit:fingerprint:${fingerprintHash}`,
    activeDeploy: `deploy:active:${fingerprintHash}`,
  };
}

/**
 * Cek apakah user sedang dalam cooldown atau ada active deploy.
 * Return { blocked, remainingSeconds } atau null jika lolos.
 */
export async function checkDeployRateLimit(req, visitorId) {
  const keys = buildRateLimitKeys(req, visitorId);

  // Cek cooldown limit
  const limitKeys = [keys.limitFingerprint];
  if (keys.limitVisitor) limitKeys.push(keys.limitVisitor);
  limitKeys.push(keys.limitIp);

  for (const key of limitKeys) {
    if (key && (await redisExists(key))) {
      const ttl = await redisTTL(key);
      return {
        blocked: true,
        reason: 'cooldown',
        remainingSeconds: ttl > 0 ? ttl : DEPLOY_COOLDOWN_SECONDS,
      };
    }
  }

  // Cek active deploy lock
  if (await redisExists(keys.activeDeploy)) {
    const ttl = await redisTTL(keys.activeDeploy);
    return {
      blocked: true,
      reason: 'active',
      remainingSeconds: ttl > 0 ? ttl : ACTIVE_DEPLOY_LOCK_SECONDS,
    };
  }

  return null; // lolos
}

/**
 * Tandai deploy sedang berlangsung (active lock).
 */
export async function markDeployStarted(req, visitorId) {
  const keys = buildRateLimitKeys(req, visitorId);
  await redisSet(keys.activeDeploy, '1', ACTIVE_DEPLOY_LOCK_SECONDS);
}

/**
 * Hapus active lock jika deploy gagal sebelum resource dibuat.
 */
export async function clearFailedDeployLock(req, visitorId) {
  const keys = buildRateLimitKeys(req, visitorId);
  await redisDel(keys.activeDeploy);
}

/**
 * Tandai deploy sukses dan set cooldown.
 */
export async function markDeploySuccess(req, visitorId) {
  const keys = buildRateLimitKeys(req, visitorId);

  // Set cooldown untuk semua kunci
  const ttl = DEPLOY_COOLDOWN_SECONDS;
  const promises = [];
  if (keys.limitVisitor) promises.push(redisSet(keys.limitVisitor, '1', ttl));
  promises.push(redisSet(keys.limitIp, '1', ttl));
  promises.push(redisSet(keys.limitFingerprint, '1', ttl));
  // Hapus active lock
  promises.push(redisDel(keys.activeDeploy));

  await Promise.all(promises);
}

/**
 * Helper untuk mendapatkan sisa cooldown dari salah satu kunci (untuk respons error).
 */
export async function getCooldownRemaining(req, visitorId) {
  const keys = buildRateLimitKeys(req, visitorId);
  const checkKeys = [keys.limitFingerprint];
  if (keys.limitVisitor) checkKeys.push(keys.limitVisitor);
  checkKeys.push(keys.limitIp);

  for (const key of checkKeys) {
    if (key && (await redisExists(key))) {
      const ttl = await redisTTL(key);
      return ttl > 0 ? ttl : DEPLOY_COOLDOWN_SECONDS;
    }
  }
  return DEPLOY_COOLDOWN_SECONDS;
}
