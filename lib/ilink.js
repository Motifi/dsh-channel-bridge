import { Buffer } from 'node:buffer';
import { createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MEDIA_BYTES = 1024 * 1024;
const MEDIA_DOWNLOAD_URL = 'https://novac2c.cdn.weixin.qq.com/c2c/download';
const MEDIA_ORIGIN = new URL(MEDIA_DOWNLOAD_URL).origin;
const MEDIA_TYPES = [null, null, ['image', 'image'], ['voice', 'audio'], ['file', 'file'], ['video', 'video']];
const FILE_MEDIA_TYPES = new Map([
  ['txt', 'text/plain'], ['md', 'text/markdown'], ['csv', 'text/csv'], ['json', 'application/json'], ['pdf', 'application/pdf'],
  ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['png', 'image/png'], ['gif', 'image/gif'], ['webp', 'image/webp'],
]);
const BASE_INFO = Object.freeze({
  channel_version: '2.4.6',
  bot_agent: 'dsh-channel-bridge/0.1.0 (node)',
});
const ENDPOINTS = Object.freeze({
  qr: 'ilink/bot/get_bot_qrcode',
  pollQr: 'ilink/bot/get_qrcode_status',
  updates: 'ilink/bot/getupdates',
  config: 'ilink/bot/getconfig',
  send: 'ilink/bot/sendmessage',
});

/** A deliberately redacted error: never attach upstream bodies, URLs, or causes. */
export class ILinkError extends Error {
  constructor(message, {
    kind = 'protocol', endpoint = '', code = 'UNKNOWN', retryable = false,
    ret, errcode,
  } = {}) {
    super(message);
    this.name = 'ILinkError';
    this.kind = kind;
    this.endpoint = endpoint;
    this.code = code;
    this.retryable = Boolean(retryable);
    if (Number.isSafeInteger(ret)) this.ret = ret;
    if (Number.isSafeInteger(errcode)) this.errcode = errcode;
  }
}

function protocolError(endpoint, code, message, retryable = true) {
  return new ILinkError(message, { kind: 'protocol', endpoint, code, retryable });
}

function argumentError(endpoint) {
  return protocolError(endpoint, 'INVALID_ARGUMENT', 'Invalid iLink request arguments.', false);
}

function checkedBaseUrl(value, endpoint = 'baseUrl') {
  // Check the original spelling, not just URL.port/pathname: WHATWG URL parsing
  // normalizes :443, dot segments, backslashes, and some escaped hostnames away.
  if (typeof value !== 'string' || value.length > 270 || value !== value.trim()) {
    throw protocolError(endpoint, 'INVALID_BASE_URL', 'Invalid iLink HTTPS origin.', false);
  }
  const match = /^https:\/\/([a-z0-9.-]+)\/?$/i.exec(value);
  const host = match?.[1].toLowerCase();
  if (!host || host.length > 253
    || !(host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com'))
    || host.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw protocolError(endpoint, 'INVALID_BASE_URL', 'Invalid iLink HTTPS origin.', false);
  }
  return new URL(value).origin;
}

/** Accept only explicit HTTPS Weixin origins; empty/missing values are invalid. */
export function validateBaseUrl(value) {
  return checkedBaseUrl(value);
}

// Own data properties only. Apart from ignoring prototypes, this also avoids
// invoking accessors if an embedding caller passes a non-JSON object.
function ownValue(value, key) {
  if (value === null || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function responseCode(data, key, endpoint) {
  const value = ownValue(data, key);
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value === 'boolean') return Number(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const number = Number(value.trim());
    if (Number.isSafeInteger(number)) return number;
  }
  throw protocolError(endpoint, 'INVALID_RESPONSE', 'Invalid iLink response status.');
}

function checkBusinessError(data, endpoint) {
  const ret = responseCode(data, 'ret', endpoint);
  const errcode = responseCode(data, 'errcode', endpoint);
  if (ret === 0 && errcode === 0) return;
  let kind = 'business';
  let code = errcode || ret;
  let message = 'iLink rejected the request.';
  // Inspect both fields independently. Authentication wins if the server gives
  // two conflicting errors, so a stale account is never retried as a quota issue.
  if (ret === -14 || errcode === -14) {
    kind = 'auth';
    code = -14;
    message = 'iLink authentication expired; a new QR login is required.';
  } else if (ret === -2 || errcode === -2) {
    kind = 'context';
    code = -2;
    message = 'iLink context is expired or restricted.';
  }
  throw new ILinkError(message, { kind, endpoint, code, ret, errcode, retryable: false });
}

function validateTimeout(timeoutMs, endpoint) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw argumentError(endpoint);
  }
  return timeoutMs;
}

function validateToken(token, endpoint) {
  if (typeof token !== 'string' || /[\x00-\x1f\x7f]/.test(token)) {
    throw argumentError(endpoint);
  }
  return token;
}

/** One deadline covers fetch, streaming/text reads, and JSON validation. */
function requestScope(timeoutMs, parentSignal, endpoint) {
  validateTimeout(timeoutMs, endpoint);
  if (parentSignal !== undefined && parentSignal !== null && !(parentSignal instanceof AbortSignal)) {
    throw argumentError(endpoint);
  }
  const controller = new AbortController();
  const deadline = performance.now() + timeoutMs;
  let failure;
  let rejectInterrupted;
  const interrupted = new Promise((resolve, reject) => { rejectInterrupted = reject; });
  // A pre-aborted caller can fail before the first race is installed.
  interrupted.catch(() => {});
  function interrupt(code) {
    if (failure) return;
    failure = new ILinkError(
      code === 'ABORTED' ? 'iLink request was cancelled.' : 'iLink request timed out.',
      { kind: 'network', endpoint, code, retryable: code !== 'ABORTED' },
    );
    rejectInterrupted(failure);
    // Never propagate a caller's arbitrary (and potentially secret) abort reason.
    controller.abort();
  }
  const onAbort = () => interrupt('ABORTED');
  const timer = setTimeout(() => interrupt('TIMEOUT'), timeoutMs);
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener('abort', onAbort, { once: true });
  function check() {
    if (!failure && performance.now() >= deadline) interrupt('TIMEOUT');
    if (failure) throw failure;
  }
  return {
    signal: controller.signal,
    check,
    async run(action) {
      check();
      const result = await Promise.race([
        Promise.resolve().then(() => { check(); return action(); }),
        interrupted,
      ]);
      check();
      return result;
    },
    close() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onAbort);
    },
  };
}

