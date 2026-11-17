import assert from 'node:assert/strict';
import test from 'node:test';
import { initialProjection, applyProjection, completionOf, contentFingerprint } from '../lib/projection.js';
import { hash, MAX_REPLY_CHARS, PRESET_ID } from '../lib/state.js';

// Fixtures follow the installed DSH 0.2.2-rc.3 public SessionEvent/Inbox
// vocabulary. They do not import the runtime, mount a profile, or call a model.
const SESSION_ID = `wxbridge-${'a'.repeat(32)}`;
const header = { id: SESSION_ID, cwd: '/isolated-wechat', agentPreset: PRESET_ID };
const idFor = (name) => `wxbridge-in-${hash(name).slice(0, 48)}`;
let sequence = 0;
function event(type, data, extra = {}) {
  return { type, seq: sequence++, time: 1_800_000_000_000 + sequence, data, ...extra };
}
function user(name = 'one', text = `inbound ${name}`) {
  return { id: idFor(name), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] };
}
function splice(inserted, { target = 'next-turn', start = 0, removedCount = 0, outcome } = {}) {
  return event('agent/inbox/spliced', {
    target, start, ...(removedCount ? { removedCount } : {}), inserted,
    ...(outcome ? { outcome } : {}),
  });
}
function assistant(text, turn = 1, options = {}) {
  return event('assistant/message', {
    turn, step: 1, stream: [],
    message: { id: 'assistant-id', role: 'assistant', source: { kind: 'model', provider: 'fake', model: 'fake' }, content: [{ type: 'text', text }] },
    ...options,
  }, { surfaceOp: 'append' });
}
const start = (turn = 1) => event('turn/start', { turn });
const end = (turn = 1, kind = 'completed') => event('turn/end', { turn, reason: { kind } });
const accepted = (message) => event('user/message', message, { surfaceOp: 'append' });
const fold = (state, ...events) => events.reduce(applyProjection, state);
function running(message = user(), turn = 1) {
  return fold(initialProjection(header), splice([message]), start(turn), splice([], { removedCount: 1 }), accepted(message));
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

function assertFailed(state, id, reason) {
  const record = completionOf(state, id);
  assert.equal(record?.state, 'failed');
  assert.equal(record.text, '');
  assert.equal(record.reason, reason);
}

test('initial projection scopes itself to the dedicated session namespace', () => {
  const state = initialProjection(header);
  assert.equal(state.eligible, true);
  assert.equal(state.contaminated, false);
  assert.equal(state.turn, 0);
  assert.deepEqual(state.active, []);
  assert.deepEqual(state.records, []);
  assert.deepEqual(state.inbox, { 'next-turn': [], 'next-step': [] });
  assert.equal(initialProjection().eligible, true);
  assert.equal(initialProjection({ id: 'normal-web-session' }).eligible, false);
  assert.equal(initialProjection({ id: `${SESSION_ID}-extra` }).eligible, false);
});

test('events from unrelated sessions are complete no-ops for an ineligible cell', () => {
  const state = freeze(initialProjection({ id: 'ordinary-session' }));
  for (const input of [splice([user()]), start(), accepted(user()), assistant('do not disclose'), end()]) {
    assert.equal(applyProjection(state, input), state);
  }
  assert.equal(completionOf(state, user().id), undefined);
});

test('folds are immutable and unrelated event types preserve reference identity', () => {
  const previous = freeze(initialProjection(header));
  const insertion = freeze(splice([user()]));
  const snapshot = structuredClone(previous);
  const next = applyProjection(previous, insertion);
  assert.notEqual(next, previous);
  assert.deepEqual(previous, snapshot);
  assert.equal(previous.inbox['next-turn'].length, 0);
  assert.equal(next.inbox['next-turn'][0], user().id);
  assert.equal(applyProjection(next, event('tool/result', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'PRIVATE_TOOL_LOG' }] } })), next);
  assert.equal(applyProjection(next, event('assistant/attempt', { turn: 1, step: 1, stream: [] })), next);
});

