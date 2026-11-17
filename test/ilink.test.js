import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { getEventListeners } from 'node:events';
import { inspect } from 'node:util';
import test from 'node:test';
import {
  ILinkClient, ILinkError, validateBaseUrl, splitText, extractTextMessage,
} from '../lib/ilink.js';

const ORIGIN = 'https://ilinkai.weixin.qq.com';
const TOKEN = 'TEST_PRIVATE_BOT_TOKEN_never_log';
const CONTEXT = 'TEST_PRIVATE_CONTEXT_never_log';
const BASE_INFO = { channel_version: '2.4.6', bot_agent: 'dsh-channel-bridge/0.1.0 (node)' };
const LIMIT = 1024 * 1024;
const json = (data, init) => new Response(JSON.stringify(data), init);
const never = () => new Promise(() => {});

function fakeClient(responses = [{ ret: 0 }], options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url: new URL(url), init, headers: new Headers(init.headers) };
    if (init.body !== undefined) call.body = JSON.parse(init.body);
    calls.push(call);
    const next = responses.shift();
    assert.notEqual(next, undefined, 'unexpected additional request');
    if (typeof next === 'function') return next(call);
    if (next instanceof Error) throw next;
    return next instanceof Response ? next : json(next);
  };
  return { client: new ILinkClient({ token: TOKEN, fetchImpl, ...options }), calls };
}

function expectError(expected, secret = TOKEN) {
  return (error) => {
    assert.ok(error instanceof ILinkError, 'errors must use the exported error class');
    for (const [key, value] of Object.entries(expected)) assert.equal(error[key], value, key);
    assert.equal(typeof error.endpoint, 'string');
    assert.ok(Object.hasOwn(error, 'code'));
    assert.equal(Object.hasOwn(error, 'cause'), false);
    for (const rendering of [String(error), error.stack, JSON.stringify(error), inspect(error)]) {
      assert.equal(rendering.includes(secret), false, 'error leaked a secret');
    }
    return true;
  };
}

function inbound(overrides = {}) {
  return {
    message_id: 'message-123',
    message_type: 1,
    from_user_id: 'personal-user',
    to_user_id: 'bot-id',
    context_token: CONTEXT,
    create_time_ms: 1_799_999_999_123,
    item_list: [{ type: 1, text_item: { text: '你好' } }],
    ...overrides,
  };
}

function assertChunkLimit(chunks, maximum) {
  for (const chunk of chunks) {
    assert.ok(chunk.length > 0);
    assert.ok(Array.from(chunk).length <= maximum, `chunk exceeds ${maximum}: ${inspect(chunk)}`);
    assert.equal(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(chunk), false, 'split a surrogate pair');
  }
}

test('exports the intended ESM surface and redacted error metadata', () => {
  assert.equal(typeof ILinkClient, 'function');
  const error = new ILinkError('safe', { kind: 'business', endpoint: 'fixed/path', code: -3 });
  assert.equal(error.name, 'ILinkError');
  assert.equal(error.retryable, false);
  assert.equal(error.code, -3);
  assert.equal(error.endpoint, 'fixed/path');
});

test('headers and authentication match protocol 2.4.6 on every endpoint', async () => {
  const { client, calls } = fakeClient([
    { qrcode: 'qr-id', qrcode_img_content: 'weixin://qr/content' },
    { status: 'wait' }, { ret: 0, get_updates_buf: 'next' },
    { ret: 0 }, { ret: 0 }, { ret: 0 }, { ret: 0 },
  ]);
  await client.fetchQr();
  await client.pollQr({ qrcodeId: 'qr-id' });
  await client.getUpdates();
  await client.getConfig({ userId: 'u', contextToken: CONTEXT });
  await client.sendText({ userId: 'u', text: 'hello', contextToken: CONTEXT, clientId: 'fixed-id' });
  await client.notify('start');
  await client.notify('stop');
  assert.equal(calls.length, 7);
  for (let index = 0; index < calls.length; index += 1) {
    const { init, headers, url } = calls[index];
    assert.equal(url.origin, ORIGIN);
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.get('authorizationtype'), 'ilink_bot_token');
    assert.equal(headers.get('ilink-app-id'), 'bot');
    assert.equal(headers.get('ilink-app-clientversion'), '132102');
    assert.equal(headers.get('authorization'), index < 2 ? null : `Bearer ${TOKEN}`);
    const uin = headers.get('x-wechat-uin');
    const decimal = Buffer.from(uin, 'base64').toString('ascii');
    assert.match(decimal, /^(?:0|[1-9]\d*)$/);
    assert.ok(Number(decimal) >= 0 && Number(decimal) <= 0xffff_ffff);
    assert.equal(Buffer.from(decimal, 'ascii').toString('base64'), uin);
  }
  assert.equal(calls[0].url.pathname, '/ilink/bot/get_bot_qrcode');
  assert.equal(calls[0].url.search, '?bot_type=3');
  assert.deepEqual(calls[0].body, { local_token_list: [] });
  assert.equal(calls[1].init.method, 'GET');
  assert.equal(calls[1].init.body, undefined);
  for (const call of calls.slice(2)) {
    assert.equal(call.init.method, 'POST');
    assert.deepEqual(call.body.base_info, BASE_INFO);
  }
  assert.equal(calls[5].url.pathname, '/ilink/bot/msg/notifystart');
  assert.equal(calls[6].url.pathname, '/ilink/bot/msg/notifystop');
  assert.deepEqual(calls[5].body, { base_info: BASE_INFO });
});