function discardBody(body) {
  try {
    // Cancellation is best effort and must not make timeout handling wait again.
    if (body && typeof body.cancel === 'function') {
      Promise.resolve(body.cancel()).catch(() => {});
    }
  } catch { /* Do not retain or expose transport errors. */ }
}

async function readResponseText(response, scope, endpoint) {
  const tooLarge = () => protocolError(endpoint, 'RESPONSE_TOO_LARGE', 'iLink response exceeded the size limit.');
  const contentLength = response.headers?.get?.('content-length');
  if (typeof contentLength === 'string' && /^\d+$/.test(contentLength.trim())
    && Number(contentLength) > MAX_RESPONSE_BYTES) {
    discardBody(response.body);
    throw tooLarge();
  }
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const pieces = [];
    let bytes = 0;
    let complete = false;
    try {
      while (true) {
        const result = await scope.run(() => reader.read());
        if (!result || typeof result.done !== 'boolean') {
          throw protocolError(endpoint, 'INVALID_RESPONSE', 'Invalid iLink response stream.');
        }
        if (result.done) break;
        if (!(result.value instanceof Uint8Array)) {
          throw protocolError(endpoint, 'INVALID_RESPONSE', 'Invalid iLink response stream.');
        }
        bytes += result.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) throw tooLarge();
        try {
          pieces.push(decoder.decode(result.value, { stream: true }));
        } catch {
          throw protocolError(endpoint, 'INVALID_JSON', 'iLink returned invalid JSON encoding.');
        }
      }
      try {
        pieces.push(decoder.decode());
      } catch {
        throw protocolError(endpoint, 'INVALID_JSON', 'iLink returned invalid JSON encoding.');
      }
      complete = true;
      return pieces.join('');
    } finally {
      if (!complete) {
        try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Best effort. */ }
      }
      try { reader.releaseLock(); } catch { /* A cancelled custom reader may still be locked. */ }
    }
  }
  // Native Node fetch always has a stream. Keep injected minimal fetches useful,
  // but enforce the same UTF-8 byte limit rather than calling unbounded json().
  if (typeof response.text !== 'function') {
    throw protocolError(endpoint, 'INVALID_RESPONSE', 'Invalid iLink response body.');
  }
  const text = await scope.run(() => response.text());
  if (typeof text !== 'string') {
    throw protocolError(endpoint, 'INVALID_RESPONSE', 'Invalid iLink response body.');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw tooLarge();
  return text;
}

