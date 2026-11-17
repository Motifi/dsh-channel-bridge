import test from 'node:test';
import assert from 'node:assert/strict';
import { WeixinBridge } from '../lib/bridge.js';
import { stateSchema, accountSchema } from '../lib/schemas.js';
import { accountKey, initialState, freshPairingCode, pairingHash, matchesPairingCode, inputKey, messageId } from '../lib/state.js';

const clone = value => structuredClone(value);
const raw = (id = 'm1', user = 'wx-owner', text = '你好', token = `ctx-${id}`) => ({
  message_type: 1, message_id: id, from_user_id: user, context_token: token,
  item_list: [{ type: 1, text_item: { text } }], create_time_ms: 100000,
});

function fixture(overrides = {}) {
  let clock = 100000;
  let account = { token: 'secret-bot-token', baseUrl: 'https://ilinkai.weixin.qq.com', botId: 'bot-1', userId: 'scan-user', contexts: [] };
  account.id = accountKey(account);
  let persisted = { ...initialState(), accountKey: account.id, enabled: true };
  const writes = [], sends = [], runs = [], configs = [];
  let accountTail = Promise.resolve();
  const accounts = {
    get: async () => clone(account),
    set: async value => { account = accountSchema.parse(value); },
    delete: async () => { account = null; },
    update(change) {
      const result = accountTail.then(() => { if (account) account = accountSchema.parse(change(clone(account))); return clone(account); });
      accountTail = result.catch(() => {}); return result;
    },
  };
  const store = { read: () => clone(persisted), write: async state => { persisted = stateSchema.parse(state); writes.push(clone(state)); } };
  const backend = {
    model: () => ({ provider: 'test', model: 'test-model' }),
    run: async entry => { runs.push(clone(entry)); return { state: 'completed', text: '这是一条回答。' }; },
    stopWork: async () => {}, isSafe: () => true,
  };
  const client = {
    sendText: async value => { sends.push(value); return { ret: 0 }; },
    getConfig: async value => { configs.push(value); return { ret: 0 }; },
    getUpdates: async () => ({ ret: 0, msgs: [] }),
    fetchQr: async () => ({ qrcodeId: 'qr-id', qrContent: 'https://weixin.qq.com/mock-login' }),
    pollQr: async () => ({ status: 'wait' }),
  };
  const bridge = new WeixinBridge({ store, accounts, backend, qrCode: async () => 'data:image/png;base64,TEST',
    clientFactory: () => client, workspaceDir: '/isolated/weixin', now: () => clock, ...overrides });
  bridge.state = clone(persisted);
  // Unit tests drive the public loops explicitly; never start real polling.
  bridge.startChannel = () => {};
  const signal = new AbortController().signal;
  const code = () => sends.at(-1)?.text.match(/配对码：(\d{8})/)?.[1];
  const approve = async (user = 'wx-owner') => {
    await bridge.receive(raw(`pair-${user}`, user), account.id, signal);
    const received = code(); assert.match(received, /^\d{8}$/);
    await bridge.action('user.approve', { userId: user, code: received }, { user: true });
    return received;
  };
  const runOnce = async () => {
    const stop = new AbortController(); bridge.wait = async () => stop.abort();
    await bridge.work(stop.signal);
  };
  return { bridge, accounts, store, backend, client, writes, sends, runs, configs, signal, code, approve, runOnce,
    account: () => account, persisted: () => clone(persisted), setTime: value => { clock = value; } };
}

test('cryptographic pairing generator emits exactly the eight digits accepted by the UI', () => {
  for (let n = 0; n < 200; n++) {
    const code = freshPairingCode(); assert.match(code, /^\d{8}$/);
    const user = { userId: 'me', pairingHash: pairingHash('me', code) };
    assert.equal(matchesPairingCode(user, code), true);
    assert.equal(matchesPairingCode(user, `${code.slice(0, 7)}${(Number(code[7]) + 1) % 10}`), false);
  }
});

test('unknown sender receives a hashed, expiring pairing challenge and never reaches the model', async () => {
  const f = fixture(); await f.bridge.receive(raw(), f.account().id, f.signal);
  assert.equal(f.runs.length, 0); assert.equal(f.bridge.state.inbox.length, 0);
  assert.equal(f.bridge.state.users[0].status, 'pending');
  const code = f.code(); assert.match(code, /^\d{8}$/);
  assert.equal(JSON.stringify(f.bridge.state).includes(code), false);
  const view = JSON.stringify(f.bridge.snapshot());
  for (const secret of [f.account().token, 'ctx-m1', f.bridge.state.users[0].pairingHash, code]) assert.equal(view.includes(secret), false);
  assert.equal(f.account().contexts[0].count, 1);
});