test('getUpdates preserves opaque cursors and returns the full result', async () => {
  const result = { ret: 0, get_updates_buf: 'next/+=😀', msgs: [], longpolling_timeout_ms: 25_000 };
  const { client, calls } = fakeClient([result, { ret: 0 }]);
  assert.deepEqual(await client.getUpdates({ cursor: 'previous/+=中文' }), result);
  await client.getUpdates();
  assert.deepEqual(calls[0].body, { get_updates_buf: 'previous/+=中文', base_info: BASE_INFO });
  assert.equal(calls[1].body.get_updates_buf, '');
  assert.equal(calls[0].url.search, '');
});

test('getConfig and sendText emit exact user/context/text/client ID payloads', async () => {
  const { client, calls } = fakeClient([{ ret: 0 }, { ret: 0 }, { ret: 0 }, { ret: 0 }]);
  await client.getConfig({ userId: 'u', contextToken: CONTEXT });
  await client.getConfig({ userId: 'u' });
  await client.sendText({ userId: 'u', text: 'hello\n😀 <not rewritten here>', contextToken: CONTEXT, clientId: 'stable-retry-id' });
  await client.sendText({ userId: 'u', text: 'generated id' });
  assert.deepEqual(calls[0].body, { ilink_user_id: 'u', context_token: CONTEXT, base_info: BASE_INFO });
  assert.equal(calls[1].body.context_token, null);
  assert.deepEqual(calls[2].body, {
    base_info: BASE_INFO,
    msg: {
      from_user_id: '', to_user_id: 'u', client_id: 'stable-retry-id',
      message_type: 2, message_state: 2,
      item_list: [{ type: 1, text_item: { text: 'hello\n😀 <not rewritten here>' } }],
      context_token: CONTEXT,
    },
  });
  assert.match(calls[3].body.msg.client_id, /^dsh-[0-9a-f-]{36}$/);
  assert.equal(calls[3].body.msg.context_token, '');
});

test('setAccount changes only in-memory credentials and validates atomically', async () => {
  const { client, calls } = fakeClient([{ ret: 0 }, { ret: 0 }]);
  assert.equal(JSON.stringify(client), '{}');
  assert.equal(client.token, undefined);
  assert.equal(client.baseUrl, ORIGIN);
  assert.equal(client.setAccount({ baseUrl: 'https://sh.weixin.qq.com/', token: 'next-token' }), client);
  await client.getUpdates();
  assert.equal(calls[0].url.origin, 'https://sh.weixin.qq.com');
  assert.equal(calls[0].headers.get('authorization'), 'Bearer next-token');
  assert.throws(() => client.setAccount({ baseUrl: 'https://evil.example', token: TOKEN }), expectError({ code: 'INVALID_BASE_URL' }));
  assert.throws(() => client.setAccount({ baseUrl: ORIGIN, token: 'bad\r\ntoken' }), expectError({ code: 'INVALID_ARGUMENT' }));
  await client.getUpdates();
  assert.equal(calls[1].url.origin, 'https://sh.weixin.qq.com');
  assert.equal(calls[1].headers.get('authorization'), 'Bearer next-token');
});

test('an in-flight request snapshots the token with its original account origin', async () => {
  const { client, calls } = fakeClient([{ ret: 0 }, { ret: 0 }]);
  const previous = client.getUpdates();
  client.setAccount({ baseUrl: 'https://sh.weixin.qq.com', token: 'replacement' });
  await previous;
  await client.getUpdates();
  assert.equal(calls[0].url.origin, ORIGIN);
  assert.equal(calls[0].headers.get('authorization'), `Bearer ${TOKEN}`);
  assert.equal(calls[1].url.origin, 'https://sh.weixin.qq.com');
  assert.equal(calls[1].headers.get('authorization'), 'Bearer replacement');
});

