import test from 'node:test';
import assert from 'node:assert/strict';
import { WeixinBridge } from '../lib/bridge.js';
import { stateSchema, accountSchema } from '../lib/schemas.js';
import { BridgeError, accountKey, initialState, freshPairingCode, pairingHash, matchesPairingCode, inputKey, messageId } from '../lib/state.js';

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

test('owner-approved WeChat users have distinct sessions, contexts, and input identities', async () => {
  const f = fixture();
  await f.approve('user-a');
  const oldSession = f.bridge.state.users[0].sessionId;
  await f.bridge.initialize();
  await f.approve('user-b');
  const [alice, bob] = f.bridge.state.users;
  assert.equal(alice.sessionId, oldSession);
  assert.notEqual(alice.sessionId, bob.sessionId);
  await f.bridge.receive(raw('same-platform-id', 'user-a', 'A', 'context-a'), f.account().id, f.signal);
  await f.bridge.receive(raw('same-platform-id', 'user-b', 'B', 'context-b'), f.account().id, f.signal);
  await f.bridge.receive(raw('c', 'user-c', 'unapproved'), f.account().id, f.signal);
  assert.equal(f.bridge.state.users.find(user => user.userId === 'user-c').status, 'pending');
  await f.runOnce();
  assert.deepEqual(f.runs.map(({ userId, sessionId, text }) => [userId, sessionId, text]),
    [['user-a', alice.sessionId, 'A'], ['user-b', bob.sessionId, 'B']]);
  assert.equal(new Set(f.runs.map(run => run.id)).size, 2);
  assert.deepEqual(f.sends.slice(-2).map(({ userId, contextToken }) => [userId, contextToken]),
    [['user-a', 'context-a'], ['user-b', 'context-b']]);
});

test('expired pending registrations can be replaced without dropping the approved iLink context', async () => {
  const f = fixture();
  await f.approve('user-a');
  const sessionId = f.bridge.state.users[0].sessionId;
  for (let index = 0; index < 23; index++) {
    await f.bridge.receive(raw('ask', `pending-${index}`), f.account().id, f.signal);
  }
  f.setTime(100000 + 11 * 60 * 1000);
  await f.bridge.receive(raw('ask', 'new-pending'), f.account().id, f.signal);
  assert.equal(f.bridge.state.users.length, 24);
  assert.equal(f.bridge.state.users.find(user => user.userId === 'user-a').sessionId, sessionId);
  assert.equal(f.bridge.state.users.find(user => user.userId === 'new-pending').status, 'pending');
  assert.ok(f.account().contexts.some(context => context.userId === 'user-a'));
});

test('multi-user media, commands, proactive routing, and revocation are scoped to the sender', async () => {
  const f = fixture({
    admitAttachments: async inputs => inputs.map(({ name }) => ({ type: 'text', text: name })),
  });
  await f.approve('user-a');
  await f.approve('user-b');
  const original = Object.fromEntries(f.bridge.state.users.map(user => [user.userId, user.sessionId]));
  const interrupted = [];
  f.backend.interrupt = sessionId => { interrupted.push(sessionId); return true; };
  await f.bridge.sendToSession(original['user-a'], { id: 'before-reset', text: 'Retired session' });
  await f.bridge.receive(raw('stop', 'user-a', '/stop'), f.account().id, f.signal);
  await f.bridge.receive(raw('new', 'user-a', '/new'), f.account().id, f.signal);
  const [alice, bob] = f.bridge.state.users;
  assert.deepEqual(interrupted, [original['user-a']]);
  assert.notEqual(alice.sessionId, original['user-a']);
  assert.equal(bob.sessionId, original['user-b']);
  const media = (id, sender) => ({ ...raw(id, sender, ''), item_list: [
    { type: 2, image_item: { media: { encrypt_query_param: sender } } },
  ] });
  f.client.downloadMedia = async files => {
    const sender = new URL(files[0].urls[0]).searchParams.get('encrypted_query_param');
    return [{ name: `${sender}.txt` }];
  };
  await f.bridge.receive(media('media-a', 'user-a'), f.account().id, f.signal, f.client);
  await f.bridge.receive(media('media-b', 'user-b'), f.account().id, f.signal, f.client);
  await f.runOnce();
  assert.equal(f.sends.some(send => send.text === 'Retired session'), false);
  assert.deepEqual(f.runs.map(({ sessionId, content }) => [sessionId, content[0].text]),
    [[alice.sessionId, 'user-a.txt'], [bob.sessionId, 'user-b.txt']]);
  assert.equal(await f.bridge.sendToSession(original['user-a'], { id: 'old', text: 'past session' }), false);
  await f.bridge.sendToSession(alice.sessionId, { id: 'same-task-id', text: 'A only' });
  await f.bridge.sendToSession(bob.sessionId, { id: 'same-task-id', text: 'B only' });
  await f.bridge.receive(raw('again', 'user-b', 'still approved'), f.account().id, f.signal);
  await f.bridge.action('user.revoke', { userId: 'user-a' }, { user: true });
  assert.equal(f.bridge.isApproved('user-a'), false);
  assert.equal(await f.bridge.sendToSession(alice.sessionId, { id: 'revoked', text: 'refused' }), false);
  assert.equal(f.bridge.state.users[1].sessionId, bob.sessionId);
  assert.deepEqual(f.account().contexts.map(context => context.userId), ['user-b']);
  await f.runOnce();
  assert.equal(f.sends.some(send => send.text === 'A only'), false);
  assert.equal(f.sends.find(send => send.text === 'B only').userId, 'user-b');
  assert.equal(f.runs.at(-1).sessionId, bob.sessionId);
});