test('approval is user-only, requires the actual generated code, and does not replay the preapproval prompt', async () => {
  const f = fixture(); await f.bridge.receive(raw(), f.account().id, f.signal);
  await assert.rejects(f.bridge.action('user.approve', { userId: 'wx-owner', code: f.code() }), { code: 'FORBIDDEN' });
  await f.bridge.action('user.approve', { userId: 'wx-owner', code: f.code() }, { user: true });
  assert.equal(f.bridge.state.inbox.length, 0);
  await f.bridge.receive(raw('m2'), f.account().id, f.signal);
  assert.equal(f.bridge.state.inbox.length, 1);
  await f.runOnce(); assert.equal(f.runs.length, 1); assert.equal(f.runs[0].text, '你好');
  assert.equal(f.sends.at(-1).text, '这是一条回答。');
});

test('five wrong pairing attempts invalidate the code; a new inbound message issues a new challenge', async () => {
  const f = fixture(); await f.bridge.receive(raw(), f.account().id, f.signal);
  const original = f.code(); const wrong = original === '00000000' ? '11111111' : '00000000';
  for (let n = 0; n < 5; n++) await assert.rejects(f.bridge.action('user.approve', { userId: 'wx-owner', code: wrong }, { user: true }), { code: 'PAIRING_CODE_INVALID' });
  await assert.rejects(f.bridge.action('user.approve', { userId: 'wx-owner', code: original }, { user: true }), { code: 'PAIRING_CODE_EXPIRED' });
  await f.bridge.receive(raw('m2'), f.account().id, f.signal);
  assert.equal(f.bridge.state.users[0].pairingAttempts, 0);
  await f.bridge.action('user.approve', { userId: 'wx-owner', code: f.code() }, { user: true });
  assert.equal(f.bridge.state.users[0].status, 'approved');
});

test('only one approved user is allowed and other senders are ignored after binding', async () => {
  const f = fixture();
  await f.bridge.receive(raw('a', 'user-a'), f.account().id, f.signal); const a = f.code();
  await f.bridge.receive(raw('b', 'user-b'), f.account().id, f.signal); const b = f.code();
  await f.bridge.action('user.approve', { userId: 'user-a', code: a }, { user: true });
  await assert.rejects(f.bridge.action('user.approve', { userId: 'user-b', code: b }, { user: true }), { code: 'ALREADY_APPROVED' });
  const count = f.sends.length;
  await f.bridge.receive(raw('c', 'user-c'), f.account().id, f.signal);
  assert.equal(f.sends.length, count); assert.equal(f.runs.length, 0);
  assert.equal(f.bridge.state.users.some(user => user.userId === 'user-c'), false);
});

test('duplicate input is durably deduplicated before it can be enqueued a second time', async () => {
  const f = fixture(); await f.approve();
  await f.bridge.receive(raw('m2'), f.account().id, f.signal);
  await f.bridge.receive(raw('m2'), f.account().id, f.signal);
  assert.equal(f.bridge.state.inbox.length, 1);
  await f.runOnce(); await f.runOnce(); assert.equal(f.runs.length, 1);
  const stored = f.persisted().inbox[0];
  assert.equal(stored.id, inputKey(f.account().id, 'wx-owner', 'm2'));
  assert.equal(stored.messageId, messageId(stored.id));
});

test('group, media-only, bot and missing-context inputs do not reach the model or pairing store', async () => {
  const f = fixture();
  await f.bridge.receive(raw('room', 'x@chatroom'), f.account().id, f.signal);
  await f.bridge.receive({ ...raw('bot'), message_type: 2 }, f.account().id, f.signal);
  await f.bridge.receive({ ...raw('no-context'), context_token: '' }, f.account().id, f.signal);
  await f.bridge.receive({ ...raw('image'), item_list: [{ type: 2, image_item: {} }] }, f.account().id, f.signal);
  assert.equal(f.bridge.state.users.length, 0); assert.equal(f.runs.length, 0);
});