async function readMedia(response, scope, maxBytes) {
  if (Number(response.headers?.get?.('content-length')) > maxBytes || !response.body?.getReader) {
    discardBody(response.body);
    return null;
  }
  const parts = [];
  let bytes = 0;
  let complete = false;
  const reader = response.body.getReader();
  try {
    while (true) {
      const result = await scope.run(() => reader.read());
      if (result.done) {
        complete = true;
        return Buffer.concat(parts, bytes);
      }
      bytes += result.value.byteLength;
      if (bytes > maxBytes) return null;
      parts.push(result.value);
    }
  } finally {
    if (!complete) {
      try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Best effort. */ }
    }
    try { reader.releaseLock(); } catch { /* A cancelled reader may still be locked. */ }
  }
}

function nonEmptyString(value, endpoint) {
  if (typeof value !== 'string' || !value.trim()) throw argumentError(endpoint);
  return value;
}

function isChatroomId(value) {
  return typeof value === 'string' && value.toLowerCase().includes('@chatroom');
}

function personalUserId(value, endpoint) {
  nonEmptyString(value, endpoint);
  if (isChatroomId(value)) throw argumentError(endpoint);
  return value;
}

/** Stateless protocol operations. The embedding plugin owns persistence/retries. */
export class ILinkClient {
  #baseUrl;
  #token;
  #fetch;
  #timeoutMs;

