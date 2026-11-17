import { BridgeError, publicError } from './state.js';

const ACTION_FIELDS = {
  status: [], 'login.start': ['force'], 'login.verify': ['loginId', 'code'], 'login.cancel': ['loginId'],
  'connection.pause': [], 'connection.resume': [], 'connection.disconnect': [],
  'user.approve': ['userId', 'code'], 'user.revoke': ['userId'],
};

export function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.action !== 'string' || !Object.hasOwn(ACTION_FIELDS, value.action)) {
    throw new BridgeError('INVALID_REQUEST', '无效的微信连接请求。');
  }
  const allowed = new Set(['action', ...ACTION_FIELDS[value.action]]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new BridgeError('INVALID_REQUEST', '请求包含不支持的字段。');
  for (const name of ['loginId', 'userId', 'code']) {
    if (Object.hasOwn(value, name) && (typeof value[name] !== 'string' || value[name].length > (name === 'userId' ? 256 : 64))) {
      throw new BridgeError('INVALID_REQUEST', '请求字段格式不正确。');
    }
  }
  if (Object.hasOwn(value, 'force') && typeof value.force !== 'boolean') throw new BridgeError('INVALID_REQUEST', '无效的扫码选项。');
  if (['login.verify', 'user.approve'].includes(value.action) && !value.code) throw new BridgeError('INVALID_REQUEST', '请输入验证码或配对码。');
  if (value.action.startsWith('user.') && !value.userId) throw new BridgeError('INVALID_REQUEST', '缺少微信用户标识。');
  if (['login.verify', 'login.cancel'].includes(value.action) && !value.loginId) throw new BridgeError('INVALID_REQUEST', '缺少扫码会话标识。');
  return value;
}

function send(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0; const chunks = [];
    const timer = setTimeout(() => finish(new BridgeError('INVALID_REQUEST', '读取请求超时。', 408)), 10000);
    timer.unref?.();
    const cleanup = () => { clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted); };
    const finish = (error, value) => { cleanup(); if (error) { req.resume(); reject(error); } else resolve(value); };
    const data = chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 8192) { finish(new BridgeError('INVALID_REQUEST', '请求内容过大。', 413)); return; }
      chunks.push(Buffer.from(chunk));
    };
    const end = () => {
      try { finish(undefined, validateRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
      catch (error) { finish(error instanceof BridgeError ? error : new BridgeError('INVALID_REQUEST', '请求不是有效的 JSON。')); }
    };
    const fail = () => finish(new BridgeError('INVALID_REQUEST', '请求传输中断。'));
    const aborted = () => finish(new BridgeError('INVALID_REQUEST', '请求已取消。'));
    req.on('data', data); req.on('end', end); req.on('error', fail); req.on('aborted', aborted);
  });
}

/** Uses DSH's own Host/Origin/authentication fence; never a public webhook. */
export function createApiHandler({ connection, bridge }) {
  return async (req, res) => {
    try {
      const admission = connection.admit(req);
      if ('rejection' in admission) {
        send(res, admission.rejection, { ok: false, error: { code: admission.rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', message: '请从已登录的 DSH 设置页访问。' } });
        return;
      }
      if (admission.peer.principal.kind !== 'owner' || admission.peer.id !== connection.browserPeer.id) {
        throw new BridgeError('FORBIDDEN', '此管理接口仅允许 DSH 本人浏览器访问。', 403);
      }
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new BridgeError('INVALID_REQUEST', '仅支持 POST 请求。', 405); }
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')
        || req.headers['x-dsh-weixin-bridge'] !== '1') {
        throw new BridgeError('FORBIDDEN', '请从 DSH 的微信连接面板执行操作。', 403);
      }
      const body = await readBody(req);
      const value = await bridge.action(body.action, body, { user: true });
      send(res, 200, { ok: true, value });
    } catch (error) {
      const result = publicError(error);
      send(res, result.status, { ok: false, error: result.error });
    }
  };
}
