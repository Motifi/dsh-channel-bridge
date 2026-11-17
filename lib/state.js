import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

export const VERSION = '0.1.0';
export const PRESET_ID = 'weixin-bridge-chat';
export const MAX_SEEN = 1000;
export const MAX_USERS = 24;
export const MAX_INBOX = 20;
export const MAX_OUTBOX = 24;
export const MAX_INPUT_CHARS = 12000;
export const MAX_REPLY_CHARS = 6800;
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const LOGIN_TTL_MS = 10 * 60 * 1000;
export const CONTEXT_MAX_AGE_MS = 60000;
export const SESSION_PATTERN = /^wxbridge-[a-f0-9]{32}$/;
export const MESSAGE_PATTERN = /^wxbridge-in-[a-f0-9]{48}$/;
export const CHANNEL_PRESET_ID = 'dsh-channel-bridge-chat';
export const CHANNEL_SESSION_PATTERN = /^dshbridge-[a-f0-9]{32}$/;
export const CHANNEL_MESSAGE_PATTERN = /^dshbridge-in-[a-f0-9]{48}$/;

export function hash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}
export function accountKey(account) {
  return hash(`${account.botId || hash(account.token)}\u0000${account.userId || ''}`);
}
export function inputKey(key, userId, id) {
  return hash(`${key}\u0000${userId}\u0000${id}`);
}
export function messageId(key) { return `wxbridge-in-${key.slice(0, 48)}`; }
export function sessionId(key, userId) { return `wxbridge-${hash(`${key}\u0000${userId}`).slice(0, 32)}`; }
export function clientId(deliveryId, part) { return `dsh-wx-${hash(`${deliveryId}:${part}`).slice(0, 24)}`; }
export function freshPairingCode() {
  return String(randomInt(0, 100000000)).padStart(8, '0');
}
export function normalizePairingCode(value) { return String(value ?? '').replace(/[\s-]/g, '').toUpperCase(); }
export function pairingHash(userId, code) { return hash(`${userId}\u0000${normalizePairingCode(code)}`); }
export function matchesPairingCode(user, code) {
  const normalized = normalizePairingCode(code);
  if (!/^\d{8}$/.test(normalized) || !/^[a-f0-9]{64}$/.test(user.pairingHash || '')) return false;
  return timingSafeEqual(Buffer.from(pairingHash(user.userId, normalized), 'hex'), Buffer.from(user.pairingHash, 'hex'));
}

export function initialState() {
  return { version: 1, enabled: false, accountKey: '', cursor: '', users: [], inbox: [], outbox: [], seen: [] };
}
export function trimState(state) {
  state.seen = state.seen.slice(-MAX_SEEN);
  const waiting = state.inbox.filter(item => item.state === 'queued' || item.state === 'submitted');
  const settled = state.inbox.filter(item => item.state !== 'queued' && item.state !== 'submitted').slice(-80);
  state.inbox = [...settled, ...waiting];
  const unsent = state.outbox.filter(item => item.state === 'pending' || item.state === 'blocked' || item.state === 'sending');
  const done = state.outbox.filter(item => !['pending', 'blocked', 'sending'].includes(item.state)).slice(-40);
  state.outbox = [...done, ...unsent];
  return state;
}

export class BridgeError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.status = status;
  }
}
export function safeError(error) {
  if (error instanceof BridgeError) return error.message;
  if (error?.kind === 'auth') return '微信登录已失效，请重新扫码连接。';
  if (error?.kind === 'context') return '微信会话暂时无法发送，请从微信再发一条消息。';
  if (['network', 'http', 'protocol'].includes(error?.kind)) return '连接微信服务失败，请检查网络后重试。';
  return '操作未完成，请在 DSH 检查设置后重试。';
}
export function publicError(error) {
  if (error instanceof BridgeError) return { status: error.status, error: { code: error.code, message: error.message } };
  if (error?.kind === 'auth') return { status: 409, error: { code: 'AUTH_REQUIRED', message: safeError(error) } };
  if (['network', 'http', 'protocol'].includes(error?.kind)) return { status: 502, error: { code: 'NETWORK_ERROR', message: safeError(error) } };
  return { status: 500, error: { code: 'INTERNAL_ERROR', message: safeError(error) } };
}

/** Abortable owned delays, not detached intervals. */
export function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    function finish() { cleanup(); resolve(); }
    function abort() { cleanup(); reject(signal.reason ?? new Error('Aborted')); }
    function cleanup() { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}