  constructor({ baseUrl = DEFAULT_BASE_URL, token = '', fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.#baseUrl = checkedBaseUrl(baseUrl);
    this.#token = validateToken(token, 'account');
    if (typeof fetchImpl !== 'function') throw argumentError('fetch');
    this.#fetch = fetchImpl;
    this.#timeoutMs = validateTimeout(timeoutMs, 'timeout');
  }

  get baseUrl() { return this.#baseUrl; }

  setAccount({ baseUrl = this.#baseUrl, token = this.#token } = {}) {
    // Validate both before mutating either account field.
    const origin = checkedBaseUrl(baseUrl);
    const credential = validateToken(token, 'account');
    this.#baseUrl = origin;
    this.#token = credential;
    return this;
  }

  #headers(auth) {
    const headers = {
      'Content-Type': 'application/json',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'ascii').toString('base64'),
      AuthorizationType: 'ilink_bot_token',
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': '132102',
    };
    if (auth && this.#token) headers.Authorization = `Bearer ${this.#token}`;
    return headers;
  }

  async #request(endpoint, {
    method = 'POST', body, query, auth = true, baseUrl = this.#baseUrl,
    timeoutMs = this.#timeoutMs, signal,
  } = {}) {
    const origin = checkedBaseUrl(baseUrl, endpoint);
    if (auth && !this.#token) {
      throw new ILinkError('An iLink account token is required.', {
        kind: 'auth', endpoint, code: 'MISSING_TOKEN', retryable: false,
      });
    }
    const url = new URL(`${origin}/${endpoint}`);
    if (query) url.search = new URLSearchParams(query).toString();
    const scope = requestScope(timeoutMs, signal, endpoint);
    try {
      // Snapshot the credential with its origin before the first async boundary.
      const headers = this.#headers(auth);
      const response = await scope.run(() => this.#fetch(url.href, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: scope.signal,
      }));
      if (!response || !Number.isInteger(response.status)) {
        throw protocolError(endpoint, 'INVALID_RESPONSE', 'Invalid iLink HTTP response.');
      }
      const status = response.status;
      if ((status >= 300 && status < 400) || response.type === 'opaqueredirect' || response.redirected === true) {
        discardBody(response.body);
        throw new ILinkError('iLink HTTP redirects are not permitted.', {
          kind: 'http', endpoint, code: status || 'REDIRECT', retryable: false,
        });
      }
      if (status < 100 || status > 599) {
        discardBody(response.body);
        throw protocolError(endpoint, 'INVALID_RESPONSE', 'Invalid iLink HTTP response.');
      }
      if (status < 200 || status >= 300) {
        discardBody(response.body);
        throw new ILinkError(`iLink returned HTTP ${status}.`, {
          kind: 'http', endpoint, code: status,
          retryable: [408, 425, 429].includes(status) || (status >= 500 && status < 600),
        });
      }
      const text = await readResponseText(response, scope, endpoint);
      const data = await scope.run(() => {
        let parsed;
        try { parsed = JSON.parse(text); } catch {
          throw protocolError(endpoint, 'INVALID_JSON', 'iLink returned invalid JSON.');
        }
        if (!isRecord(parsed)) {
          throw protocolError(endpoint, 'INVALID_RESPONSE', 'iLink returned a non-object JSON response.');
        }
        return parsed;
      });
      checkBusinessError(data, endpoint);
      scope.check();
      return data;
    } catch (error) {
      if (error instanceof ILinkError) throw error;
      // Prefer cancellation/timeout over a transport's sometimes misleading error.
      scope.check();
      throw new ILinkError('iLink network request failed.', {
        kind: 'network', endpoint, code: 'NETWORK_ERROR', retryable: true,
      });
    } finally {
      scope.close();
    }
  }

  async fetchQr({ localTokens = [], force = false, signal } = {}) {
    const endpoint = ENDPOINTS.qr;
    if (!Array.isArray(localTokens) || typeof force !== 'boolean') throw argumentError(endpoint);
    const tokens = [];
    if (!force) {
      for (const value of localTokens) {
        const token = validateToken(value, endpoint).trim();
        if (token && !tokens.includes(token)) tokens.push(token);
        if (tokens.length === 10) break;
      }
    }
    const request = (localTokenList) => this.#request(endpoint, {
      query: { bot_type: '3' }, body: { local_token_list: localTokenList }, auth: false, signal,
    });
    let data;
    try {
      data = await request(tokens);
    } catch (error) {
      if (!(tokens.length && error instanceof ILinkError && error.kind === 'business'
        && (error.ret === -3 || error.errcode === -3))) throw error;
      // Exactly one fallback. No automatic retries for any other operation.
      data = await request([]);
    }
    const qrcodeId = ownValue(data, 'qrcode');
    const qrContent = ownValue(data, 'qrcode_img_content');
    if (typeof qrcodeId !== 'string' || !qrcodeId.trim()
      || (qrContent !== undefined && qrContent !== null && typeof qrContent !== 'string')) {
      throw protocolError(endpoint, 'INVALID_RESPONSE', 'iLink did not return a QR code.');
    }
    return { qrcodeId, qrContent: qrContent || qrcodeId };
  }

  async pollQr({ qrcodeId, baseUrl = this.#baseUrl, verifyCode = '', signal } = {}) {
    const endpoint = ENDPOINTS.pollQr;
    nonEmptyString(qrcodeId, endpoint);
    if (typeof verifyCode !== 'string') throw argumentError(endpoint);
    const data = await this.#request(endpoint, {
      method: 'GET', auth: false, baseUrl, signal,
      query: { qrcode: qrcodeId, ...(verifyCode ? { verify_code: verifyCode } : {}) },
    });
    const loginBase = ownValue(data, 'baseurl');
    if (loginBase !== undefined && loginBase !== null && loginBase !== '') {
      checkedBaseUrl(loginBase, endpoint);
    }
    const redirectHost = ownValue(data, 'redirect_host');
    if (redirectHost !== undefined && redirectHost !== null && redirectHost !== '') {
      if (typeof redirectHost !== 'string') {
        throw protocolError(endpoint, 'INVALID_BASE_URL', 'Invalid iLink HTTPS origin.', false);
      }
      checkedBaseUrl(/^https:\/\//i.test(redirectHost) ? redirectHost : `https://${redirectHost}`, endpoint);
    }
    return data;
  }

  async getUpdates({ cursor = '', timeoutMs = 35_000, signal } = {}) {
    if (typeof cursor !== 'string') throw argumentError(ENDPOINTS.updates);
    return this.#request(ENDPOINTS.updates, {
      body: { get_updates_buf: cursor, base_info: { ...BASE_INFO } }, timeoutMs, signal,
    });
  }

  async downloadMedia(media, { signal } = {}) {
    if (!Array.isArray(media) || !media.length) return [];
    const scope = requestScope(this.#timeoutMs, signal, 'media');
    let remaining = MAX_MEDIA_BYTES;
    try {
      const attachments = [];
      for (const item of media.slice(0, 8)) {
        let { name, kind, mediaType } = item;
        let data;
        if (remaining > 0) {
          for (const candidate of item.urls.slice(0, 2)) {
            const url = checkedMediaUrl(candidate);
            if (!url) continue;
            try {
              const response = await scope.run(() => this.#fetch(url, { method: 'GET', redirect: 'manual', signal: scope.signal }));
              if (!response.ok || response.redirected || response.type === 'opaqueredirect') {
                discardBody(response.body);
                continue;
              }
              const bytes = await readMedia(response, scope, remaining + (item.key ? 16 : 0));
              if (!bytes?.length) break;
              if (item.key) {
                const decipher = createDecipheriv('aes-128-ecb', item.key, null);
                data = Buffer.concat([decipher.update(bytes), decipher.final()]);
              } else if (kind === 'image') {
                data = bytes;
              }
              break;
            } catch { /* The second pinned-CDN candidate may still work. */ }
          }
        }
        if (data?.length && data.length <= remaining) {
          if (kind === 'image') ({ name, mediaType } = imageFormat(data));
          attachments.push({ name, kind, mediaType, data: data.toString('base64') });
          remaining -= data.length;
        } else {
          attachments.push({ name, kind, mediaType });
        }
      }
      return attachments;
    } finally {
      scope.close();
    }
  }

  async getConfig({ userId, contextToken = '', signal } = {}) {
    const endpoint = ENDPOINTS.config;
    personalUserId(userId, endpoint);
    if (typeof contextToken !== 'string') throw argumentError(endpoint);
    return this.#request(endpoint, {
      body: { ilink_user_id: userId, context_token: contextToken || null, base_info: { ...BASE_INFO } }, signal,
    });
  }

  async sendText({ userId, text, contextToken = '', clientId = `dsh-${randomUUID()}`, signal } = {}) {
    const endpoint = ENDPOINTS.send;
    personalUserId(userId, endpoint);
    nonEmptyString(clientId, endpoint);
    if (typeof text !== 'string' || typeof contextToken !== 'string') throw argumentError(endpoint);
    return this.#request(endpoint, {
      body: {
        msg: {
          from_user_id: '',
          to_user_id: userId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }],
          context_token: contextToken,
        },
        base_info: { ...BASE_INFO },
      },
      signal,
    });
  }

  async notify(action, { signal } = {}) {
    if (action !== 'start' && action !== 'stop') throw argumentError('notify');
    return this.#request(`ilink/bot/msg/notify${action}`, {
      body: { base_info: { ...BASE_INFO } }, signal,
    });
  }
}