test('pollQr encodes query values, permits safe regional origins, and returns raw fields', async () => {
  const status = {
    status: 'confirmed', bot_token: TOKEN, ilink_user_id: 'owner', ilink_bot_id: 'bot',
    baseurl: 'https://SH.weixin.qq.com/', extra: { leave: 'unchanged' },
  };
  const { client, calls } = fakeClient([status, { status: 'wait' }, { redirect_host: 'sh.weixin.qq.com' }]);
  assert.deepEqual(await client.pollQr({
    qrcodeId: 'id with &?中文', baseUrl: 'https://hk.weixin.qq.com/', verifyCode: '1 2&3',
  }), status);
  assert.equal(calls[0].url.origin, 'https://hk.weixin.qq.com');
  assert.equal(calls[0].url.searchParams.get('qrcode'), 'id with &?中文');
  assert.equal(calls[0].url.searchParams.get('verify_code'), '1 2&3');
  await client.pollQr({ qrcodeId: 'id' });
  assert.equal(calls[1].url.searchParams.has('verify_code'), false);
  assert.deepEqual(await client.pollQr({ qrcodeId: 'id' }), { redirect_host: 'sh.weixin.qq.com' });
  assert.equal(client.baseUrl, ORIGIN, 'polling must not silently commit returned credentials');
});

for (const errorField of ['ret', 'errcode']) {
  test(`QR saved-token ${errorField}=-3 falls back once with no auth/base_info`, async () => {
    const { client, calls } = fakeClient([
      { ret: 0, errcode: 0, [errorField]: '-3', errmsg: `invalid ${TOKEN}` },
      { qrcode: 'fresh-qr' },
    ]);
    assert.deepEqual(await client.fetchQr({ localTokens: [' old ', 'old', '', 'other'] }), {
      qrcodeId: 'fresh-qr', qrContent: 'fresh-qr',
    });
    assert.deepEqual(calls.map((call) => call.body), [
      { local_token_list: ['old', 'other'] }, { local_token_list: [] },
    ]);
    for (const { headers, body } of calls) {
      assert.equal(headers.has('authorization'), false);
      assert.equal(Object.hasOwn(body, 'base_info'), false);
    }
  });
}

test('QR fallback sees -3 in either business field, even with another nonzero code', async () => {
  const { client, calls } = fakeClient([{ ret: -3, errcode: 99 }, { qrcode: 'ok', qrcode_img_content: 'content' }]);
  assert.deepEqual(await client.fetchQr({ localTokens: ['old'] }), { qrcodeId: 'ok', qrContent: 'content' });
  assert.equal(calls.length, 2);
});

test('QR force clears saved tokens and token history is capped at ten', async () => {
  const { client, calls } = fakeClient([{ qrcode: 'a' }, { qrcode: 'b' }]);
  await client.fetchQr({ force: true, localTokens: ['saved'] });
  await client.fetchQr({ localTokens: Array.from({ length: 12 }, (_, index) => `token-${index}`) });
  assert.deepEqual(calls[0].body, { local_token_list: [] });
  assert.equal(calls[1].body.local_token_list.length, 10);
});

test('QR never repeats fallback or retries an empty-token rejection', async () => {
  const first = fakeClient([{ ret: -3 }, { errcode: -3 }]);
  await assert.rejects(first.client.fetchQr({ localTokens: ['old'] }), expectError({ kind: 'business', code: -3, retryable: false }));
  assert.equal(first.calls.length, 2);
  const second = fakeClient([{ ret: -3 }]);
  await assert.rejects(second.client.fetchQr(), expectError({ code: -3 }));
  assert.equal(second.calls.length, 1);
});

for (const code of [-14, -2, -9]) {
  test(`QR does not downgrade saved credentials on business code ${code}`, async () => {
    const { client, calls } = fakeClient([{ errcode: code }]);
    await assert.rejects(client.fetchQr({ localTokens: ['saved'] }), expectError({ code, retryable: false }));
    assert.equal(calls.length, 1);
  });
}

for (const result of [{}, { qrcode: '' }, { qrcode: 123 }, { qrcode: 'ok', qrcode_img_content: {} }]) {
  test(`QR rejects malformed code payload ${JSON.stringify(result)}`, async () => {
    const { client } = fakeClient([result]);
    await assert.rejects(client.fetchQr(), expectError({ kind: 'protocol', retryable: true, code: 'INVALID_RESPONSE' }));
  });
}

for (const [result, kind, code] of [
  [{ ret: -14, errcode: 0 }, 'auth', -14], [{ ret: 0, errcode: -14 }, 'auth', -14],
  [{ ret: '-14', errcode: '0' }, 'auth', -14], [{ ret: '-2', errcode: 0 }, 'context', -2],
  [{ ret: 0, errcode: '-2' }, 'context', -2], [{ ret: -2, errcode: -14 }, 'auth', -14],
  [{ ret: -14, errcode: -2 }, 'auth', -14], [{ ret: -3, errcode: 0 }, 'business', -3],
  [{ ret: 0, errcode: 42 }, 'business', 42], [{ ret: 99 }, 'business', 99],
]) {
  test(`business ret/errcode independently classify ${JSON.stringify(result)}`, async () => {
    const { client, calls } = fakeClient([{ ...result, errmsg: `NEVER_SHOW ${TOKEN} ${CONTEXT}` }]);
    await assert.rejects(client.getUpdates(), (error) => {
      expectError({ kind, code, retryable: false, endpoint: 'ilink/bot/getupdates' })(error);
      assert.equal(inspect(error).includes(CONTEXT), false);
      assert.equal(inspect(error).includes('NEVER_SHOW'), false);
      return true;
    });
    assert.equal(calls.length, 1);
  });
}

