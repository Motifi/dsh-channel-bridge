import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('../transport/nanobot_worker.py', import.meta.url));
const MAX_FRAME = 8 * 1024 * 1024;
const ENVIRONMENT_KEYS = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR',
  'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'ALL_PROXY',
]);

function workerEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => ENVIRONMENT_KEYS.has(key.toUpperCase())));
}

function transportError(kind, code) {
  return Object.assign(new Error(code), { kind, code });
}

function statusCode(code) {
  if (typeof code !== 'string' || !/^[a-z0-9_-]{1,60}$/i.test(code)) return undefined;
  const normalized = code.toUpperCase().replaceAll('-', '_');
  return {
    AUTH_STATE_TOO_LARGE: 'STORAGE_ERROR',
    WEBHOOK_SECRET_REQUIRED: 'CONFIG_INVALID',
    UPSTREAM_MISSING: 'INSTALL_REQUIRED',
    UPSTREAM_VERSION: 'INSTALL_REQUIRED',
    INVALID_CONFIG: 'CONFIG_INVALID',
    INVALID_CHANNEL_CONFIGURATION: 'CONFIG_INVALID',
    PLATFORM_AUTH_REJECTED: 'AUTH_REQUIRED',
    CHANNEL_DEPENDENCIES_MISSING: 'DEPENDENCY_MISSING',
    CHANNEL_START_FAILED: 'NETWORK_ERROR',
    START_FAILED: 'NETWORK_ERROR',
  }[normalized] ?? normalized;
}

async function* frames(stream) {
  let pending = '';
  // StringDecoder (via setEncoding) protects Unicode split between chunks.
  stream.setEncoding('utf8');
  for await (const chunk of stream) {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      if (end > MAX_FRAME) throw transportError(undefined, 'WORKER_PROTOCOL');
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      let value;
      try { value = JSON.parse(line); }
      catch { throw transportError(undefined, 'WORKER_PROTOCOL'); }
      if (value && typeof value === 'object' && !Array.isArray(value)) yield value;
    }
    if (pending.length > MAX_FRAME) throw transportError(undefined, 'WORKER_PROTOCOL');
  }
  if (pending) throw transportError(undefined, 'WORKER_PROTOCOL');
}

export function createNanobotTransport(id, config, callbacks, options = {}) {
  if (id === 'feishu' && config.instances !== undefined) return createFeishuTransport(config, callbacks, options);
  const { signal, setStatus, setDiagnostic, onMessage, onAuthState, onLogin, allowedSenders, authState, login } = callbacks;
  const { python = 'python3', spawn: spawnWorker = spawn, instanceId } = options;
  const pending = new Map();
  let child;
  let closed;
  let closing;
  let stopping = false;
  const write = value => new Promise((resolve, reject) => {
    if (!child?.stdin.writable || child.stdin.destroyed) {
      reject(transportError('retry', 'WORKER_EXIT'));
      return;
    }
    const frame = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(frame) > MAX_FRAME) {
      reject(transportError('rejected', 'INVALID_REPLY'));
      return;
    }
    child.stdin.write(frame, error => {
      // EPIPE can happen after the peer has read and acted on the frame.
      if (error) reject(transportError(undefined, 'WORKER_EXIT'));
      else resolve();
    });
  });

  const stop = () => {
    if (closing) return closing;
    stopping = true;
    if (!child) return Promise.resolve();
    closing = (async () => {
      const graceful = setTimeout(() => child.kill('SIGTERM'), 14000);
      const force = setTimeout(() => child.kill('SIGKILL'), 17000);
      graceful.unref();
      force.unref();
      try {
        void write({ op: 'stop' }).catch(() => {});
        await closed;
      } finally {
        clearTimeout(graceful);
        clearTimeout(force);
      }
    })();
    return closing;
  };

  async function deliver(op, { messageId, route, text, attachments, metadata, type, message }) {
    if (stopping || !child?.stdin.writable || child.stdin.destroyed) throw transportError('retry', 'WORKER_EXIT');
    const requestId = randomUUID();
    let timer;
    const result = new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject });
      timer = setTimeout(() => reject(transportError(undefined, 'DELIVERY_UNCERTAIN')), 55000);
      timer.unref();
    });
    try {
      const submitted = write({ op, requestId, messageId, route, text, attachments, metadata, type, originId: message?.id });
      await Promise.all([submitted, result]);
    } finally {
      clearTimeout(timer);
      pending.delete(requestId);
    }
  }

  return {
    async run() {
      if (signal.aborted || stopping) return;
      const directory = await mkdtemp(join(tmpdir(), 'dsh-channel-'));
      try {
        if (signal.aborted || stopping) return;
        await runWorker(directory);
      } finally {
        await rm(directory, { force: true, recursive: true, maxRetries: 3 });
      }
    },
    send(message, text) {
      return deliver('send', typeof text === 'string' ? { messageId: message.id, route: message.route, text } : message);
    },
    sendPayload(payload) {
      return deliver('send', payload);
    },
    sendUpdate(update) {
      return deliver(update.type === 'final' ? 'send' : 'update', update);
    },
    stop,
  };

  async function runWorker(directory) {
    try {
      child = spawnWorker(python, ['-I', '-u', WORKER, '--channel', id, '--runtime-dir', directory], {
        stdio: ['pipe', 'pipe', 'ignore'], shell: false, windowsHide: true, env: workerEnv(),
      });
    } catch {
      throw transportError(undefined, 'INSTALL_REQUIRED');
    }
    let launchError;
    let terminalStatus = false;
    child.stdin.on('error', () => {});
    child.on('error', error => { launchError = error; });
    closed = new Promise(resolve => child.once('close', resolve));
    signal.addEventListener('abort', stop, { once: true });
    try {
      const start = write({ op: 'start', config, allowedSenders, authState, login, instanceId });
      // Consume startup failures even when the executable cannot be spawned.
      void start.catch(() => {});
      for await (const frame of frames(child.stdout)) {
        if (frame.type === 'status') {
          if (!stopping) {
            terminalStatus = ['error', 'auth-required'].includes(frame.status);
            setStatus(frame.status, statusCode(frame.code));
          }
        } else if (frame.type === 'login') {
          if (!stopping) onLogin?.(frame);
        } else if (frame.type === 'diagnostic') {
          if (!stopping) setDiagnostic?.(statusCode(frame.code));
        } else if (frame.type === 'auth-state') {
          await onAuthState?.(frame.authState);
        } else if (frame.type === 'message' && !stopping) {
          let accepted = false;
          try { await onMessage(frame.message); accepted = true; }
          catch { /* Report backpressure to the transport after the durable write fails. */ }
          if (typeof frame.message?.id === 'string') await write({ op: 'ack', messageId: frame.message.id, ok: accepted });
        } else if (frame.type === 'sent') {
          const request = pending.get(frame.requestId);
          if (!request) continue;
          if (frame.ok === true) request.resolve();
          else {
            const code = statusCode(frame.code) ?? 'DELIVERY_UNCERTAIN';
            const kind = ['CHANNEL_NOT_READY', 'NETWORK_ERROR', 'SEND_BUSY'].includes(code) ? 'retry'
              : ['REPLY_ROUTE_UNAVAILABLE', 'REPLY_ROUTE_INVALID', 'INVALID_REPLY', 'DELIVERY_REJECTED'].includes(code) ? 'rejected'
              : ['AUTH_REQUIRED', 'AUTH_FAILED'].includes(code) ? 'auth' : undefined;
            request.reject(transportError(kind, code));
          }
        }
      }
      const exit = await closed;
      if (launchError?.code === 'ENOENT') throw transportError(undefined, 'INSTALL_REQUIRED');
      if (!stopping && exit !== 0 && !terminalStatus) throw transportError(undefined, 'WORKER_EXIT');
      await start.catch(error => { if (!stopping) throw error; });
    } finally {
      signal.removeEventListener('abort', stop);
      for (const request of pending.values()) request.reject(transportError(undefined, 'WORKER_EXIT'));
      await stop();
    }
  }
}