function stripPlainMarkdown(text) {
  // Parentheses in image destinations are common; handle one nested level as
  // well as reference-style images without consuming surrounding user prose.
  return text
    .replace(/!\[(?:[^\]\\]|\\.)*\]\((?:[^()\\]|\\.|\([^()]*\))*\)/g, '')
    .replace(/!\[(?:[^\]\\]|\\.)*\]\[[^\]\n]*\]/g, '')
    .replace(/~~/g, '')
    .replace(/</g, '＜')
    .replace(/>/g, '＞');
}

function backtickRun(text, index) {
  let end = index;
  while (text[end] === '`') end += 1;
  return end - index;
}

function sanitizeInline(text) {
  const pieces = [];
  let plainStart = 0;
  let index = 0;
  while (index < text.length) {
    if (text[index] !== '`') { index += 1; continue; }
    const width = backtickRun(text, index);
    let close = index + width;
    let found = -1;
    while (close < text.length) {
      close = text.indexOf('`', close);
      if (close < 0) break;
      const closeWidth = backtickRun(text, close);
      if (closeWidth === width) { found = close; break; }
      close += closeWidth;
    }
    if (found < 0) { index += width; continue; }
    pieces.push(stripPlainMarkdown(text.slice(plainStart, index)));
    pieces.push(text.slice(index, found + width));
    index = found + width;
    plainStart = index;
  }
  pieces.push(stripPlainMarkdown(text.slice(plainStart)));
  return pieces.join('');
}

function openingFence(line) {
  const match = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line.replace(/\r$/, ''));
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return {
    marker: match[1],
    character: match[1][0],
    width: match[1].length,
    opening: `${match[1]}${match[2]}`,
  };
}

function closesFence(line, fence) {
  const candidate = line.replace(/\r$/, '').trim();
  return candidate.length >= fence.width
    && [...candidate].every((character) => character === fence.character);
}