for (const result of [{ ret: { bad: TOKEN } }, { errcode: 'not-a-number' }, { ret: 1.5 }]) {
  test(`malformed business status is retryable protocol failure ${JSON.stringify(result)}`, async () => {
    const { client } = fakeClient([result]);
    await assert.rejects(client.getUpdates(), expectError({ kind: 'protocol', code: 'INVALID_RESPONSE', retryable: true }));
  });
}

for (const status of [400, 401, 403, 404, 408, 409, 425, 429, 500, 502, 599]) {
  test(`HTTP ${status} has the correct retry policy and does not expose its body`, async () => {
    const { client } = fakeClient([new Response(`UPSTREAM ${TOKEN}`, { status })]);
    await assert.rejects(client.getUpdates(), expectError({
      kind: 'http', code: status, retryable: [408, 425, 429].includes(status) || status >= 500,
    }));
  });
}

for (const status of [301, 302, 303, 307, 308]) {
  test(`HTTP ${status} redirects cannot forward a Bearer token`, async () => {
    const { client, calls } = fakeClient([new Response(`secret ${TOKEN}`, {
      status, headers: { Location: `https://attacker.example/collect?token=${TOKEN}` },
    })]);
    await assert.rejects(client.getUpdates(), expectError({ kind: 'http', code: status, retryable: false }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.redirect, 'manual');
    assert.equal(calls[0].url.origin, ORIGIN);
  });
}

test('an already-followed redirect response is also rejected', async () => {
  const { client } = fakeClient([() => ({ status: 200, redirected: true, body: null })]);
  await assert.rejects(client.getUpdates(), expectError({ kind: 'http', retryable: false }));
});

test('transport errors are retryable and redact their URL, cause and original message', async () => {
  const error = new TypeError(`fetch ${ORIGIN}/?token=${TOKEN} failed`, { cause: new Error(TOKEN) });
  const { client, calls } = fakeClient([error]);
  await assert.rejects(client.getUpdates(), expectError({ kind: 'network', code: 'NETWORK_ERROR', retryable: true }));
  assert.equal(calls.length, 1);
});

for (const body of [`bad JSON ${TOKEN}`, 'null', '[]', '"string"', '42', 'true']) {
  test(`bad/non-object JSON is a redacted retryable protocol error (${body[0]})`, async () => {
    const { client } = fakeClient([new Response(body)]);
    await assert.rejects(client.getUpdates(), expectError({ kind: 'protocol', retryable: true }));
  });
}

test('UTF-8 response decoding survives multi-byte characters across streamed chunks', async () => {
  const source = new TextEncoder().encode(JSON.stringify({ ret: 0, text: '汉😀字' }));
  const response = new Response(new ReadableStream({
    start(controller) {
      for (let index = 0; index < source.length; index += 1) controller.enqueue(source.subarray(index, index + 1));
      controller.close();
    },
  }));
  const { client } = fakeClient([response]);
  assert.deepEqual(await client.getUpdates(), { ret: 0, text: '汉😀字' });
});

test('invalid UTF-8 is a retryable protocol error', async () => {
  const { client } = fakeClient([new Response(new Uint8Array([0xff, 0xfe]))]);
  await assert.rejects(client.getUpdates(), expectError({ kind: 'protocol', code: 'INVALID_JSON', retryable: true }));
});

test('exactly 1 MiB is allowed; larger streamed JSON is cancelled and rejected', async () => {
  const paddingSize = LIMIT - Buffer.byteLength(JSON.stringify({ padding: '' }));
  const allowed = { padding: 'x'.repeat(paddingSize) };
  const first = fakeClient([allowed]);
  assert.deepEqual(await first.client.getUpdates(), allowed);
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(LIMIT + 1)); },
    cancel() { cancelled = true; },
  }));
  const second = fakeClient([response]);
  await assert.rejects(second.client.getUpdates(), expectError({ kind: 'protocol', code: 'RESPONSE_TOO_LARGE', retryable: true }));
  assert.equal(cancelled, true);
});

test('oversized Content-Length is rejected without starting a body read', async () => {
  let read = false;
  let cancelled = false;
  const { client } = fakeClient([() => ({
    status: 200,
    headers: new Headers({ 'content-length': String(LIMIT + 1) }),
    body: { getReader() { read = true; throw new Error('not reached'); }, cancel() { cancelled = true; } },
  })]);
  await assert.rejects(client.getUpdates(), expectError({ code: 'RESPONSE_TOO_LARGE' }));
  assert.equal(read, false);
  assert.equal(cancelled, true);
});