test('oversized input is not sent to the model and produces a bounded explanatory reply', async () => {
  const f = fixture(); await f.approve();
  await f.bridge.receive(raw('long', 'wx-owner', '中'.repeat(12001)), f.account().id, f.signal);
  assert.equal(f.bridge.state.inbox.length, 0); assert.equal(f.bridge.state.outbox.length, 1);
  await f.bridge.deliver(f.signal); assert.match(f.sends.at(-1).text, /12000/);
});

test('normal work stores the final reply and advances acknowledged parts exactly once', async () => {
  const f = fixture(); await f.approve(); await f.bridge.receive(raw('m2'), f.account().id, f.signal);
  await f.runOnce();
  assert.equal(f.bridge.state.outbox[0].state, 'sent'); assert.equal(f.bridge.state.outbox[0].nextPart, 1);
  const before = f.sends.length; await f.bridge.deliver(f.signal); assert.equal(f.sends.length, before);
  assert.equal(f.bridge.state.inbox[0].state, 'completed');
});

test('context-restricted reply waits for fresh inbound context without rerunning the model', async () => {
  const f = fixture(); await f.approve(); await f.bridge.receive(raw('m2'), f.account().id, f.signal);
  let reject = true;
  f.client.sendText = async value => { f.sends.push(value); if (reject) throw Object.assign(new Error('restricted'), { kind: 'context' }); return { ret: 0 }; };
  await f.runOnce(); assert.equal(f.bridge.state.outbox[0].state, 'blocked');
  const first = f.sends.at(-1).clientId; const count = f.sends.length;
  await f.bridge.deliver(f.signal); assert.equal(f.sends.length, count);
  reject = false; await f.bridge.setContext(f.account().id, 'wx-owner', 'fresh-context');
  await f.bridge.deliver(f.signal);
  assert.equal(f.bridge.state.outbox[0].state, 'sent'); assert.equal(f.sends.at(-1).clientId, first);
  assert.equal(f.runs.length, 1);
});

test('ambiguous sends are marked uncertain and never automatically replayed', async () => {
  const f = fixture(); await f.approve(); await f.bridge.receive(raw('m2'), f.account().id, f.signal);
  f.client.sendText = async value => { f.sends.push(value); throw Object.assign(new Error('hidden token'), { kind: 'network', retryable: true }); };
  await f.runOnce(); assert.equal(f.bridge.state.outbox[0].state, 'uncertain');
  const count = f.sends.length; await f.bridge.setContext(f.account().id, 'wx-owner', 'ctx-fresh'); await f.bridge.deliver(f.signal);
  assert.equal(f.sends.length, count); assert.equal(f.bridge.snapshot().failedReplies, 1);
  assert.equal(JSON.stringify(f.bridge.snapshot()).includes('hidden token'), false);
});

test('a multipart reply does not resend completed parts after context restriction', async () => {
  const f = fixture(); await f.approve();
  f.backend.run = async entry => { f.runs.push(entry); return { state: 'completed', text: '文'.repeat(2500) }; };
  await f.bridge.receive(raw('m2'), f.account().id, f.signal);
  let count = 0;
  f.client.sendText = async value => { f.sends.push(value); if (++count === 2) throw Object.assign(new Error('restricted'), { kind: 'context' }); };
  await f.runOnce(); assert.equal(f.bridge.state.outbox[0].nextPart, 1);
  const firstId = f.sends.at(-2).clientId;
  await f.bridge.setContext(f.account().id, 'wx-owner', 'ctx-fresh'); await f.bridge.deliver(f.signal);
  assert.equal(f.sends.slice(-2).some(send => send.clientId === firstId), false);
  assert.equal(f.bridge.state.outbox[0].state, 'sent');
});

test('stale context attempts getconfig refresh before sending', async () => {
  const f = fixture(); await f.approve(); await f.bridge.receive(raw('m2'), f.account().id, f.signal);
  f.setTime(200000); f.client.getConfig = async value => { f.configs.push(value); return { context_token: 'refreshed-context' }; };
  await f.runOnce(); assert.equal(f.configs.length, 1); assert.equal(f.sends.at(-1).contextToken, 'refreshed-context');
});

test('local safety budget stops excess API submissions', async () => {
  const f = fixture({ contextBudget: 1 }); await f.approve();
  await assert.rejects(f.bridge.sendRaw('wx-owner', 'extra', 'same-id', f.signal), error => error.kind === 'context');
  assert.equal(f.sends.length, 1);
});

