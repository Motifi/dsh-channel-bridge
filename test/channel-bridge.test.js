import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelBridge, emptyChannelState } from '../lib/channel-bridge.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(test) {
  for (let step = 0; step < 100; step++) {
    if (test()) return;
    await tick();
  }
  assert.fail('Expected asynchronous work did not settle');
}

function fixture(saved = {}) {
  const records = saved.records ?? new Map();
  let state = saved.state ?? emptyChannelState();
  const sessions = [];
  const sends = [];
  const options = new Map();
  const create = (config, callbacks, id) => {
    options.set(id, callbacks);
    return {
      async run() {
        callbacks.setStatus('connected');
        await new Promise(resolve => callbacks.signal.addEventListener('abort', resolve, { once: true }));
      },
      async send(message, text) { sends.push({ id, message, text, config }); },
    };
  };
  const bridge = new ChannelBridge({
    catalog: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }], create,
    accounts: { get: async id => records.get(id), set: async (id, value) => records.set(id, value), delete: async id => records.delete(id) },
    store: { read: () => state, write: async next => { state = next; } },
    backend: { isSafe: () => true, run: async entry => { sessions.push(entry); return { state: 'completed', text: 'a reply' }; } },
    retryMs: 10,
  });
  async function connect(id) {
    await bridge.action('configure', { id, config: { token: 'secret' }, allowedSenders: ['alice', 'bob'] });
    await bridge.action('connection.resume', { id });
    await until(() => bridge.snapshot().channels.find(x => x.id === id).status === 'connected');
  }
  return { bridge, connect, sessions, sends, options, get saved() { return { records, state }; } };
}
const inbound = (id, fields = {}) => ({ id, senderId: 'alice', chatId: 'group', text: 'hi', ...fields });

test('routes owner-approved senders into stable channel, chat, thread and user scoped sessions', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.bridge.initialize();
  await f.connect('one'); await f.connect('two');
  const one = f.options.get('one');
  const two = f.options.get('two');
  await one.onMessage(inbound('unauthorized', { senderId: 'charlie' }));
  await one.onMessage(inbound('event'));
  await one.onMessage(inbound('event'));
  await one.onMessage(inbound('next'));
  await one.onMessage(inbound('other user', { senderId: 'bob' }));
  await one.onMessage(inbound('other thread', { threadId: 'thread' }));
  await two.onMessage(inbound('event'));
  await until(() => f.sends.length === 5);
  const entries = Object.fromEntries(f.sends.map(({ message, id }, index) => [id + message.id, index]));
  assert.equal(f.sessions.length, 5);
  const primary = f.sessions.find(entry => entry.message.id === 'event' && entry.channelId === 'one');
  assert.equal(primary.sessionId, f.sessions.find(entry => entry.message.id === 'next').sessionId);
  assert.equal(new Set(f.sessions.map(entry => entry.sessionId)).size, 4);
  assert.equal(Object.keys(entries).length, 5);
  assert.doesNotMatch(JSON.stringify(f.bridge.snapshot()), /secret|a reply/);
});

test('only established sender and instance routes can drive callbacks, and /new rotates that route only', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.bridge.initialize(); await f.connect('one');
  const { onMessage } = f.options.get('one');
  await onMessage(inbound('invalid callback', { requireExistingSession: true, instanceId: 'a' }));
  await onMessage(inbound('first', { instanceId: 'a' }));
  await until(() => f.sends.length === 1);
  await onMessage(inbound('callback', { requireExistingSession: true, instanceId: 'a' }));
  await onMessage(inbound('other instance', { requireExistingSession: true, instanceId: 'b' }));
  await onMessage(inbound('rotate', { text: '/new', instanceId: 'a' }));
  await onMessage(inbound('next', { instanceId: 'a' }));
  await until(() => f.sends.length === 4);
  assert.deepEqual(f.sessions.map(({ message }) => message.id), ['first', 'callback', 'next']);
  assert.equal(f.sessions[0].sessionId, f.sessions[1].sessionId);
  assert.notEqual(f.sessions[0].sessionId, f.sessions[2].sessionId);
});