for (const target of ['next-turn', 'next-step']) {
  test(`durable ${target} insertions produce queued records and replay after JSON checkpoints`, () => {
    const message = user(target);
    const queued = fold(initialProjection(header), splice([message], { target }));
    const restored = JSON.parse(JSON.stringify(queued));
    assert.equal(restored.inbox[target][0], message.id);
    assert.equal(completionOf(restored, message.id).state, 'queued');
    assert.equal(completionOf(restored, message.id).text, '');
    assert.equal(restored.contaminated, false);
    const completed = fold(restored, start(3), splice([], { target, removedCount: 1 }), accepted(message), assistant('restored reply', 3), end(3));
    assert.equal(completionOf(completed, message.id).state, 'completed');
    assert.equal(completionOf(completed, message.id).turn, 3);
    assert.equal(completionOf(completed, message.id).text, 'restored reply');
  });
}

test('claiming is not cancellation and does not reset a queued message receipt', () => {
  const message = user();
  const queued = fold(initialProjection(header), splice([message]));
  const claimed = fold(queued, start(), splice([], { removedCount: 1 }));
  assert.deepEqual(claimed.inbox['next-turn'], []);
  assert.equal(completionOf(claimed, message.id).state, 'queued');
  const admitted = applyProjection(claimed, accepted(message));
  assert.equal(completionOf(admitted, message.id).state, 'running');
  assert.equal(completionOf(admitted, message.id).turn, 1);
  assert.deepEqual(admitted.active, [message.id]);
});

test('queue cancellation fails only the removed receipt without contaminating valid remaining work', () => {
  const first = user('first');
  const second = user('second');
  const state = fold(initialProjection(header), splice([first, second]), splice([], { removedCount: 1, outcome: 'canceled' }));
  assertFailed(state, first.id, 'canceled');
  assert.equal(completionOf(state, second.id).state, 'queued');
  assert.equal(state.contaminated, false);
  assert.deepEqual(state.inbox['next-turn'], [second.id]);
});

test('normalized splice positions preserve the independent next-turn and next-step queues', () => {
  const first = user('first');
  const middle = user('middle');
  const last = user('last');
  const steering = user('steering');
  const state = fold(initialProjection(header),
    splice([first, last]), splice([middle], { start: 1 }), splice([steering], { target: 'next-step' }),
    splice([], { start: 2, removedCount: 1, outcome: 'canceled' }));
  assert.deepEqual(state.inbox['next-turn'], [first.id, middle.id]);
  assert.deepEqual(state.inbox['next-step'], [steering.id]);
  assertFailed(state, last.id, 'canceled');
});

test('only the final assistant text is returned, excluding reasoning, tool results, and stream logs', () => {
  const message = user();
  const state = fold(running(message),
    assistant('intermediate explanation'),
    event('tool/call', { turn: 1, step: 1, name: 'fake-tool', arguments: 'PRIVATE_TOOL_ARGUMENTS' }),
    event('tool/result', { turn: 1, step: 1, message: { role: 'tool', content: [{ type: 'text', text: 'PRIVATE_TOOL_LOG' }] } }),
    assistant('', 1, {
      stream: [{ type: 'reasoning-chunks', texts: ['PRIVATE_REASONING_STREAM'] }],
      message: { role: 'assistant', source: { kind: 'model', provider: 'fake', model: 'fake' }, content: [
        { type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text: ' final answer ' },
        { type: 'image', attachment: { name: 'PRIVATE_IMAGE' } }, { type: 'text', text: 'second paragraph' },
      ] },
    }), end());
  const completion = completionOf(state, message.id);
  assert.equal(completion.state, 'completed');
  assert.equal(completion.text, 'final answer \nsecond paragraph');
  assert.equal(JSON.stringify(completion).includes('PRIVATE_'), false);
});

test('a tool-call assistant message is not a final user-visible answer', () => {
  const message = user();
  const state = fold(running(message), assistant('not final'), assistant('', 1, {
    message: { role: 'assistant', content: [
      { type: 'text', text: 'I will run a tool' },
      { type: 'tool-call', id: 'call', name: 'tool', arguments: 'PRIVATE_ARGS' },
    ] },
  }), end());
  assertFailed(state, message.id, 'completed');
});