test('a full outgoing queue does not prevent a scoped stop command or reject the poll batch', async () => {
  const f = fixture();
  await f.approve();
  const user = f.bridge.state.users[0];
  const interrupted = [];
  f.backend.interrupt = sessionId => { interrupted.push(sessionId); return true; };
  let queued = true;
  for (let index = 0; queued && index < 30; index++) {
    queued = await f.bridge.sendToSession(user.sessionId, { id: `job-${index}`, text: 'scheduled' });
  }
  assert.equal(queued, false);
  await f.bridge.receive(raw('full-stop', user.userId, '/stop'), f.account().id, f.signal);
  assert.deepEqual(interrupted, [user.sessionId]);
  assert.ok(f.bridge.state.seen.includes(inputKey(f.account().id, user.userId, 'full-stop')));
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

test('attachments are durably queued alongside final text and resume after a context restriction', async () => {
  const f = fixture();
  await f.approve();
  const attachment = { name: 'report.pdf', mime: 'application/pdf', data: 'YXJ0aWZhY3Q=' };
  f.backend.run = async () => ({ state: 'completed', text: 'Report attached.', attachments: [attachment] });
  const sends = [];
  f.client.sendMedia = async value => {
    sends.push(value);
    assert.deepEqual(value.file, attachment);
    if (sends.length === 1) throw Object.assign(new Error('restricted'), { kind: 'context' });
  };
  await f.bridge.receive(raw('m2'), f.account().id, f.signal);
  await f.runOnce();
  assert.equal(f.sends.at(-1).text, 'Report attached.');
  assert.equal(f.persisted().outbox[0].state, 'blocked');
  assert.equal(JSON.stringify(f.persisted().outbox[0]).includes(attachment.data), true);
  await f.bridge.setContext(f.account().id, 'wx-owner', 'ctx-fresh');
  await f.bridge.deliver(f.signal);
  assert.equal(sends.length, 2);
  assert.equal(sends[1].clientId, sends[0].clientId);
  assert.equal(f.sends.filter(send => send.text === 'Report attached.').length, 1);
  assert.equal(f.persisted().outbox[0].state, 'sent');
  assert.equal(JSON.stringify(f.persisted().outbox[0]).includes(attachment.data), false);
});

test('WeChat proactive send delivers all four attachments allowed by the Agent tool', async () => {
  const f = fixture();
  await f.approve();
  const user = f.bridge.state.users[0];
  const attachments = [1, 2, 3, 4].map(index => ({ name: `report-${index}.txt`, mime: 'text/plain', data: 'eA==' }));
  const sent = [];
  f.client.sendMedia = async ({ file, userId }) => { sent.push({ file, userId }); };
  assert.equal(await f.bridge.sendToSession(user.sessionId, { id: 'files', text: 'For you.', attachments }), true);
  await f.bridge.deliver(f.signal);
  assert.deepEqual(sent, attachments.map(file => ({ file, userId: user.userId })));
});

test('WeChat clears its typing indicator after finalizing a turn', async () => {
  const f = fixture();
  await f.approve();
  const typing = [];
  f.client.getConfig = async () => ({ typing_ticket: 'ticket' });
  f.client.sendTyping = async args => { typing.push(args); };
  f.backend.run = async () => {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typing[0]?.status, 1);
    return { state: 'completed', text: 'Ready.' };
  };
  await f.bridge.receive(raw('m2'), f.account().id, f.signal);
  await f.runOnce();
  assert.deepEqual(typing.map(({ status, typingTicket, userId }) => [status, typingTicket, userId]),
    [[1, 'ticket', 'wx-owner'], [2, 'ticket', 'wx-owner']]);
  assert.equal(f.sends.at(-1).text, 'Ready.');
});

test('WeChat makes approval visible for the requesting sender and sends one notice per turn', async () => {
  const f = fixture();
  await f.approve('user-a');
  await f.approve('user-b');
  f.sends.length = 0;
  const approvalViews = [];
  f.backend.run = async (_, signal, onUpdate) => {
    await onUpdate({ type: 'approval', pending: true, text: 'private tool arguments' });
    approvalViews.push(f.bridge.snapshot().users.map(user => [user.userId, user.toolApprovalPending]));
    await onUpdate({ type: 'approval', pending: false });
    approvalViews.push(f.bridge.snapshot().users.map(user => user.toolApprovalPending));
    await onUpdate({ type: 'approval', pending: true });
    return { state: 'completed', text: 'Original final reply.' };
  };

  await f.bridge.receive(raw('needs-approval', 'user-a'), f.account().id, f.signal);
  await f.runOnce();

  assert.deepEqual(approvalViews, [[['user-a', true], ['user-b', undefined]], [undefined, undefined]]);
  assert.deepEqual(f.bridge.snapshot().users.map(user => user.toolApprovalPending), [undefined, undefined]);
  assert.equal(f.sends.length, 2);
  assert.ok(f.sends.every(reply => reply.userId === 'user-a'));
  assert.match(f.sends[0].text, /DSH.*批准[\s\S]*消息渠道.*微信/);
  assert.doesNotMatch(f.sends[0].text, /private tool/);
  assert.equal(f.sends[1].text, 'Original final reply.');
});

test('WeChat approval remains visible when the final reply needs the remaining send budget', async () => {
  const f = fixture({ contextBudget: 4 });
  await f.approve();
  f.sends.length = 0;
  let stateWhileWaiting;
  f.backend.run = async (_, signal, onUpdate) => {
    await onUpdate({ type: 'approval', pending: true });
    stateWhileWaiting = f.bridge.snapshot().users[0].toolApprovalPending;
    return { state: 'completed', text: '字'.repeat(6200) };
  };
  await f.bridge.receive(raw('needs-approval'), f.account().id, f.signal);
  await f.runOnce();
  assert.equal(stateWhileWaiting, true);
  assert.equal(f.sends.length, 4);
  assert.ok(f.sends.every(reply => /^字+$/.test(reply.text)));
  assert.equal(f.bridge.state.outbox[0].state, 'sent');
});

test('a WeChat approval notice reserves capacity for the final reply and earlier queued parts', async () => {
  const f = fixture({ contextBudget: 5 });
  await f.approve();
  f.sends.length = 0;
  f.backend.run = async (entry, signal, onUpdate) => {
    await f.bridge.sendToSession(entry.sessionId, { id: 'earlier-tool-output', text: 'Earlier output.' });
    await onUpdate({ type: 'approval', pending: true });
    return { state: 'completed', text: '字'.repeat(6200) };
  };
  await f.bridge.receive(raw('needs-approval'), f.account().id, f.signal);
  await f.runOnce();
  assert.equal(f.sends[0].text, 'Earlier output.');
  assert.equal(f.sends.slice(1).map(reply => reply.text).join(''), '字'.repeat(6200));
  assert.deepEqual(f.bridge.state.outbox.map(item => item.state), ['sent', 'sent']);
});

test('a WeChat approval notice protects the final reply from output queued after approval', async () => {
  const f = fixture({ contextBudget: 5 });
  await f.approve();
  f.sends.length = 0;
  f.backend.run = async (entry, signal, onUpdate) => {
    await onUpdate({ type: 'approval', pending: true });
    await onUpdate({ type: 'approval', pending: false });
    await f.bridge.sendToSession(entry.sessionId, { id: 'tool-output-after-approval', text: 'Extra output.' });
    return { state: 'completed', text: '字'.repeat(6200) };
  };
  await f.bridge.receive(raw('needs-approval'), f.account().id, f.signal);
  await f.runOnce();
  assert.match(f.sends[0].text, /DSH.*批准/);
  assert.equal(f.sends.slice(1).map(reply => reply.text).join(''), '字'.repeat(6200));

  await f.bridge.setContext(f.account().id, 'wx-owner', 'another-context');
  await f.bridge.deliver(f.signal);
  assert.equal(f.sends.at(-1).text, 'Extra output.');
  assert.equal(f.sends.length, 6);
});

test('WeChat does not retry an ambiguous approval notice when resuming the same input', async () => {
  const f = fixture();
  await f.approve();
  await f.bridge.receive(raw('interrupted-approval'), f.account().id, f.signal);
  const stop = new AbortController();
  const attempts = [];
  f.client.sendText = async value => {
    attempts.push(value);
    throw Object.assign(new Error('send outcome unknown'), { kind: 'network' });
  };
  f.backend.run = async (_, signal, onUpdate) => {
    await onUpdate({ type: 'approval', pending: true });
    stop.abort();
    signal.throwIfAborted();
  };
  await f.bridge.work(stop.signal);
  assert.equal(f.persisted().inbox[0].state, 'submitted');
  assert.equal(f.bridge.snapshot().users[0].toolApprovalPending, undefined);

  await f.bridge.initialize();
  f.client.sendText = async value => { attempts.push(value); return { ret: 0 }; };
  f.backend.run = async (_, signal, onUpdate) => {
    await onUpdate({ type: 'approval', pending: true });
    return { state: 'completed', text: 'Final reply after restart.' };
  };
  await f.runOnce();
  assert.equal(attempts.length, 2);
  assert.match(attempts[0].text, /DSH.*批准/);
  assert.equal(attempts[1].text, 'Final reply after restart.');
});

test('opt-in WeChat progress and streamed reply leave only the unsent tail in the final reply', async () => {
  const f = fixture({ deliveryOptions: () => ({ blockStreaming: true, sendProgress: true, sendToolHints: true }) });
  await f.approve();
  const prefix = '文'.repeat(1200);
  f.backend.run = async (entry, signal, onUpdate) => {
    await onUpdate({ type: 'progress', text: 'Working.' });
    await onUpdate({ type: 'tool', text: 'Tool finished.' });
    await onUpdate({ type: 'reasoning', text: 'hidden' });
    await onUpdate({ type: 'delta', text: `  ${prefix.slice(0, 600)}` });
    await onUpdate({ type: 'delta', text: prefix.slice(600) });
    assert.equal(f.sends.at(-1).text, prefix);
    return { state: 'completed', text: prefix + 'Final tail.' };
  };
  await f.bridge.receive(raw('m2'), f.account().id, f.signal);
  await f.runOnce();
  assert.deepEqual(f.sends.slice(1).map(send => send.text), ['Working.', 'Tool finished.', prefix, 'Final tail.']);
});

test('resuming a turn with an ambiguous streamed block sends the final tail only', async () => {
  const f = fixture({ deliveryOptions: () => ({ blockStreaming: true }) });
  await f.approve();
  const prefix = '文'.repeat(1200);
  const shutdown = new AbortController();
  let attempted;
  const sendText = f.client.sendText;
  f.client.sendText = async value => {
    if (value.text !== prefix) return sendText(value);
    attempted = value.clientId;
    throw Object.assign(new Error('connection lost after write'), { kind: 'network' });
  };
  f.backend.run = async (entry, signal, onUpdate) => {
    await onUpdate({ type: 'delta', text: prefix });
    shutdown.abort();
    throw new Error('DSH exited');
  };
  await f.bridge.receive(raw('m2'), f.account().id, f.signal);
  await f.bridge.work(shutdown.signal);
  assert.ok(attempted);
  assert.equal(f.persisted().inbox[0].streamedPrefix, prefix);
  f.client.sendText = sendText;
  f.backend.run = async () => ({ state: 'completed', text: prefix + 'Tail after restart.' });
  await f.bridge.initialize();
  await f.runOnce();
  assert.deepEqual(f.sends.slice(1).map(send => send.text), ['Tail after restart.']);
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

test('a retired WeChat session can send a recovery notice and rotates on /new', async () => {
  const f = fixture(); await f.approve();
  const oldSessionId = f.bridge.state.users[0].sessionId;
  const run = f.backend.run;
  f.backend.isSafe = id => id !== oldSessionId;
  f.backend.run = async entry => {
    if (entry.sessionId === oldSessionId) throw new BridgeError('LEGACY_PRESET', 'Retired preset');
    return run(entry);
  };
  await f.bridge.receive(raw('old'), f.account().id, f.signal);
  await f.runOnce();
  assert.match(f.sends.at(-1).text, /\/new.*标准模式/);
  assert.equal(f.persisted().users[0].sessionId, oldSessionId);
  await f.bridge.receive(raw('rotate', 'wx-owner', '/new'), f.account().id, f.signal);
  await f.bridge.receive(raw('next'), f.account().id, f.signal);
  await f.runOnce();
  assert.equal(f.runs.length, 1);
  assert.notEqual(f.runs[0].sessionId, oldSessionId);
  assert.equal(f.sends.at(-1).text, '这是一条回答。');
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