test('no reply is forwarded from a contaminated DSH conversation; the next message gets a fresh mapping', async () => {
  const f = fixture(); await f.approve(); const old = f.bridge.state.users[0].sessionId;
  await f.bridge.receive(raw('m2'), f.account().id, f.signal);
  f.backend.run = async () => ({ state: 'failed', reason: 'contaminated', text: 'PRIVATE' });
  await f.runOnce();
  assert.notEqual(f.bridge.state.users[0].sessionId, old);
  assert.equal(f.sends.some(send => send.text.includes('PRIVATE')), false);
  assert.match(f.sends.at(-1).text, /保护隐私/);
});

test('revoke cancels queues and context; disconnect forgets access, not DSH history', async () => {
  const f = fixture(); await f.approve(); await f.bridge.receive(raw('m2'), f.account().id, f.signal);
  await f.bridge.action('user.revoke', { userId: 'wx-owner' }, { user: true });
  assert.equal(f.bridge.state.users[0].status, 'revoked'); assert.equal(f.bridge.state.inbox[0].state, 'failed');
  assert.equal(f.account().contexts.length, 0);
  await f.bridge.action('connection.disconnect');
  assert.equal(f.account(), null); assert.equal(f.bridge.state.users.length, 0); assert.equal(f.bridge.state.enabled, false);
  assert.equal(f.bridge.snapshot().connectionStatus, 'disconnected');
});

test('cursor acknowledgement follows durable accepted input, not the other way around', async () => {
  const f = fixture(); await f.approve(); const start = f.writes.length;
  const stop = new AbortController();
  f.bridge.wait = async () => stop.abort();
  f.client.getUpdates = async () => ({ get_updates_buf: 'new-cursor', msgs: [raw('m2')] });
  await f.bridge.poll(stop.signal);
  const changes = f.writes.slice(start);
  assert.equal(changes.findIndex(state => state.inbox.length === 1) < changes.findIndex(state => state.cursor === 'new-cursor'), true);
});

test('only the approved WeChat sender can submit media and only DSH attachment references are persisted', async () => {
  const admissions = [];
  const content = [{ type: 'image', attachment: { id: 'image-in-dsh' } }];
  const f = fixture({ admitAttachments: async attachments => { admissions.push(attachments); return content; } });
  const media = { type: 2, image_item: { media: { encrypt_query_param: 'mock-query' } } };
  const pure = (id, sender) => ({ ...raw(id, sender), item_list: [media] });
  let downloads = 0;
  f.client.downloadMedia = async () => { downloads++; return [{ name: 'image.jpg', data: 'eA==', mediaType: 'image/jpeg' }]; };
  await f.bridge.receive(pure('before', 'wx-owner'), f.account().id, f.signal, f.client);
  assert.deepEqual(f.sends, []);
  await f.approve();
  await f.bridge.receive(pure('other', 'unapproved'), f.account().id, f.signal, f.client);
  await f.bridge.receive(pure('picture', 'wx-owner'), f.account().id, f.signal, f.client);
  await f.bridge.receive(pure('picture', 'wx-owner'), f.account().id, f.signal, f.client);
  assert.equal(downloads, 1);
  assert.equal(admissions.length, 1);
  assert.deepEqual(f.persisted().inbox[0].content, content);
  assert.doesNotMatch(JSON.stringify(f.persisted()), /mock-query|eA==/);
  await f.runOnce();
  assert.deepEqual(f.runs[0].content, content);
});

test('failed input persistence leaves the server cursor unacknowledged', async () => {
  const f = fixture(); await f.approve(); const stop = new AbortController();
  const write = f.store.write; f.store.write = async state => { if (state.inbox.length) throw new Error('disk failed'); return write(state); };
  f.bridge.wait = async () => stop.abort();
  f.client.getUpdates = async () => ({ get_updates_buf: 'must-not-ack', msgs: [raw('m2')] });
  await assert.rejects(f.bridge.poll(stop.signal), /disk failed/);
  assert.equal(f.bridge.state.cursor, ''); assert.equal(f.bridge.state.inbox.length, 0);
});

