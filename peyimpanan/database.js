import { SESSION_TTL_SECONDS } from '../config.js';

// === Session Management (in-memory, untuk keamanan session) ===
const sessions = new Map();

function generateId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substr(2, 9)}`;
}

export function createSession(data) {
  const sessionId = generateId();
  const now = Date.now();
  const session = {
    id: sessionId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
    status: 'created',
    repoName: data.repoName || null,
    fingerprintHash: data.fingerprintHash || null,
    ...data,
  };
  sessions.set(sessionId, session);
  return session;
}

export function getSession(sessionId) {
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

export function updateSession(sessionId, data) {
  const session = getSession(sessionId);
  if (!session) return null;
  Object.assign(session, data);
  return session;
}

export function expireSession(sessionId) {
  sessions.delete(sessionId);
}

export function isSessionExpired(sessionId) {
  return !getSession(sessionId);
}

export function markSessionSuccess(sessionId) {
  return updateSession(sessionId, { status: 'success' });
}

export function markSessionFailed(sessionId) {
  return updateSession(sessionId, { status: 'failed' });
}

// === Riwayat deploy (tetap sederhana) ===
let riwayat = [];

export function addDeploy(data) {
  riwayat.push({
    ...data,
    waktu: new Date().toISOString(),
  });
}

export function getDeploys() {
  return [...riwayat];
}

export function clearDeploys() {
  riwayat = [];
}