function sanitizeMarkdown(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const pieces = [];
  let normal = '';
  let fence = null;
  for (const fullLine of lines) {
    const line = fullLine.endsWith('\n') ? fullLine.slice(0, -1) : fullLine;
    if (fence) {
      pieces.push(fullLine);
      if (closesFence(line, fence)) fence = null;
    } else {
      const opened = openingFence(line);
      if (opened) {
        pieces.push(sanitizeInline(normal), fullLine);
        normal = '';
        fence = opened;
      } else normal += fullLine;
    }
  }
  pieces.push(sanitizeInline(normal));
  return pieces.join('').trim();
}

function fenceBoundaries(points) {
  const states = new Array(points.length + 1).fill(null);
  const safe = new Uint8Array(points.length + 1).fill(1);
  const fenceLine = new Uint8Array(points.length);
  let fence = null;
  let start = 0;
  while (start < points.length) {
    let end = start;
    while (end < points.length && points[end] !== '\n') end += 1;
    if (end < points.length) end += 1;
    const line = points.slice(start, points[end - 1] === '\n' ? end - 1 : end).join('');
    let nextFence = fence;
    let markerLine = false;
    if (fence) {
      if (closesFence(line, fence)) { nextFence = null; markerLine = true; }
    } else {
      const opened = openingFence(line);
      if (opened) { nextFence = opened; markerLine = true; }
    }
    states.fill(fence, start, end);
    if (markerLine) {
      safe.fill(0, start + 1, end);
      fenceLine.fill(1, start, end);
    }
    states[end] = nextFence;
    fence = nextFence;
    start = end;
  }
  return { states, safe, fenceLine };
}

function protectInlineBoundaries(points, states, safe, fenceLine, maxLen) {
  let index = 0;
  while (index < points.length) {
    if (points[index] !== '`' || fenceLine[index] || states[index]) { index += 1; continue; }
    let width = 1;
    while (points[index + width] === '`') width += 1;
    let close = index + width;
    let found = -1;
    while (close < points.length && !fenceLine[close] && !states[close]) {
      if (points[close] !== '`') { close += 1; continue; }
      let closeWidth = 1;
      while (points[close + closeWidth] === '`') closeWidth += 1;
      if (closeWidth === width) { found = close; break; }
      close += closeWidth;
    }
    if (found >= 0) {
      const end = found + width;
      if (end - index <= maxLen) safe.fill(0, index + 1, end);
      index = end;
    } else index += width;
  }
}

function boundaryPreference(points, position) {
  if (points[position - 1] === '\n') return points[position - 2] === '\n' ? 3 : 2;
  return /[\s。！？；.!?;]/u.test(points[position - 1] || '') ? 1 : 0;
}

/** Sanitize unsupported Markdown, then split by Unicode code points, not UTF-16. */
export function splitText(text, maxLen = 1800) {
  if (!Number.isSafeInteger(maxLen) || maxLen <= 0) {
    throw new RangeError('maxLen must be a positive safe integer.');
  }
  if (text === undefined || text === null || text === '') return [];
  if (typeof text !== 'string') throw new TypeError('text must be a string.');
  const sanitized = sanitizeMarkdown(text);
  if (!sanitized) return [];
  const points = Array.from(sanitized);
  if (points.length <= maxLen) return [sanitized];
  const { states, safe, fenceLine } = fenceBoundaries(points);
  protectInlineBoundaries(points, states, safe, fenceLine, maxLen);
  const chunks = [];
  let start = 0;
  while (start < points.length) {
    const active = states[start];
    let prefix = active ? `${active.opening}\n` : '';
    let prefixLength = Array.from(prefix).length;
    if (active && prefixLength + active.width + 2 > maxLen) {
      prefix = `${active.marker}\n`;
      prefixLength = active.width + 1;
    }
    let furthest = -1;
    let preferred = -1;
    let preference = -1;
    const limit = Math.min(points.length, start + maxLen - prefixLength);
    for (let end = start + 1; end <= limit; end += 1) {
      if (!safe[end]) continue;
      const next = states[end];
      const suffixLength = next ? next.width + (points[end - 1] === '\n' ? 0 : 1) : 0;
      if (prefixLength + end - start + suffixLength > maxLen) continue;
      furthest = end;
    }
    if (furthest > start) {
      // Prefer readable breaks without repeatedly emitting tiny leading pieces.
      const minimum = start + Math.max(1, Math.floor((furthest - start) / 3));
      for (let end = minimum; end <= furthest; end += 1) {
        if (!safe[end]) continue;
        const next = states[end];
        const suffixLength = next ? next.width + (points[end - 1] === '\n' ? 0 : 1) : 0;
        if (prefixLength + end - start + suffixLength > maxLen) continue;
        const rank = boundaryPreference(points, end);
        if (rank >= preference) { preferred = end; preference = rank; }
      }
      const end = furthest === points.length ? furthest : (preferred > start ? preferred : furthest);
      const next = states[end];
      const suffix = next ? `${points[end - 1] === '\n' ? '' : '\n'}${next.marker}` : '';
      chunks.push(prefix + points.slice(start, end).join('') + suffix);
      start = end;
    } else {
      // A tiny maximum or an overlong fence header/delimiter cannot be balanced.
      // Still make progress and respect the hard code-point limit in every case.
      const end = Math.min(points.length, start + maxLen);
      chunks.push(points.slice(start, end).join(''));
      start = end;
    }
  }
  return chunks;
}

