import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { duplexPair } from 'node:stream';
import WebSocket from 'ws';
import { websocket, WEBSOCKET_PATH } from '../lib/channels/websocket.js';

const tokenA = 'client-a-unique-fake-token';
const tokenB = 'client-b-unique-fake-token';

async function localBridge(t, onMessage) {
  const abort = new AbortController();
  let registered;
  const statuses = [];
  const server = createServer();
  server.on('upgrade', (request, socket, head) => {
    if (!registered || new URL(request.url, 'http://localhost').pathname !== registered.path) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    registered.handler(request, socket, head);
  });
  const streams = new Set();
  const url = `ws://127.0.0.1${WEBSOCKET_PATH}`;
  function open(url, options, remoteAddress = '127.0.0.1') {
    const [local, remote] = duplexPair();
    for (const stream of [local, remote]) {
      streams.add(stream);
      stream.once('close', () => streams.delete(stream));
      stream.setTimeout = stream.setNoDelay = stream.setKeepAlive = () => stream;
    }
    local.once('close', () => remote.destroy());
    remote.once('close', () => local.destroy());
    remote.remoteAddress = remoteAddress;
    server.emit('connection', remote);
    return new WebSocket(url, { ...options, createConnection: () => local });
  }
  const adapter = websocket.create({ clientTokens: JSON.stringify({
    alice: tokenA, bob: tokenB, pending: 'unapproved-client-fake-token',
  }) }, {
    registerUpgrade: (upgrade) => {
      registered = upgrade;
      return () => { registered = undefined; };
    },
    signal: abort.signal,
    allowSender: (id) => id === 'alice' || id === 'bob',
    setStatus: (...args) => statuses.push(args),
    onMessage,
  });
  const run = adapter.run();
  t.after(async () => {
    abort.abort();
    await run;
    for (const stream of streams) stream.destroy();
  });
  return { adapter, abort, run, statuses, url, open, get registered() { return registered; } };
}

function waitForFrame(client) {
  return once(client, 'message').then(([data]) => JSON.parse(data.toString('utf8')));
}

async function connect(t, bridge, clientId, token, bearer = false) {
  const target = new URL(bridge.url);
  target.searchParams.set('client_id', clientId);
  if (!bearer) target.searchParams.set('token', token);
  const client = bridge.open(target, bearer ? { headers: { authorization: `Bearer ${token}` } } : {});
  t.after(() => client.terminate());
  const ready = await waitForFrame(client);
  assert.equal(ready.event, 'ready');
  assert.equal(ready.client_id, clientId);
  return { client, ready };
}

test('WebSocket upgrade requires an approved client and TLS outside the local machine', async (t) => {
  const bridge = await localBridge(t, assert.fail);
  assert.deepEqual(bridge.statuses, [['connecting'], ['connected']]);
  const cases = [
    [bridge.url, undefined, 401],
    [`${bridge.url}?client_id=bob&token=${tokenA}`, undefined, 401],
    [`${bridge.url}?client_id=pending&token=unapproved-client-fake-token`, undefined, 401],
    [`${bridge.url}?client_id=alice&token=${tokenA}`, '192.0.2.2', 403],
  ];
  for (const [url, remoteAddress, status] of cases) {
    const client = bridge.open(url, undefined, remoteAddress);
    const [, response] = await once(client, 'unexpected-response');
    assert.equal(response.statusCode, status);
    response.resume();
    client.on('error', () => {});
    client.terminate();
  }
});