test('body size is measured in bytes, not JS characters or the declared length', async () => {
  const { client } = fakeClient([new Response(JSON.stringify({ text: '😀'.repeat(270_000) }), {
    headers: { 'content-length': '1' },
  })]);
  await assert.rejects(client.getUpdates(), expectError({ code: 'RESPONSE_TOO_LARGE' }));
});

test('minimal injected text-only responses are supported and size-limited', async () => {
  const { client } = fakeClient([
    () => ({ status: 200, text: async () => '{"ret":0}' }),
    () => ({ status: 200, text: async () => 'x'.repeat(LIMIT + 1) }),
  ]);
  assert.deepEqual(await client.getUpdates(), { ret: 0 });
  await assert.rejects(client.getUpdates(), expectError({ code: 'RESPONSE_TOO_LARGE' }));
});

test('request timeout works even if an injected fetch ignores its AbortSignal', async () => {
  let fetchSignal;
  const client = new ILinkClient({
    timeoutMs: 20,
    fetchImpl: (_url, init) => { fetchSignal = init.signal; return never(); },
  });
  await assert.rejects(client.fetchQr(), expectError({ kind: 'network', code: 'TIMEOUT', retryable: true }));
  assert.equal(fetchSignal.aborted, true);
});

test('getUpdates per-call timeout overrides the general client timeout', async () => {
  const client = new ILinkClient({ token: TOKEN, timeoutMs: 10_000, fetchImpl: never });
  await assert.rejects(client.getUpdates({ timeoutMs: 20 }), expectError({ kind: 'network', code: 'TIMEOUT', retryable: true }));
});

for (const mode of ['stream', 'text']) {
  test(`timeout covers a hanging ${mode} response reader`, async () => {
    let cancelled = false;
    const body = mode === 'stream'
      ? { body: { getReader: () => ({ read: never, cancel() { cancelled = true; }, releaseLock() {} }) } }
      : { text: never };
    const client = new ILinkClient({ token: TOKEN, timeoutMs: 20, fetchImpl: async () => ({ status: 200, ...body }) });
    await assert.rejects(client.getConfig({ userId: 'u' }), expectError({ kind: 'network', code: 'TIMEOUT', retryable: true }));
    if (mode === 'stream') assert.equal(cancelled, true);
  });
}