function textItemValue(item) {
  return ownValue(ownValue(item, 'text_item'), 'text');
}

function isTextItem(item) {
  const type = ownValue(item, 'type');
  return type === 1 || type === '1';
}

function textWithReference(item, text) {
  const reference = ownValue(item, 'ref_msg');
  const quotedItem = ownValue(reference, 'message_item');
  // Do not turn image/file/voice titles or media placeholders into model input.
  if (!isTextItem(quotedItem)) return text;
  const quotedText = textItemValue(quotedItem);
  if (typeof quotedText !== 'string' || !quotedText.trim()) return text;
  const title = ownValue(reference, 'title');
  const quote = typeof title === 'string' && title.trim()
    ? `${title} | ${quotedText}` : quotedText;
  return `[引用: ${quote}]\n${text}`;
}

function safeMessageId(raw) {
  for (const key of ['message_id', 'msgid', 'msg_id', 'seq']) {
    const value = ownValue(raw, key);
    if (typeof value === 'string' && value.trim()) return value;
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  }
  return null;
}

function messageTimestamp(raw) {
  const value = ownValue(raw, 'create_time_ms');
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
  }
  return null;
}

function personalEnvelope(raw) {
  if (!isRecord(raw)) return null;
  const messageType = ownValue(raw, 'message_type');
  if (messageType === 2 || messageType === '2') return null;
  const userId = ownValue(raw, 'from_user_id');
  const recipient = ownValue(raw, 'to_user_id');
  if (typeof userId !== 'string' || !userId.trim() || isChatroomId(userId) || isChatroomId(recipient)) return null;
  const items = ownValue(raw, 'item_list');
  if (!Array.isArray(items)) return null;
  return { userId, recipient, items };
}

function messageEnvelope(raw, { userId, recipient }, text, identity = text) {
  const createdAt = messageTimestamp(raw);
  const context = ownValue(raw, 'context_token');
  const contextToken = typeof context === 'string' ? context : '';
  const id = safeMessageId(raw) || `fallback-${createHash('sha256')
    .update(JSON.stringify([userId, typeof recipient === 'string' ? recipient : '', createdAt, identity]))
    .digest('hex')}`;
  return { id, userId, text, contextToken, createdAt };
}

/** Extract only user-authored personal-chat type-1 text; never media captions. */
export function extractTextMessage(raw) {
  const envelope = personalEnvelope(raw);
  if (!envelope) return null;
  const { items } = envelope;
  const parts = [];
  // Index descriptors also ignore inherited items in sparse/non-JSON arrays.
  const length = ownValue(items, 'length');
  for (let index = 0; index < length; index += 1) {
    const item = ownValue(items, String(index));
    if (!isTextItem(item)) continue;
    const text = textItemValue(item);
    if (typeof text !== 'string' || !text.trim()) continue;
    parts.push(textWithReference(item, text));
  }
  if (!parts.length) return null;
  return messageEnvelope(raw, envelope, parts.join('\n'));
}

function checkedMediaUrl(value) {
  if (typeof value !== 'string' || value.length > 12_288 || !value.startsWith('https://')) return null;
  try {
    const url = new URL(value);
    if (url.origin === MEDIA_ORIGIN && !url.username && !url.password && !url.hash && url.pathname.startsWith('/c2c/')) {
      return url.href;
    }
  } catch { /* Only the pinned CDN origin can resolve media. */ }
  return null;
}

