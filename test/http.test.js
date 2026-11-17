import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createApiHandler, validateRequest } from '../lib/http.js';

function fixture({ admission, peerId = 'browser', method = 'POST', headers = {}, body = { action: 'status' }, fail } = {}) {
  const req = new PassThrough(); req.method = method;
  req.headers = { 'content-type': 'application/json', 'x-dsh-weixin-bridge': '1', ...headers };
  let ended; const response = new Promise(resolve => { ended = resolve; });
  const res = { statusCode: 200, headers: {}, writableEnded: false, destroyed: false,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(value = '') { this.writableEnded = true; this.body = value; ended(this); },
  };
  const calls = [];
  const connection = { browserPeer: { id: 'browser' }, admit(actual) {
    assert.equal(actual, req);
    return admission || { peer: { id: peerId, principal: { kind: 'owner' } } };
  } };
  const bridge = { async action(...args) { calls.push(args); if (fail) throw fail; return { connectionStatus: 'disconnected' }; } };
  const handler = createApiHandler({ connection, bridge });
  const task = handler(req, res);
  req.end(typeof body === 'string' ? body : JSON.stringify(body));
  return { task, response, calls, res };
}

test('owner browser reaches the shared operation with an explicit user-only marker', async () => {
  const f = fixture({ body: { action: 'user.approve', userId: 'me', code: '12345678' } });
  await f.task;
  assert.equal(f.res.statusCode, 200);
  assert.deepEqual(f.calls[0], ['user.approve', { action: 'user.approve', userId: 'me', code: '12345678' }, { user: true }]);
  assert.equal(f.res.headers['cache-control'], 'no-store');
});
for (const status of [401, 403]) test(`DSH trust/auth rejection ${status} reaches no operation`, async () => {
  const f = fixture({ admission: { rejection: status } }); await f.task;
  assert.equal(f.res.statusCode, status); assert.equal(f.calls.length, 0);
});
test('even an owner API peer cannot grant browser-only authority', async () => {
  const f = fixture({ peerId: 'automation-peer' }); await f.task;
  assert.equal(f.res.statusCode, 403); assert.equal(f.calls.length, 0);
});
test('non-owner peers are refused before reading the body', async () => {
  const f = fixture({ admission: { peer: { id: 'browser', principal: { kind: 'remote' } } } }); await f.task;
  assert.equal(f.res.statusCode, 403); assert.equal(f.calls.length, 0);
});
for (const headers of [{ 'content-type': 'text/plain' }, { 'x-dsh-weixin-bridge': '' }]) test('cross-site simple requests cannot change connection state', async () => {
  const f = fixture({ headers }); await f.task;
  assert.equal(f.res.statusCode, 403); assert.equal(f.calls.length, 0);
});
test('GET and malformed or oversized JSON do not execute actions', async () => {
  for (const [options, status] of [[{ method: 'GET' }, 405], [{ body: '{bad' }, 400], [{ body: ' '.repeat(9000) }, 413]]) {
    const f = fixture(options); await f.task;
    assert.equal(f.res.statusCode, status); assert.equal(f.calls.length, 0);
  }
});
test('wire validation rejects prototype action names, unknown fields, and incorrect argument types', () => {
  for (const body of [null, [], {}, { action: '__proto__' }, { action: 'constructor' },
    { action: 'status', token: 'hidden' }, { action: 'login.start', force: 'true' },
    { action: 'user.approve', userId: 'me' }, { action: 'user.revoke', userId: 42 },
    { action: 'login.verify', code: '1' }, { action: 'login.cancel' }]) {
    assert.throws(() => validateRequest(body), { code: 'INVALID_REQUEST' });
  }
});
test('unexpected errors never expose upstream tokens, payloads, or stack traces', async () => {
  const f = fixture({ fail: new Error('SECRET upstream body token=abcdef') }); await f.task;
  assert.equal(f.res.statusCode, 500); assert.equal(f.res.body.includes('SECRET'), false);
  assert.equal(f.res.body.includes('abcdef'), false); assert.equal(f.res.body.includes('stack'), false);
});
