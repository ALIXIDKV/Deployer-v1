// config.js - tanpa hardcode token, baca dari environment
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
export const VERCEL_TOKEN = process.env.VERCEL_TOKEN || '';

export const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || '';
export const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

export const DEPLOY_COOLDOWN_SECONDS = 3600;
export const MAX_DEPLOY_PER_HOUR = 1;
export const RATE_LIMIT_ENABLED = true;
export const ACTIVE_DEPLOY_LOCK_SECONDS = 1800;
export const MAX_REQUEST_PER_MINUTE = 10;
export const SESSION_TTL_SECONDS = 1800;

export const MAX_HTML_SIZE = 1 * 1024 * 1024;    // 1 MB
export const MAX_ZIP_SIZE = 10 * 1024 * 1024;    // 10 MB
export const MAX_FILES_PER_DEPLOY = 300;
export const MAX_TOTAL_EXTRACTED_SIZE = 25 * 1024 * 1024; // 25 MB
export const MAX_BATCH_PER_SESSION = 20;

import os from 'os';
import path from 'path';
export const TEMP_DIR = process.env.VERCEL
  ? '/tmp/deployer-temp'
  : path.join(os.tmpdir(), 'deployer-temp');

export function isRedisEnabled() {
  return !!(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);
}
