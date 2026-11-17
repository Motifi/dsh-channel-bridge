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
  const { signal, setStatus, setDiagnostic, onMessage, onAuthState, onLogin, allowedSenders, authState, login } = callbacks;
  const { python = 'python3', spawn: spawnWorker = spawn } = options;
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
    child.stdin.write(JSON.stringify(value) + '\n', error => {
      // EPIPE can happen after the peer has read and acted on the frame.
      if (error) reject(transportError(undefined, 'WORKER_EXIT'));
      else resolve();
    });
  });

  const stop = () => {
    if (closing) return closing;
    if (!child) return Promise.resolve();
    stopping = true;
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

  return {
    async run() {
      if (signal.aborted) return;
      const directory = await mkdtemp(join(tmpdir(), 'dsh-channel-'));
      try {
        if (signal.aborted) return;
        await runWorker(directory);
      } finally {
        await rm(directory, { force: true, recursive: true, maxRetries: 3 });
      }
    },
    async send(message, text) {
      if (stopping || !child?.stdin.writable || child.stdin.destroyed) throw transportError('retry', 'WORKER_EXIT');
      const requestId = randomUUID();
      let timer;
      const result = new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        timer = setTimeout(() => reject(transportError(undefined, 'DELIVERY_UNCERTAIN')), 55000);
        timer.unref();
      });
      try {
        const submitted = write({ op: 'send', requestId, messageId: message.id, route: message.route, text });
        await Promise.all([submitted, result]);
      } finally {
        clearTimeout(timer);
        pending.delete(requestId);
      }
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
      const start = write({ op: 'start', config, allowedSenders, authState, login });
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
            const kind = ['CHANNEL_NOT_READY', 'NETWORK_ERROR'].includes(code) ? 'retry'
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