test('interrupted or reasoning-only assistant messages clear earlier answer candidates', () => {
  for (const input of [
    assistant('partial answer', 1, { interrupted: true }),
    assistant('', 1, { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }] } }),
    assistant('   '),
  ]) {
    const message = user();
    const state = fold(running(message), assistant('stale candidate'), input, end());
    assertFailed(state, message.id, 'completed');
  }
});

test('assistant and ending events are associated with the exact active turn', () => {
  const message = user();
  const pending = fold(running(message, 4), assistant('wrong old turn', 3), end(3), assistant('right turn', 4), assistant('wrong future turn', 5));
  assert.equal(completionOf(pending, message.id).state, 'running');
  const done = applyProjection(pending, end(4));
  assert.equal(completionOf(done, message.id).text, 'right turn');
  assert.deepEqual(done.active, []);
  assert.equal(done.candidate, '');
});

test('each later turn starts with an empty candidate and cannot reuse another message answer', () => {
  const first = user('first');
  const second = user('second');
  const done = fold(running(first), assistant('first answer'), end());
  const secondDone = fold(done, splice([second]), start(2), splice([], { removedCount: 1 }), accepted(second), end(2));
  assert.equal(completionOf(secondDone, first.id).text, 'first answer');
  assertFailed(secondDone, second.id, 'completed');
});

test('assistant output without an active WeChat input is ignored', () => {
  const state = fold(initialProjection(header), start(), assistant('unrelated answer'), end());
  assert.equal(state.candidate, '');
  assert.deepEqual(state.records, []);
});

test('multiple admitted bridge inputs settle only in their shared active turn', () => {
  const first = user('first');
  const second = user('second');
  const state = fold(running(first), accepted(second), accepted(first), assistant('shared turn answer'), end());
  assert.equal(state.records.length, 2);
  for (const id of [first.id, second.id]) {
    assert.equal(completionOf(state, id).state, 'completed');
    assert.equal(completionOf(state, id).turn, 1);
    assert.equal(completionOf(state, id).text, 'shared turn answer');
  }
});

for (const reason of ['aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked']) {
  test(`turn ending ${reason} never forwards an otherwise available text candidate`, () => {
    const message = user(reason);
    assertFailed(fold(running(message), assistant('must not send'), end(1, reason)), message.id, reason);
  });
}

test('runtime-context user messages and compaction replacements are not fresh Web submissions', () => {
  const message = user();
  const state = fold(running(message),
    accepted({ id: 'runtime-id', role: 'user', source: { kind: 'runtime-context', sections: [] }, content: [{ type: 'text', text: 'runtime facts' }] }),
    event('user/message', { id: 'compacted-user', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'summary' }] }, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 } }),
    assistant('valid answer'), end());
  assert.equal(state.contaminated, false);
  assert.equal(completionOf(state, message.id).text, 'valid answer');
  assert.equal(state.records.length, 1);
});