test('only routes authorized updates and preserves outbound files in the durable reply', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  f.bridge.getPreferences = () => ({ streaming: true, sendToolHints: false });
  const original = f.bridge.create;
  const updates = [];
  const attachment = { name: 'report.txt', mime: 'text/plain', data: 'SGVsbG8=' };
  f.bridge.create = (...args) => ({ ...original(...args),
    async sendUpdate(update) { updates.push(update); },
    async sendPayload(reply) { f.sends.push(reply); },
  });
  f.bridge.backend.run = async (_entry, _signal, onUpdate) => {
    onUpdate({ type: 'delta', text: 'A' });
    onUpdate({ type: 'tool', text: 'not shared' });
    return { state: 'completed', text: 'A reply', attachments: [attachment] };
  };
  await f.bridge.initialize(); await f.connect('one');
  await f.options.get('one').onMessage(inbound('one', { route: { thread: 'example' } }));
  await until(() => f.sends.length === 1);
  assert.deepEqual(updates.map(({ type, text }) => [type, text]), [['delta', 'A']]);
  assert.equal(updates[0].messageId, f.sends[0].messageId);
  assert.deepEqual(updates[0].route, { thread: 'example' });
  assert.deepEqual(f.sends[0].attachments, [attachment]);
});

test('proactive deliveries queue once for the exact authorized route and cannot follow revocation', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.bridge.initialize(); await f.connect('one');
  const { onMessage } = f.options.get('one');
  await onMessage(inbound('first', { instanceId: 'a' }));
  await until(() => f.sends.length === 1);
  const { sessionId } = f.sessions[0];
  const message = { id: 'tick-1', text: 'a scheduled result' };
  assert.deepEqual(f.bridge.boundSessions(), [sessionId]);
  assert.equal(await f.bridge.sendToSession(sessionId, message), true);
  assert.equal(await f.bridge.sendToSession(sessionId, message), true);
  await until(() => f.sends.length === 2);
  assert.equal(f.sends[1].message.instanceId, 'a');
  assert.equal(f.sends[1].message.senderId, 'alice');
  await f.bridge.action('configure', { id: 'one', allowedSenders: ['bob'] });
  assert.deepEqual(f.bridge.boundSessions(), []);
  assert.equal(await f.bridge.sendToSession(sessionId, { id: 'tick-2', text: 'private content' }), false);
});

test('disconnect clears credentials, rotates conversation identity, and rejects stale transport callbacks', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.bridge.initialize(); await f.connect('one');
  const old = f.options.get('one');
  await old.onMessage(inbound('event'));
  await until(() => f.sends.length === 1);
  await f.bridge.action('connection.disconnect', { id: 'one' });
  assert.equal(f.saved.records.has('one'), false);
  await f.connect('one');
  await old.onMessage(inbound('late'));
  await f.options.get('one').onMessage(inbound('event'));
  await until(() => f.sends.length === 2);
  assert.notEqual(f.sessions[0].sessionId, f.sessions[1].sessionId);
});

test('startup recovers persisted deduplication and treats in-flight sends as uncertain', async t => {
  const first = fixture();
  await first.bridge.initialize(); await first.connect('one');
  await first.options.get('one').onMessage(inbound('event'));
  await until(() => first.sends.length === 1);
  await first.bridge.close();
  const saved = first.saved;
  const channel = saved.state.channels.one;
  channel.queue.push({ key: 'in-flight', phase: 'sending', reply: 'already submitted', message: inbound('previous') });
  const second = fixture(saved); t.after(() => second.bridge.close());
  await second.bridge.initialize();
  await until(() => second.options.has('one'));
  await second.options.get('one').onMessage(inbound('event'));
  await tick();
  assert.deepEqual(second.sends, []);
  assert.equal(second.bridge.snapshot().channels[0].uncertainReplies, 1);
});