test('pre-aborted requests do not call fetch and do not leak parent reasons', async () => {
  const controller = new AbortController();
  controller.abort(new Error(`parent secret ${TOKEN}`));
  const { client, calls } = fakeClient([]);
  await assert.rejects(client.getUpdates({ signal: controller.signal }), expectError({ kind: 'network', code: 'ABORTED', retryable: false }));
  assert.equal(calls.length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('parent cancellation aborts a pending fetch, removes listeners, and is nonretryable', async () => {
  const controller = new AbortController();
  let begin;
  let fetchSignal;
  const started = new Promise((resolve) => { begin = resolve; });
  const client = new ILinkClient({
    token: TOKEN, fetchImpl: (_url, init) => { fetchSignal = init.signal; begin(); return never(); },
  });
  const pending = client.getUpdates({ signal: controller.signal });
  await started;
  controller.abort(`${ORIGIN}/?${TOKEN}`);
  await assert.rejects(pending, expectError({ kind: 'network', code: 'ABORTED', retryable: false }));
  assert.equal(fetchSignal.aborted, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('parent cancellation also interrupts JSON body reads and cancels the stream', async () => {
  const controller = new AbortController();
  let begin;
  let cancelled = false;
  const started = new Promise((resolve) => { begin = resolve; });
  const { client } = fakeClient([() => ({
    status: 200,
    body: { getReader: () => ({
      read() { begin(); return never(); },
      cancel() { cancelled = true; return never(); },
      releaseLock() {},
    }) },
  })]);
  const pending = client.getUpdates({ signal: controller.signal });
  await started;
  controller.abort(new Error(TOKEN));
  await assert.rejects(pending, expectError({ code: 'ABORTED', retryable: false }));
  assert.equal(cancelled, true, 'cancelling a body must not await a hanging cancel()');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('successful requests remove the parent abort listener', async () => {
  const controller = new AbortController();
  const { client } = fakeClient();
  await client.getUpdates({ signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const value of [
  undefined, null, '', 'weixin.qq.com', 'http://weixin.qq.com', '//weixin.qq.com',
  'https://evilweixin.qq.com', 'https://weixin.qq.com.evil.test', 'https://qq.com',
  'https://127.0.0.1', 'https://[::1]', 'https://2130706433',
  'https://user@weixin.qq.com', `https://${TOKEN}@weixin.qq.com`, 'https://weixin.qq.com@evil.test',
  'https://weixin.qq.com:443', 'https://weixin.qq.com:8443',
  'https://weixin.qq.com/path', 'https://weixin.qq.com/.', 'https://weixin.qq.com//',
  'https://weixin.qq.com?query', 'https://weixin.qq.com?', 'https://weixin.qq.com#hash', 'https://weixin.qq.com#',
  'https://weixin.qq.com\\evil', 'https://%77eixin.qq.com', 'https://weixin.qq.com.',
  'https://a..weixin.qq.com', 'https://-a.weixin.qq.com', 'https://a-.weixin.qq.com',
  `https://${'a'.repeat(64)}.weixin.qq.com`, 'https://a_b.weixin.qq.com',
  ' https://weixin.qq.com', 'https://weixin.qq.com\n', 'https://weixin.qq.com/\r\n',
  'https://wei\nxin.qq.com', 'https://ｗeixin.qq.com', {},
]) {
  test(`validateBaseUrl rejects unsafe or ambiguous origin ${JSON.stringify(value)}`, () => {
    assert.throws(() => validateBaseUrl(value), expectError({ kind: 'protocol', code: 'INVALID_BASE_URL', retryable: false }));
  });
}

for (const [value, expected] of [
  [ORIGIN, ORIGIN], [`${ORIGIN}/`, ORIGIN],
  ['HTTPS://SH.WEIXIN.QQ.COM/', 'https://sh.weixin.qq.com'],
  ['https://weixin.qq.com', 'https://weixin.qq.com'],
  ['https://region-a.deep.weixin.qq.com', 'https://region-a.deep.weixin.qq.com'],
]) {
  test(`validateBaseUrl canonicalizes ${value}`, () => assert.equal(validateBaseUrl(value), expected));
}

for (const field of ['baseurl', 'redirect_host']) {
  for (const value of ['http://sh.weixin.qq.com', 'https://evil.example', 'https://weixin.qq.com:443', 'weixin.qq.com@evil.test', {}, 'https://weixin.qq.com/path']) {
    test(`QR login rejects unsafe returned ${field} ${JSON.stringify(value)}`, async () => {
      const { client } = fakeClient([{ status: 'confirmed', bot_token: TOKEN, [field]: value }]);
      await assert.rejects(client.pollQr({ qrcodeId: `private-code-${TOKEN}` }), expectError({
        code: 'INVALID_BASE_URL', retryable: false, endpoint: 'ilink/bot/get_qrcode_status',
      }));
    });
  }
}

test('unsafe poll override is rejected before any network request', async () => {
  const { client, calls } = fakeClient([]);
  await assert.rejects(client.pollQr({ qrcodeId: TOKEN, baseUrl: 'https://evil.example' }), expectError({ code: 'INVALID_BASE_URL' }));
  assert.equal(calls.length, 0);
});

test('invalid client arguments and missing credentials fail locally without leaking values', async () => {
  for (const timeoutMs of [0, -1, 0.5, Infinity, 2_147_483_648]) {
    assert.throws(() => new ILinkClient({ timeoutMs }), expectError({ code: 'INVALID_ARGUMENT' }));
  }
  assert.throws(() => new ILinkClient({ fetchImpl: null }), expectError({ code: 'INVALID_ARGUMENT' }));
  const { client, calls } = fakeClient([]);
  for (const operation of [
    () => client.getUpdates({ cursor: {} }),
    () => client.getUpdates({ timeoutMs: -1 }),
    () => client.getUpdates({ signal: {} }),
    () => client.getConfig({ userId: '' }),
    () => client.getConfig({ userId: 'group@chatroom' }),
    () => client.sendText({ userId: 'u', text: null }),
    () => client.sendText({ userId: 'group@chatroom', text: 'x' }),
    () => client.notify(`start?${TOKEN}`),
    () => client.fetchQr({ localTokens: [TOKEN, {}] }),
    () => client.pollQr({ qrcodeId: '' }),
  ]) await assert.rejects(operation(), expectError({ code: 'INVALID_ARGUMENT', retryable: false }));
  assert.equal(calls.length, 0);
  client.setAccount({ token: '' });
  await assert.rejects(client.getUpdates(), expectError({ kind: 'auth', code: 'MISSING_TOKEN', retryable: false }));
});

test('splitText removes images/strike markers and makes bare angles safe outside code', () => {
  assert.deepEqual(splitText('  Hello ![alt](https://x/a(b).png) ~~world~~ <tag> >  '), ['Hello  world ＜tag＞ ＞']);
  assert.deepEqual(splitText('before ![alt][image-ref] after'), ['before  after']);
  assert.deepEqual(splitText('![alt](https://x/image "a title")'), []);
  assert.deepEqual(splitText(''), []);
  assert.deepEqual(splitText(' \n\t '), []);
  assert.deepEqual(splitText(null), []);
});

test('splitText preserves inline backticks of different widths and multiline spans', () => {
  const source = 'outside <x> ~~a~~ `inside <x> ~~a~~ ![x](u)` and ``a `b` <c>`` and `line\n<d>`';
  assert.deepEqual(splitText(source), [
    'outside ＜x＞ a `inside <x> ~~a~~ ![x](u)` and ``a `b` <c>`` and `line\n<d>`',
  ]);
  const inline = '`<intact> ~~x~~`';
  const chunks = splitText(`prefix text ${inline} suffix text repeated`, 20);
  assert.ok(chunks.includes(inline) || chunks.some((chunk) => chunk.includes(inline)));
  assertChunkLimit(chunks, 20);
});

test('splitText does not sanitize code inside backtick or tilde fences', () => {
  for (const marker of ['```', '~~~', '````']) {
    const source = `${marker}js\n  const html = '<tag>'; // ~~keep~~ ![keep](url)\n${marker}`;
    assert.deepEqual(splitText(source), [source]);
  }
});

test('splitText balances and reopens long fenced code with its language and indentation intact', () => {
  const lines = Array.from({ length: 12 }, (_, index) => `  line_${index} = '😀<x>~~';`);
  const source = `intro\n\`\`\`js\n${lines.join('\n')}\n\`\`\`\nend`;
  const chunks = splitText(source, 80);
  assert.ok(chunks.length > 2);
  assertChunkLimit(chunks, 80);
  for (const chunk of chunks) {
    const fenceLines = chunk.split('\n').filter((line) => /^```/.test(line));
    assert.equal(fenceLines.length % 2, 0, chunk);
    assert.ok(!chunk.includes('＜x＞'), 'code was incorrectly sanitized');
  }
  for (const line of lines) assert.equal(chunks.filter((chunk) => chunk.includes(line)).length, 1);
  assert.ok(chunks.some((chunk) => chunk.startsWith('```js\n  line_')));
});

test('splitText supports repeated fences, tilde fences, inline code, and literal triple ticks inside longer fences', () => {
  const source = [
    'start', '````js', 'const a = "``` and `inline` <raw>";', 'x'.repeat(90), '````',
    'middle <safe>', '~~~txt', 'y'.repeat(90), '~~~', 'finish',
  ].join('\n');
  const chunks = splitText(source, 45);
  assertChunkLimit(chunks, 45);
  assert.ok(chunks.some((chunk) => chunk.includes('＜safe＞')));
  for (const chunk of chunks) {
    let inBacktick = false;
    let inTilde = false;
    for (const line of chunk.split('\n')) {
      if (/^````/.test(line)) inBacktick = !inBacktick;
      if (/^~~~/.test(line)) inTilde = !inTilde;
    }
    assert.equal(inBacktick, false, chunk);
    assert.equal(inTilde, false, chunk);
  }
});

test('splitText has a strict Unicode code-point maximum even for tiny maxima and long fence headers', () => {
  for (const maximum of [1, 2, 3, 4, 5, 7, 8, 9, 10, 15, 30, 1800]) {
    for (const source of [
      '😀中𠮷a'.repeat(80),
      `\`\`\`javascript\n${'😀'.repeat(100)}\n\`\`\``,
      `${'`'.repeat(50)}language\n${'x'.repeat(100)}\n${'`'.repeat(50)}`,
      `\`\`\`${'verylonglanguage'.repeat(8)}\n${'a'.repeat(100)}\n\`\`\``,
    ]) assertChunkLimit(splitText(source, maximum), maximum);
  }
  const source = '😀中𠮷a'.repeat(40);
  assert.equal(splitText(source, 17).join(''), source);
  assert.equal(splitText('😀'.repeat(1800)).length, 1);
  assert.equal(splitText('😀'.repeat(1801)).length, 2);
  for (const maximum of [0, -1, 0.1, Infinity, NaN]) assert.throws(() => splitText('x', maximum), RangeError);
});

test('splitText prefers readable boundaries without dropping whitespace or content', () => {
  const source = 'First sentence. Second sentence!\n\nThird paragraph with 中文。More text.';
  const chunks = splitText(source, 24);
  assertChunkLimit(chunks, 24);
  assert.equal(chunks.join(''), source);
  assert.ok(chunks.some((chunk) => chunk.endsWith('\n\n')));
});

test('extractTextMessage returns the complete personal text envelope', () => {
  const raw = inbound();
  assert.deepEqual(extractTextMessage(raw), {
    id: 'message-123', userId: 'personal-user', text: '你好', contextToken: CONTEXT, createdAt: raw.create_time_ms,
  });
  assert.equal(extractTextMessage(inbound({ message_id: 123 })).id, '123');
  assert.equal(extractTextMessage(inbound({ message_id: undefined, msgid: 'alternate' })).id, 'alternate');
  assert.equal(extractTextMessage(inbound({ message_id: undefined, seq: 0 })).id, '0');
  assert.equal(extractTextMessage(inbound({ create_time_ms: '1799999999123' })).createdAt, 1_799_999_999_123);
  assert.equal(extractTextMessage(inbound({ context_token: {} })).contextToken, '');
});

for (const raw of [
  null, [], {}, inbound({ message_type: 2 }), inbound({ message_type: '2' }),
  inbound({ from_user_id: '' }), inbound({ from_user_id: null }), inbound({ from_user_id: '  ' }),
  inbound({ from_user_id: 'group@chatroom' }), inbound({ to_user_id: 'group@CHATROOM' }),
  inbound({ item_list: [] }), inbound({ item_list: [{ type: 1, text_item: { text: ' ' } }] }),
  inbound({ item_list: [{ type: 1, text_item: { text: 1 } }] }),
  inbound({ item_list: [{ type: 2, text_item: { text: 'media spoof' } }] }),
  inbound({ item_list: [{ type: 3, voice_item: { text: 'voice transcript' } }] }),
  inbound({ item_list: [{ type: 4, file_item: { file_name: 'file.txt' } }] }),
]) {
  test(`extractTextMessage ignores bot/group/missing/non-text input (${JSON.stringify(raw)?.slice(0, 70)})`, () => {
    assert.equal(extractTextMessage(raw), null);
  });
}

test('extractTextMessage includes only type-1 text, with text-only references', () => {
  const result = extractTextMessage(inbound({ item_list: [
    { type: 1, text_item: { text: 'reply' }, ref_msg: {
      title: 'Alice', message_item: { type: 1, text_item: { text: 'quoted text' } },
    } },
    { type: 2, image_item: {}, text_item: { text: 'not text' } },
    { type: 1, text_item: { text: 'image reply' }, ref_msg: {
      title: '[image]', message_item: { type: 2, text_item: { text: 'never include media' } },
    } },
    { type: '1', text_item: { text: 'last part' } },
  ] }));
  assert.equal(result.text, '[引用: Alice | quoted text]\nreply\nimage reply\nlast part');
  assert.equal(result.text.includes('[image]'), false);
  assert.equal(result.text.includes('not text'), false);
  assert.equal(result.text.includes('never include media'), false);
});

test('extractTextMessage uses stable SHA-256 fallback IDs independent of key order and rotating contexts', () => {
  const raw = inbound({ message_id: undefined, create_time_ms: undefined });
  const first = extractTextMessage(raw);
  const reordered = Object.fromEntries(Object.entries(raw).reverse());
  assert.match(first.id, /^fallback-[a-f0-9]{64}$/);
  assert.equal(first.createdAt, null);
  assert.equal(extractTextMessage(reordered).id, first.id);
  assert.equal(extractTextMessage({ ...raw, context_token: 'rotated' }).id, first.id);
  assert.notEqual(extractTextMessage(inbound({ message_id: undefined, create_time_ms: undefined, item_list: [{ type: 1, text_item: { text: 'different' } }] })).id, first.id);
  assert.notEqual(extractTextMessage({ ...raw, from_user_id: 'other-user' }).id, first.id);
  assert.notEqual(extractTextMessage({ ...raw, create_time_ms: 123 }).id, first.id);
});

test('extractTextMessage ignores inherited and accessor fields, including nested text and sparse array items', () => {
  const protoSender = Object.assign(Object.create({ from_user_id: 'inherited-user' }), inbound());
  delete protoSender.from_user_id;
  assert.equal(extractTextMessage(protoSender), null);
  const protoText = Object.create({ text: 'inherited text' });
  assert.equal(extractTextMessage(inbound({ item_list: [{ type: 1, text_item: protoText }] })), null);
  const protoType = Object.create({ type: 1 });
  protoType.text_item = { text: 'not own type' };
  assert.equal(extractTextMessage(inbound({ item_list: [protoType] })), null);
  const accessorText = { get text() { throw new Error('accessor must not run'); } };
  assert.equal(extractTextMessage(inbound({ item_list: [{ type: 1, text_item: accessorText }] })), null);
  const items = new Array(1);
  Object.setPrototypeOf(items, { 0: { type: 1, text_item: { text: 'inherited array item' } } });
  assert.equal(extractTextMessage(inbound({ item_list: items })), null);
  const noProto = Object.assign(Object.create(null), inbound());
  assert.equal(extractTextMessage(noProto).text, '你好');
  const inheritedId = Object.assign(Object.create({ message_id: 'inherited-id' }), inbound());
  delete inheritedId.message_id;
  assert.match(extractTextMessage(inheritedId).id, /^fallback-/);
});

test('extractTextMessage does not impose the embedding plugin input-length policy', () => {
  const text = 'a😀'.repeat(10_000);
  assert.equal(extractTextMessage(inbound({ item_list: [{ type: 1, text_item: { text } }] })).text, text);
});