for (const via of ['queue', 'accepted']) {
  test(`ordinary Web input via ${via} permanently contaminates the dedicated session`, () => {
    const message = user();
    const foreign = { id: 'ordinary-web-input', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE_WEB_PROMPT' }] };
    const dirty = applyProjection(running(message), via === 'queue' ? splice([foreign]) : accepted(foreign));
    assert.equal(dirty.contaminated, true);
    const cleared = via === 'queue' ? applyProjection(dirty, splice([], { removedCount: 1, outcome: 'canceled' })) : dirty;
    const afterTurn = fold(cleared, assistant('answer containing PRIVATE_WEB_PROMPT'), end(), start(2));
    assert.equal(afterTurn.contaminated, true);
    assertFailed(afterTurn, message.id, 'contaminated');
    assertFailed(afterTurn, idFor('never-enqueued'), 'contaminated');
    const checkpoint = JSON.parse(JSON.stringify(afterTurn));
    assertFailed(checkpoint, message.id, 'contaminated');
  });
}

for (const target of ['next-turn', 'next-step']) {
  test(`SECURITY: Web updateQueue keeping a bridge id but changing ${target} content contaminates permanently`, () => {
    const original = user('edited', 'approved original WeChat text');
    const queued = fold(initialProjection(header), splice([original], { target }));
    // Actual public Inbox.replace() produces this canceled replacement splice.
    // The Web updateQueue path spreads the old message, preserving id/source.
    const webEdit = { ...original, content: [{ type: 'text', text: 'PRIVATE_WEB_REPLACEMENT' }] };
    const edited = applyProjection(queued, splice([webEdit], { target, removedCount: 1, outcome: 'canceled' }));
    assert.equal(edited.contaminated, true, 'an id prefix is not sufficient proof after a queue edit');
    const replayed = fold(JSON.parse(JSON.stringify(edited)), start(), splice([], { target, removedCount: 1 }), accepted(webEdit), assistant('must not forward PRIVATE_WEB_REPLACEMENT'), end());
    assertFailed(replayed, original.id, 'contaminated');
  });
}

test('content fingerprints bind the exact durable content and survive checkpoint round trips', () => {
  const message = freeze(user('fingerprinted', 'original 😀 input'));
  const fingerprint = contentFingerprint(message);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint, hash(JSON.stringify(message.content)));
  assert.equal(contentFingerprint(structuredClone(message)), fingerprint);
  assert.notEqual(contentFingerprint({ ...message, content: [{ type: 'text', text: 'changed' }] }), fingerprint);
  const state = JSON.parse(JSON.stringify(fold(initialProjection(header), splice([message]))));
  assert.equal(completionOf(state, message.id).fingerprint, fingerprint);
});

test('unchanged canceled-then-reinserted receipts return to queued for same-id recovery', () => {
  const message = user('reawaken');
  const canceled = fold(initialProjection(header), splice([message]), splice([], { removedCount: 1, outcome: 'canceled' }));
  assertFailed(canceled, message.id, 'canceled');
  const requeued = applyProjection(canceled, splice([structuredClone(message)]));
  assert.equal(requeued.contaminated, false);
  assert.equal(completionOf(requeued, message.id).state, 'queued');
  assert.equal(completionOf(requeued, message.id).fingerprint, contentFingerprint(message));
  assert.equal(requeued.records.length, 1);
});

test('SECURITY: changed accepted content cannot bypass a previously queued fingerprint', () => {
  const original = user('accepted-edit', 'original input');
  const queued = fold(initialProjection(header), splice([original]));
  const changed = { ...original, content: [{ type: 'text', text: 'PRIVATE_CHANGED_INPUT' }] };
  const state = fold(queued, start(), splice([], { removedCount: 1 }), accepted(changed), assistant('unsafe answer'), end());
  assert.equal(state.contaminated, true);
  assertFailed(state, original.id, 'contaminated');
});

test('SECURITY: removing then reinserting altered same-id content does not erase its fingerprint', () => {
  const original = user('reinsert-edit', 'original input');
  const changed = { ...original, content: [{ type: 'text', text: 'PRIVATE_REINSERTED_INPUT' }] };
  const state = fold(initialProjection(header), splice([original]),
    splice([], { removedCount: 1, outcome: 'canceled' }), splice([changed]));
  assert.equal(state.contaminated, true);
  assertFailed(state, original.id, 'contaminated');
});

test('stable receipt ids are not duplicated when a claimed message is observed again', () => {
  const message = user();
  const state = fold(running(message), accepted(message), assistant('one answer'), end());
  assert.equal(state.records.filter((record) => record.id === message.id).length, 1);
  assert.equal(completionOf(state, message.id).text, 'one answer');
});

test('projection receipt history remains bounded and reply candidates have a finite size', () => {
  let state = initialProjection(header);
  for (let index = 0; index < 510; index += 1) {
    state = applyProjection(state, splice([user(`receipt-${index}`)], { start: state.inbox['next-turn'].length }));
  }
  assert.ok(state.records.length <= 500);
  assert.equal(completionOf(state, idFor('receipt-0')), undefined);
  assert.equal(completionOf(state, idFor('receipt-509')).state, 'queued');
  const completed = fold(running(), assistant('x'.repeat(MAX_REPLY_CHARS * 3)), end());
  assert.ok(completionOf(completed, user().id).text.length <= MAX_REPLY_CHARS + 200);
});