test('WebSocket isolates client routes, waits for admission before acknowledgement, and returns the reply', async (t) => {
  const inbound = [];
  let releaseAdmission;
  const bridge = await localBridge(t, (message) => {
    inbound.push(message);
    return new Promise((resolve) => { releaseAdmission = resolve; });
  });
  const alice = await connect(t, bridge, 'alice', tokenA, true);
  const bob = await connect(t, bridge, 'bob', tokenB);
  assert.notEqual(alice.ready.chat_id, bob.ready.chat_id);

  const rejected = waitForFrame(alice.client);
  alice.client.send(JSON.stringify({
    type: 'message', chat_id: bob.ready.chat_id, turn_id: 't-foreign', content: 'unauthorized',
  }));
  assert.equal((await rejected).detail, 'access_denied');
  assert.equal(inbound.length, 0);

  const accepted = waitForFrame(alice.client);
  let acknowledged = false;
  accepted.then(() => { acknowledged = true; });
  alice.client.send(JSON.stringify({
    type: 'message', chat_id: alice.ready.chat_id, turn_id: 't-1', content: 'hello',
  }));
  for (let attempt = 0; !releaseAdmission && attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(acknowledged, false);
  assert.deepEqual(inbound, [{ id: 't-1', senderId: 'alice', chatId: alice.ready.chat_id, text: 'hello' }]);
  releaseAdmission();
  assert.deepEqual(await accepted, {
    event: 'message_accepted', chat_id: alice.ready.chat_id, turn_id: 't-1',
  });

  const reply = waitForFrame(alice.client);
  await bridge.adapter.send(inbound[0], 'hello from DSH');
  assert.deepEqual(await reply, {
    event: 'message', chat_id: alice.ready.chat_id, turn_id: 't-1', text: 'hello from DSH',
  });
  await assert.rejects(bridge.adapter.send({ ...inbound[0], senderId: 'bob' }, 'denied'), { kind: 'rejected' });
});

test('WebSocket reconnects to the same client route and stops removing the upgrade handler', async (t) => {
  const bridge = await localBridge(t, async () => {});
  const first = await connect(t, bridge, 'alice', tokenA);
  const closed = once(first.client, 'close');
  first.client.terminate();
  await closed;
  const routing = { id: 't-retry', senderId: 'alice', chatId: first.ready.chat_id };
  await assert.rejects(bridge.adapter.send(routing, 'pending'), { kind: 'retry' });

  const second = await connect(t, bridge, 'alice', tokenA);
  assert.equal(second.ready.chat_id, first.ready.chat_id);
  const reply = waitForFrame(second.client);
  await bridge.adapter.send(routing, 'pending');
  assert.equal((await reply).text, 'pending');

  const stopped = once(second.client, 'close');
  bridge.abort.abort();
  await bridge.run;
  await stopped;
  assert.equal(bridge.registered, undefined);
});

test('WebSocket relays bounded inline attachments and rejects local paths and over-limit files', { timeout: 2_000 }, async (t) => {
  const inbound = [];
  const bridge = await localBridge(t, async (entry) => { inbound.push(entry); });
  const { client, ready } = await connect(t, bridge, 'alice', tokenA);
  for (const media of [
    [{ name: 'local.txt', path: '/home/private/document' }],
    [{ name: 'too-large.txt', mime: 'text/plain', data: Buffer.alloc(1024 * 1024 + 1).toString('base64') }],
    [{ name: 'broken.txt', mime: 'text/plain', data: 'broken!!' }],
  ]) {
    const frame = waitForFrame(client);
    client.send(JSON.stringify({ type: 'message', chat_id: ready.chat_id, content: 'inspect file', media }));
    assert.equal((await frame).detail, 'attachment_rejected');
  }
  assert.equal(inbound.length, 0);

  const accepted = waitForFrame(client);
  const data = Buffer.from('websocket file contents').toString('base64');
  client.send(JSON.stringify({ type: 'message', chat_id: ready.chat_id, turn_id: 'files', media: [
    { name: 'readme.txt', mime: 'text/plain', data },
  ] }));
  assert.equal((await accepted).event, 'message_accepted');
  assert.deepEqual(inbound, [{ id: 'files', senderId: 'alice', chatId: ready.chat_id, text: '', attachments: [
    { name: 'readme.txt', kind: 'file', mediaType: 'text/plain', data },
  ] }]);
});