test('startup does not replay a send whose outcome was unknown at shutdown', async () => {
  const f = fixture(); await f.approve();
  await f.bridge.mutate(state => {
    state.enabled = false;
    f.bridge.addOutput(state, { id: 'reply-recover', userId: 'wx-owner', key: f.account().id, text: 'reply' });
    state.outbox[0].state = 'sending';
  });
  await f.bridge.initialize();
  assert.equal(f.bridge.state.outbox[0].state, 'uncertain');
  assert.equal(f.bridge.snapshot().connectionStatus, 'paused');
});

test('authority-changing actions cannot be called through the agent surface', async () => {
  const f = fixture();
  for (const action of ['login.start', 'login.verify', 'login.cancel', 'connection.resume', 'user.approve', 'user.revoke']) {
    await assert.rejects(f.bridge.action(action, {}), { code: 'FORBIDDEN' });
  }
});

test('cancelled login never overwrites the saved account with late confirmation', async () => {
  const f = fixture(); let resolvePoll;
  f.client.pollQr = () => new Promise(resolve => { resolvePoll = resolve; });
  await f.bridge.action('login.start', { force: true }, { user: true });
  await Promise.resolve();
  const id = f.bridge.login.id;
  await f.bridge.action('login.cancel', { loginId: id }, { user: true });
  resolvePoll({ status: 'confirmed', bot_token: 'late-secret', ilink_bot_id: 'new-bot', ilink_user_id: 'new-user' });
  await Promise.allSettled([...f.bridge.tasks]);
  assert.equal(f.account().token, 'secret-bot-token');
  assert.equal(f.bridge.snapshot().login.qrDataUrl, '');
});

test('a batch with more than 200 entries processes its last message before cursor acknowledgement', async () => {
  const f = fixture(); await f.approve(); const stop = new AbortController();
  f.bridge.wait = async () => stop.abort();
  f.client.getUpdates = async () => ({ get_updates_buf: 'batch-201', msgs: [
    ...Array.from({ length: 200 }, (_, n) => ({ ...raw(`bot-${n}`), message_type: 2 })), raw('last-201'),
  ] });
  await f.bridge.poll(stop.signal);
  assert.equal(f.bridge.state.inbox.length, 1);
  assert.equal(f.bridge.state.inbox[0].id, inputKey(f.account().id, 'wx-owner', 'last-201'));
  assert.equal(f.bridge.state.cursor, 'batch-201');
});

test('malformed message batches are refused without advancing the cursor', async () => {
  const f = fixture(); const stop = new AbortController();
  f.client.getUpdates = async () => ({ get_updates_buf: 'bad', msgs: { not: 'an array' } });
  await assert.rejects(f.bridge.poll(stop.signal), { code: 'INTERNAL_ERROR' });
  assert.equal(f.bridge.state.cursor, '');
});

test('an in-flight accepted answer has a reserved output slot even when notices fill the queue', async () => {
  const f = fixture(); await f.approve(); await f.bridge.receive(raw('m2'), f.account().id, f.signal);
  f.backend.run = async () => {
    await f.bridge.mutate(state => {
      for (let n = 0; n < 24; n++) f.bridge.addOutput(state, { id: `notice-${n}`, userId: 'wx-owner', key: f.account().id, text: 'notice' });
    });
    return { state: 'completed', text: 'THE ACTUAL ANSWER' };
  };
  f.client.sendText = async () => { throw Object.assign(new Error('restricted'), { kind: 'context' }); };
  await f.runOnce();
  assert.equal(f.bridge.state.outbox.length, 25);
  assert.equal(f.bridge.state.outbox.some(item => item.parts.includes('THE ACTUAL ANSWER')), true);
  assert.equal(f.bridge.state.inbox[0].state, 'completed');
});

test('worker backpressure leaves queued input recoverable instead of starting another model request', async () => {
  const f = fixture(); await f.approve(); await f.bridge.receive(raw('m2'), f.account().id, f.signal);
  await f.bridge.mutate(state => {
    for (let n = 0; n < 24; n++) f.bridge.addOutput(state, { id: `notice-${n}`, userId: 'wx-owner', key: f.account().id, text: 'notice' });
  });
  f.client.sendText = async () => { throw Object.assign(new Error('restricted'), { kind: 'context' }); };
  await f.runOnce();
  assert.equal(f.runs.length, 0); assert.equal(f.bridge.state.inbox[0].state, 'queued');
});
