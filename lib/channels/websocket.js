import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

export const WEBSOCKET_PATH = '/channels/websocket';

const ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{24,256}$/;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_FRAME_BYTES = MAX_TEXT_BYTES + Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 8192;
const MAX_PENDING_BYTES = 256 * 1024;

function digest(token) {
  return createHash('sha256').update(token).digest();
}

function clientCredentials(raw) {
  try {
    const object = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!object || typeof object !== 'object' || Array.isArray(object)) return null;
    const entries = Object.entries(object);
    if (!entries.length || entries.length > 64) return null;
    const secrets = new Set();
    const clients = new Map();
    for (const [id, token] of entries) {
      if (!ID_PATTERN.test(id) || typeof token !== 'string' || !TOKEN_PATTERN.test(token) || secrets.has(token)) return null;
      secrets.add(token);
      clients.set(id, digest(token));
    }
    return clients;
  } catch { return null; }
}

function chatIdFor(senderId) {
  const hex = createHash('sha256').update('dsh-channel-bridge/websocket:' + senderId).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function authenticatedClient(request, clients, allowSender) {
  let url;
  try { url = new URL(request.url, 'http://localhost'); } catch { return null; }
  const senderId = url.searchParams.get('client_id');
  if (url.searchParams.getAll('client_id').length !== 1 || !clients.has(senderId) || !allowSender(senderId)) return null;
  const bearer = typeof request.headers.authorization === 'string' && request.headers.authorization.match(/^Bearer ([A-Za-z0-9._-]+)$/i);
  const queryTokens = url.searchParams.getAll('token');
  const token = bearer ? bearer[1] : (queryTokens.length === 1 ? queryTokens[0] : null);
  if (!token || !TOKEN_PATTERN.test(token) || !timingSafeEqual(clients.get(senderId), digest(token))) return null;
  return senderId;
}

function rejectUpgrade(socket, reason) {
  socket.end(`HTTP/1.1 ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function validTransport(request) {
  const peer = request.socket.remoteAddress ?? '';
  // Direct non-local sockets need host TLS. A local reverse proxy can terminate TLS.
  return request.socket.encrypted || peer === '::1' || /^(?:::ffff:)?127\./i.test(peer);
}

function errorWithKind(code, kind) {
  return Object.assign(new Error(code), { code, kind });
}

function parseAttachments(raw) {
  if (!Array.isArray(raw) || raw.length > 8) return null;
  const attachments = [];
  let size = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    if (Object.keys(item).some(key => !['name', 'mime', 'data'].includes(key))) return null;
    const { name, mime, data } = item;
    if (typeof name !== 'string' || !name.trim() || name.length > 160 || /[\\/\u0000-\u001F\u007F]/.test(name)
      || typeof mime !== 'string' || mime.length > 100 || !/^[\w.+-]+\/[\w.+-]+$/.test(mime)
      || typeof data !== 'string' || !data || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
    const bytes = Buffer.from(data, 'base64');
    size += bytes.length;
    if (size > MAX_ATTACHMENT_BYTES || bytes.toString('base64') !== data) return null;
    const mediaType = mime.toLowerCase();
    const prefix = mediaType.split('/')[0];
    const kind = ['image', 'audio', 'video'].includes(prefix) ? prefix : 'file';
    attachments.push({ name, mediaType, kind, data });
  }
  return attachments;
}

function parseFrame(raw) {
  const text = raw.trim();
  if (!text.startsWith('{')) return { text };
  let frame;
  try { frame = JSON.parse(text); } catch { return { error: 'invalid_message' }; }
  if (frame.type !== undefined && frame.type !== 'message') return { error: 'unsupported_type' };
  if ((frame.chat_id !== undefined && typeof frame.chat_id !== 'string')
    || (frame.turn_id !== undefined && (typeof frame.turn_id !== 'string' || !ID_PATTERN.test(frame.turn_id)))) {
    return { error: 'invalid_message' };
  }
  const attachments = frame.media === undefined ? [] : parseAttachments(frame.media);
  if (!attachments) return { error: 'attachment_rejected', id: frame.turn_id };
  return { text: frame.content ?? frame.text ?? frame.message ?? '', chatId: frame.chat_id, id: frame.turn_id, attachments };
}

export const websocket = {
  id: 'websocket',

  create(config, { registerUpgrade, signal, onMessage, setStatus, allowSender = () => false }) {
    const clients = clientCredentials(config.clientTokens);
    const peers = new Map();
    let stop;

    function emit(peer, message) {
      if (peer.readyState !== WebSocket.OPEN) return;
      if (peer.bufferedAmount > MAX_PENDING_BYTES) {
        peer.terminate();
        return;
      }
      peer.send(JSON.stringify(message), (error) => { if (error) peer.terminate(); });
    }

    function opened(peer, senderId) {
      const previous = peers.get(senderId);
      const chatId = chatIdFor(senderId);
      const state = { peer, alive: true, admitting: false };
      peers.set(senderId, state);
      if (previous) previous.peer.terminate();
      peer.on('error', () => peer.terminate());
      peer.on('pong', () => { state.alive = true; });
      peer.on('close', () => {
        if (peers.get(senderId) === state) peers.delete(senderId);
      });
      emit(peer, { event: 'ready', chat_id: chatId, client_id: senderId });
      peer.on('message', async (bytes, binary) => {
        const input = binary ? { error: 'unsupported_type' } : parseFrame(bytes.toString('utf8'));
        const route = { chat_id: chatId };
        if (input.id) route.turn_id = input.id;
        if (input.error) { emit(peer, { event: 'error', ...route, detail: input.error }); return; }
        if (!allowSender(senderId) || (input.chatId !== undefined && input.chatId !== chatId)) {
          emit(peer, { event: 'error', ...route, detail: 'access_denied' });
          return;
        }
        if (typeof input.text !== 'string' || (!input.text.trim() && !input.attachments?.length)) {
          emit(peer, { event: 'error', ...route, detail: 'missing_content' });
          return;
        }
        if (Buffer.byteLength(input.text) > MAX_TEXT_BYTES) {
          emit(peer, { event: 'error', ...route, detail: 'message_rejected' });
          return;
        }
        if (state.admitting || signal.aborted) { emit(peer, { event: 'error', ...route, detail: 'busy' }); return; }
        const id = input.id ?? randomUUID();
        state.admitting = true;
        try {
          const message = { id, senderId, chatId, text: input.text.trim() };
          if (input.attachments?.length) message.attachments = input.attachments;
          await onMessage(message);
          emit(peer, { event: 'message_accepted', ...route, turn_id: id });
        } catch {
          emit(peer, { event: 'error', ...route, turn_id: id, detail: 'busy' });
        } finally {
          state.admitting = false;
        }
      });
    }

    return {
      async run() {
        if (signal.aborted) return;
        setStatus('connecting');
        if (!clients) { setStatus('auth-required', 'INVALID_CLIENT_TOKENS'); return; }
        if (typeof registerUpgrade !== 'function') { setStatus('error', 'UPGRADE_UNAVAILABLE'); return; }
        const server = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: MAX_FRAME_BYTES });
        let unregister;
        try {
          unregister = registerUpgrade({
            path: WEBSOCKET_PATH,
            handler(request, socket, head) {
              if (signal.aborted) { rejectUpgrade(socket, '503 Service Unavailable'); return; }
              if (!validTransport(request)) { rejectUpgrade(socket, '403 Forbidden'); return; }
              const senderId = authenticatedClient(request, clients, allowSender);
              if (!senderId) { rejectUpgrade(socket, '401 Unauthorized'); return; }
              server.handleUpgrade(request, socket, head, (peer) => opened(peer, senderId));
            },
          });
        } catch {
          server.close();
          setStatus('error', 'UPGRADE_UNAVAILABLE');
          return;
        }
        const heartbeat = setInterval(() => {
          for (const state of peers.values()) {
            if (!state.alive) state.peer.terminate();
            else {
              state.alive = false;
              state.peer.ping();
            }
          }
        }, 30_000);
        heartbeat.unref();
        const done = new Promise((resolve) => { stop = resolve; });
        signal.addEventListener('abort', stop, { once: true });
        try {
          if (!signal.aborted) {
            setStatus('connected');
            await done;
          }
        } finally {
          signal.removeEventListener('abort', stop);
          clearInterval(heartbeat);
          unregister();
          for (const { peer } of peers.values()) peer.terminate();
          peers.clear();
          server.close();
        }
      },

      async send(message, text) {
        if (signal.aborted) throw errorWithKind('CLIENT_UNAVAILABLE', 'retry');
        if (!clients?.has(message.senderId) || !allowSender(message.senderId) || message.chatId !== chatIdFor(message.senderId)) {
          throw errorWithKind('ACCESS_DENIED', 'rejected');
        }
        const peer = peers.get(message.senderId)?.peer;
        if (!peer || peer.readyState !== WebSocket.OPEN || peer.bufferedAmount > MAX_PENDING_BYTES) {
          throw errorWithKind('CLIENT_UNAVAILABLE', 'retry');
        }
        const data = JSON.stringify({ event: 'message', chat_id: message.chatId, turn_id: message.id, text });
        await new Promise((resolve, reject) => {
          peer.send(data, (error) => error ? reject(new Error('WEBSOCKET_SEND_FAILED')) : resolve());
        });
      },

      stop() { stop?.(); },
    };
  },
};