function createFeishuTransport({ instances, ...defaults }, callbacks, options) {
  const slots = new Map();
  const identities = new Set();
  let status;
  let code;
  function publishStatus() {
    const states = [...slots.values()].map(slot => slot.status);
    const next = states.find(state => state.status === 'auth-required' || state.status === 'error')
      ?? { status: states.every(state => state.status === 'connected') ? 'connected' : 'connecting' };
    if (status === next.status && code === next.code) return;
    ({ status, code } = next);
    callbacks.setStatus(status, code);
  }

  if (!Array.isArray(instances) || instances.length === 0 || instances.length > 8) {
    throw transportError('rejected', 'CONFIG_INVALID');
  }
  const seen = new Set();
  instances.forEach((instance, index) => {
    if (!instance || typeof instance !== 'object' || Array.isArray(instance)) {
      throw transportError('rejected', 'CONFIG_INVALID');
    }
    const { id, instanceId, instance_id, enabled = true, allowFrom, allow_from, ...settings } = instance;
    const key = id ?? instanceId ?? instance_id ?? (index ? `assistant-${index + 1}` : 'default');
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(key) || seen.has(key) || typeof enabled !== 'boolean') {
      throw transportError('rejected', 'CONFIG_INVALID');
    }
    seen.add(key);
    if (!enabled) return;
    const config = { ...defaults, ...settings };
    const appId = config.appId ?? config.app_id;
    const appSecret = config.appSecret ?? config.app_secret;
    const identity = `${config.domain ?? 'feishu'}:${appId}`;
    if (typeof appId !== 'string' || !appId.trim() || typeof appSecret !== 'string' || !appSecret.trim()
      || identities.has(identity)) throw transportError('rejected', 'CONFIG_INVALID');
    identities.add(identity);
    const scope = allowFrom ?? allow_from;
    if (scope !== undefined && (!Array.isArray(scope) || scope.some(sender => typeof sender !== 'string'))) {
      throw transportError('rejected', 'CONFIG_INVALID');
    }
    const allowedSenders = scope === undefined ? callbacks.allowedSenders
      : callbacks.allowedSenders.filter(sender => scope.includes(sender));
    if (!allowedSenders.length) throw transportError('rejected', 'CONFIG_INVALID');
    const slot = { status: { status: 'connecting' }, transport: null };
    slot.transport = createNanobotTransport('feishu', { ...config, instanceId: key }, {
      ...callbacks, allowedSenders,
      setStatus(status, code) {
        slot.status = { status, code };
        publishStatus();
      },
    }, { ...options, instanceId: key });
    slots.set(key, slot);
  });
  if (!slots.size) throw transportError('rejected', 'CONFIG_INVALID');
  const transports = [...slots.values()].map(slot => slot.transport);
  const stop = async () => { await Promise.all(transports.map(transport => transport.stop())); };
  const select = payload => {
    const slot = slots.get(payload?.route?.instanceId);
    if (!slot) throw transportError('rejected', 'REPLY_ROUTE_INVALID');
    return slot.transport;
  };
  return {
    async run() {
      publishStatus();
      const tasks = transports.map(transport => transport.run());
      try {
        await Promise.race(tasks);
      } finally {
        await stop();
        await Promise.allSettled(tasks);
      }
    },
    async send(message, text) { return select(message).send(message, text); },
    async sendPayload(payload) { return select(payload).sendPayload(payload); },
    async sendUpdate(update) { return select(update).sendUpdate(update); },
    stop,
  };
}