test('a full durable inbox applies backpressure and pause settles its active work', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.bridge.initialize(); await f.connect('one');
  let started = false;
  f.bridge.backend.run = async (_entry, signal) => {
    started = true;
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { state: 'failed' };
  };
  const transport = f.options.get('one');
  for (let i = 0; i < 12; i++) await transport.onMessage(inbound(`event-${i}`));
  await until(() => started);
  await assert.rejects(transport.onMessage(inbound('overflow')), { code: 'BUSY' });
  await f.bridge.action('connection.pause', { id: 'one' });
  assert.equal(f.bridge.snapshot().channels[0].pendingMessages, 12);
  assert.deepEqual(f.sends, []);
});

test('an ambiguous outbound failure is recorded and never retried', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  const create = f.bridge.create;
  let attempts = 0;
  f.bridge.create = (...args) => ({
    ...create(...args),
    async send() { attempts++; throw new Error('socket closed after send'); },
  });
  await f.bridge.initialize(); await f.connect('one');
  await f.options.get('one').onMessage(inbound('one'));
  await until(() => f.bridge.snapshot().channels[0].uncertainReplies === 1);
  await f.options.get('one').onMessage(inbound('one'));
  await tick();
  assert.equal(attempts, 1);
});

test('a safely deferred reply does not stop another user receiving replies', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  const create = f.bridge.create;
  let refusable = true;
  let deferred;
  f.bridge.create = (...args) => {
    const transport = create(...args);
    return { ...transport, async send(message, text) {
      if (message.senderId === 'alice' && refusable) {
        deferred = true;
        throw Object.assign(new Error('client is offline'), { kind: 'retry' });
      }
      await transport.send(message, text);
    } };
  };
  await f.bridge.initialize(); await f.connect('one');
  const client = f.options.get('one');
  await client.onMessage(inbound('deferred'));
  await until(() => deferred);
  await client.onMessage(inbound('later for same sender'));
  await client.onMessage(inbound('ready', { senderId: 'bob' }));
  await until(() => f.sends.length === 1);
  assert.equal(f.sends[0].message.senderId, 'bob');
  assert.ok(!f.sessions.some(entry => entry.message.id === 'later for same sender'));
  refusable = false;
  await new Promise(resolve => setTimeout(resolve, 20));
  await until(() => f.sends.length === 3);
  assert.deepEqual(f.sends.map(({ message }) => message.id), ['ready', 'deferred', 'later for same sender']);
});

test('a stopped receiver never reports connected when saving its credentials fails', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.bridge.initialize(); await f.connect('one');
  f.bridge.accounts.set = async () => { throw new Error('unavailable'); };
  await assert.rejects(f.bridge.action('connection.pause', { id: 'one' }), { code: 'STORAGE_ERROR' });
  assert.equal(f.bridge.snapshot().channels[0].status, 'error');
  assert.equal(f.options.get('one').signal.aborted, true);
});

test('a revoked sender cannot be processed from a mailbox whose pruning failed', async t => {
  const f = fixture(); t.after(() => f.bridge.close());
  await f.bridge.initialize(); await f.connect('one');
  f.options.get('one').setStatus('connecting');
  await f.options.get('one').onMessage(inbound('to-be-revoked'));
  const write = f.bridge.store.write;
  f.bridge.store.write = async () => { throw new Error('unavailable'); };
  await assert.rejects(f.bridge.action('configure', { id: 'one', allowedSenders: ['bob'] }), { code: 'STORAGE_ERROR' });
  f.bridge.store.write = write;
  await f.bridge.action('connection.resume', { id: 'one' });
  await until(() => f.bridge.snapshot().channels[0].pendingMessages === 0);
  assert.deepEqual(f.sessions, []);
  assert.deepEqual(f.sends, []);
});