function mediaKey(item, media) {
  const hex = ownValue(item, 'aeskey');
  if (hex) return typeof hex === 'string' && /^[a-f\d]{32}$/i.test(hex) ? Buffer.from(hex, 'hex') : null;
  const encoded = ownValue(media, 'aes_key');
  if (encoded === undefined || encoded === '') return undefined;
  if (typeof encoded !== 'string' || encoded.length > 44 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length === 16) return decoded;
  const decodedHex = decoded.toString('latin1');
  return /^[a-f\d]{32}$/i.test(decodedHex) ? Buffer.from(decodedHex, 'hex') : null;
}

function imageFormat(bytes) {
  const hex = bytes.subarray(0, 8).toString('hex');
  if (hex.startsWith('ffd8ff')) return { name: 'image.jpg', mediaType: 'image/jpeg' };
  if (hex === '89504e470d0a1a0a') return { name: 'image.png', mediaType: 'image/png' };
  if (hex.startsWith('474946383761') || hex.startsWith('474946383961')) return { name: 'image.gif', mediaType: 'image/gif' };
  if (hex.startsWith('52494646') && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { name: 'image.webp', mediaType: 'image/webp' };
  }
  return { name: 'image.bin', mediaType: 'application/octet-stream' };
}

function mediaDescriptor(item) {
  const type = ownValue(item, 'type');
  if (typeof type !== 'number' && !/^[2-5]$/.test(typeof type === 'string' ? type : '')) return null;
  const info = MEDIA_TYPES[type];
  if (!info) return null;
  const [field, kind] = info;
  const typed = ownValue(item, `${field}_item`);
  if (!isRecord(typed)) return null;
  const voice = kind === 'audio' ? ownValue(typed, 'text') : undefined;
  if (typeof voice === 'string' && voice.trim()) return { text: `[voice] ${voice}` };

  const media = ownValue(typed, 'media');
  const key = mediaKey(typed, media);
  const urls = [];
  if (key || (key === undefined && kind === 'image')) {
    const direct = checkedMediaUrl(ownValue(media, 'full_url'));
    if (direct) urls.push(direct);
    const locator = ownValue(media, 'encrypt_query_param');
    if (typeof locator === 'string' && locator && locator.length <= 8192) {
      const url = new URL(MEDIA_DOWNLOAD_URL);
      url.searchParams.set('encrypted_query_param', locator);
      if (!urls.includes(url.href)) urls.push(url.href);
    }
  }
  const rawName = ownValue(typed, 'file_name');
  const proposedName = typeof rawName === 'string'
    ? rawName.split(/[\\/]/).at(-1).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, 160) : '';
  const name = proposedName && proposedName !== '.' && proposedName !== '..'
    ? proposedName : { image: 'image.bin', audio: 'voice.silk', video: 'video.mp4', file: 'file' }[kind];
  const extension = name.toLowerCase().split('.').at(-1);
  const mediaType = { video: 'video/mp4', audio: 'audio/silk' }[kind]
    || FILE_MEDIA_TYPES.get(extension)
    || 'application/octet-stream';
  return { name, kind, mediaType, urls, key };
}

/** Extract supported top-level or quoted personal media without touching legacy text parsing. */
export function extractMediaMessage(raw) {
  const envelope = personalEnvelope(raw);
  if (!envelope) return null;
  const { items } = envelope;
  const media = [];
  const transcripts = [];
  let quoted;
  for (let index = 0; index < items.length; index += 1) {
    const item = ownValue(items, String(index));
    if (!quoted && isTextItem(item)) {
      quoted = mediaDescriptor(ownValue(ownValue(item, 'ref_msg'), 'message_item'));
    }
    const descriptor = mediaDescriptor(item);
    if (descriptor?.text && transcripts.length < 8) transcripts.push(descriptor.text);
    else if (descriptor?.urls && media.length < 8) media.push(descriptor);
  }
  if (!media.some(item => item.urls.length) && quoted?.urls?.length) media.unshift(quoted);
  else if (!media.length && quoted?.text) transcripts.push(quoted.text);
  if (!media.length && !transcripts.length) return null;
  const old = extractTextMessage(raw);
  const text = [old?.text, ...transcripts].filter(Boolean).join('\n');
  return {
    ...(old ?? messageEnvelope(raw, envelope, text, [text, media.map(({ kind, urls }) => [kind, urls])])),
    text, media: media.slice(0, 8),
  };
}
