import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setImmediate as nextTick } from 'node:timers/promises';
import test from 'node:test';
import { AgentBackend, commandDomainSpec, createCommandReceipts } from '../lib/agent-backend.js';
import { initialProjection, applyProjection, completionOf, contentFingerprint } from '../lib/projection.js';
import { BridgeError, LEGACY_WEIXIN_PRESET_ID, PRESET_ID, hash } from '../lib/state.js';

const WORKSPACE = '/unit-test/isolated-wechat';
const SESSION = `wxbridge-${'a'.repeat(32)}`;
const OTHER_SESSION = `wxbridge-${'b'.repeat(32)}`;
const MODEL = Object.freeze({ provider: 'fake-provider', model: 'fake-model', reasoningEffort: 'fake-effort' });
const entry = (name = 'one', overrides = {}) => ({
  sessionId: SESSION, messageId: `wxbridge-in-${hash(name).slice(0, 48)}`, text: `WeChat text ${name}`, ...overrides,
});
const userMessage = (item) => ({
  id: item.messageId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: item.text }],
});
function observe(promise) {
  promise.catch(() => {});
  return promise;
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function bridgeError(code, status) {
  return (error) => {
    assert.ok(error instanceof BridgeError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  };
}

/**
 * Strict in-memory doubles for the installed DSH 0.2.2-rc.3 public Agent,
 * Inbox, ProjectionHandle and sessionPersistence contracts. The session fold
 * advances synchronously before session/event listeners, just like DSH.
 * No actual Cordis context, profile, storage, provider or model is created.
 */
function harness(t, options = {}) {
  const live = new Map();
  const cells = new WeakMap();
  const pending = new WeakMap();
  const logs = new WeakMap();
  const presets = new WeakMap();
  const listeners = new Set();
  const streamListeners = new Set();
  const owned = new Set();
  const remoteEvents = [];
  const calls = {
    get: [], stat: [], create: [], resume: [], mount: [], followup: [], remove: [], cancel: [], dispose: [], flush: 0, whenIdle: 0,
  };
  let sequence = 0;
  let backend;
  let receipts = [];
  const projection = {
    stateOf(session) {
      if (options.projectionError) throw options.projectionError;
      assert.ok(cells.has(session), 'read an unrelated or unknown Session');
      return cells.get(session);
    },
  };
  function notify(session, event) {
    for (const listener of [...listeners]) listener(session, event);
  }
  function publish(agent, type, data, extra = {}) {
    const event = { type, data, seq: sequence++, time: 1_800_000_000_000 + sequence, ...extra };
    if (type === 'agent/inbox/spliced') {
      pending.get(agent.session)[data.target].splice(data.start, data.removedCount ?? 0, ...data.inserted);
    }
    cells.set(agent.session, applyProjection(cells.get(agent.session), event));
    logs.get(agent.session).push(event);
    notify(agent.session, event);
    return event;
  }
  function makeAgent(id = SESSION, changes = {}) {
    const session = {
      id,
      header: { id, cwd: WORKSPACE, agentPreset: PRESET_ID, ...changes.header },
      // A transport must use its incremental projection, not rescan history or
      // infer message settlement from whole-agent quiescence.
      deriveMessages() { throw new Error('must not rescan model history'); },
      snapshotEvents() { throw new Error('must not rescan session history'); },
    };
    cells.set(session, initialProjection(session.header));
    logs.set(session, []);
    pending.set(session, { 'next-turn': [], 'next-step': [] });
    presets.set(session, changes.preset ?? PRESET_ID);
    const agent = {
      id, session, status: changes.status ?? 'idle', ctx: { fakeAgentScope: id },
      model: changes.model,
      inbox: {
        get nextTurn() { return pending.get(session)['next-turn']; },
        get nextStep() { return pending.get(session)['next-step']; },
        remove(messageId) {
          calls.remove.push({ agent, messageId });
          for (const target of ['next-turn', 'next-step']) {
            const position = pending.get(session)[target].findIndex((message) => message.id === messageId);
            if (position >= 0) {
              publish(agent, 'agent/inbox/spliced', { target, start: position, removedCount: 1, inserted: [], outcome: 'canceled' });
              return true;
            }
          }
          return false;
        },
      },
      followup(message) {
        calls.followup.push({ agent, message });
        publish(agent, 'agent/inbox/spliced', { target: 'next-turn', start: agent.inbox.nextTurn.length, inserted: [message] });
        // Public followup() reserves running status synchronously when waking.
        agent.status = 'running';
        options.onFollowup?.(agent, message);
      },
      cancel(cause) {
        calls.cancel.push({ agent, cause });
        if (options.cancelError) throw options.cancelError;
        for (const target of ['next-step', 'next-turn']) {
          const count = pending.get(session)[target].length;
          if (count) publish(agent, 'agent/inbox/spliced', { target, start: 0, removedCount: count, inserted: [], outcome: 'canceled' });
        }
      },
      async whenIdle() { calls.whenIdle += 1; },
    };
    return agent;
  }
  function makeHandle(agent) {
    const handle = {
      agent, disposed: false,
      async dispose() {
        calls.dispose.push(agent.id);
        try { await options.onDispose?.(agent); }
        finally {
          handle.disposed = true;
          if (live.get(agent.id) === agent) live.delete(agent.id);
          agent.status = 'idle';
        }
      },
    };
    owned.add(handle);
    return handle;
  }
  async function factory(kind, config) {
    const id = config.sessionId ?? config.resumeSessionId;
    const agent = makeAgent(id, { header: config.meta ?? options.stored?.header, ...options.createdAgent });
    await config.setup?.(agent.ctx, agent);
    live.set(id, agent);
    const handle = makeHandle(agent);
    return options.afterFactory ? options.afterFactory(kind, config, handle) : handle;
  }
  const ctx = {
    agents: {
      get(id) { calls.get.push(id); return live.get(id); },
      async create(config) { calls.create.push(config); return factory('create', config); },
      async resume(config) { calls.resume.push(config); return factory('resume', config); },
    },
    agentDefaultModel: {
      currentSelection() {
        if (options.modelError) throw options.modelError;
        return Object.hasOwn(options, 'selection') ? options.selection : MODEL;
      },
    },
    agentPresets: {
      async mount(agentCtx, preset) { calls.mount.push({ agentCtx, preset }); },
      presetForSession(session) { return presets.get(session); },
    },
    sessionPersistence: {
      async stat(id, settings) {
        calls.stat.push({ id, settings });
        const agent = live.get(id);
        return options.inspect?.(id) ?? (options.inspectLive && agent
          ? { header: agent.session.header, revision: logs.get(agent.session).length } : options.stored);
      },
      async open(id, mode) {
        assert.equal(mode, 'read');
        const agent = live.get(id);
        const source = options.read?.(id) ?? { header: agent.session.header, events: logs.get(agent.session) };
        return { header: source.header, inheritedEventCount: 0,
          async read(offset, length) { return { events: source.events.slice(offset, offset + length) }; }, async close() {} };
      },
      async flush() {
        calls.flush += 1;
        await options.onFlush?.(calls.flush);
      },
    },
    commands: options.commands,
    llm: options.llm,
    skills: options.skills,
    typertGateway: { getPendingRemoteEvents: () => remoteEvents },
    on(name, callback, options) {
      assert.ok(['session/event', 'agent/assistant-stream'].includes(name));
      if (name === 'agent/assistant-stream') assert.equal(options?.global, true);
      const target = name === 'session/event' ? listeners : streamListeners;
      target.add(callback);
      return () => { target.delete(callback); };
    },
  };
  const commandReceipts = options.commandReceipts ?? createCommandReceipts({
    get: () => receipts,
    set: async state => { receipts = commandDomainSpec.global.schema.parse(JSON.parse(JSON.stringify(state))); },
  });
  backend = new AgentBackend(ctx, { projection, workspaceDir: WORKSPACE, timeoutMs: options.timeoutMs ?? 1_000,
    workspaceForSession: options.workspaceForSession, commandReceipts, reportToolApprovals: options.reportToolApprovals });
  function borrow(id = SESSION, changes) {
    const agent = makeAgent(id, changes);
    live.set(id, agent);
    return agent;
  }
  function seedQueued(agent, item, target = 'next-turn', message = userMessage(item)) {
    publish(agent, 'agent/inbox/spliced', { target, start: pending.get(agent.session)[target].length, inserted: [message] });
    return message;
  }
  function admit(agent, item, turn = 1) {
    const state = cells.get(agent.session);
    if (state.active.includes(item.messageId)) return;
    publish(agent, 'turn/start', { turn });
    let message;
    for (const target of ['next-turn', 'next-step']) {
      const position = pending.get(agent.session)[target].findIndex((candidate) => candidate.id === item.messageId);
      if (position >= 0) {
        message = pending.get(agent.session)[target][position];
        publish(agent, 'agent/inbox/spliced', { target, start: position, removedCount: 1, inserted: [] });
        break;
      }
    }
    publish(agent, 'user/message', message ?? userMessage(item), { surfaceOp: 'append' });
    agent.status = 'running';
  }
  function complete(agent, item, text = 'final answer', reason = 'completed') {
    admit(agent, item);
    const turn = cells.get(agent.session).turn;
    publish(agent, 'assistant/message', {
      turn, step: 1, stream: [],
      message: { id: 'assistant-message', role: 'assistant', source: { kind: 'model', provider: 'fake', model: 'fake' }, content: [{ type: 'text', text }] },
    }, { surfaceOp: 'append' });
    publish(agent, 'turn/end', { turn, reason: { kind: reason } });
    agent.status = 'idle';
    return completionOf(cells.get(agent.session), item.messageId);
  }
  t.after(async () => {
    await backend.close().catch(() => {});
    // Keep test failures from leaking double-owned fake resources into another
    // case; assertions about disposal run before this last-resort cleanup.
    for (const handle of owned) if (!handle.disposed) await handle.dispose().catch(() => {});
  });
  return {
    backend, ctx, calls, cells, presets, listeners, live, projection, streamListeners,
    makeAgent, makeHandle, borrow, publish, notify, seedQueued, admit, complete, remoteEvents,
    emitStream(agent, frame) { for (const listener of streamListeners) listener({ agent, frame }); },
  };
}

test('model selection is read-only and unavailable/throwing selections fail closed', (t) => {
  const h = harness(t);
  assert.deepEqual(h.backend.model(), MODEL);
  for (const selection of [undefined, null, {}, { provider: 'p' }, { model: 'm' }]) {
    assert.equal(harness(t, { selection }).backend.model(), null);
  }
  assert.equal(harness(t, { modelError: new Error('unavailable') }).backend.model(), null);
  assert.equal(h.calls.create.length, 0);
});

test('live events are bounded and tied to the admitted message and exact attempt', async (t) => {
  const h = harness(t);
  const item = entry('events');
  const agent = h.borrow();
  const other = h.borrow(OTHER_SESSION);
  const updates = [];
  const start = { type: 'start', attemptId: 'active', revision: 1, turn: 1, step: 1 };
  const chunk = (text, type = 'text-delta', index = 0) => ({
    type: 'chunk', attemptId: 'active', revision: index + 2, index, chunk: { type, index: 0, text },
  });
  const pending = observe(h.backend.run(item, undefined, update => { updates.push(update); }));
  await nextTick();
  h.emitStream(agent, start);
  h.emitStream(agent, chunk('unadmitted prefix'));
  h.admit(agent, item);
  h.emitStream(other, start);
  h.emitStream(other, chunk('foreign private text'));
  h.emitStream(agent, start);
  h.emitStream(agent, chunk('hidden thinking', 'reasoning-delta'));
  h.emitStream(agent, chunk('hello ', 'text-delta', 1));
  h.emitStream(agent, { ...chunk('old attempt'), revision: 2 });
  h.publish(agent, 'tool/call', { turn: 1, step: 1, name: 'search', arguments: 'PRIVATE_TOOL_ARGUMENTS' });
  h.publish(agent, 'tool/result', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'PRIVATE_TOOL_RESULT' }] } });
  h.complete(agent, item, 'reply');
  assert.equal((await pending).text, 'reply');
  assert.deepEqual(updates.filter(update => update.type === 'delta').map(update => update.text), ['hello ']);
  assert.deepEqual(updates.filter(update => update.type === 'tool').map(update => update.metadata.name), ['search']);
  assert.ok(updates.some(update => update.type === 'progress'));
  assert.doesNotMatch(JSON.stringify(updates), /private|hidden|foreign|unadmitted|old attempt/i);
  assert.equal(h.streamListeners.size, 0);
  assert.equal(h.listeners.size, 0);
});

test('only unresolved native approvals for the active WeChat turn are reported', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = harness(t, { reportToolApprovals: true, timeoutMs: 10_000 });
  const item = entry('approval');
  const agent = h.borrow();
  const other = h.borrow(OTHER_SESSION);
  const updates = [];
  const pending = observe(h.backend.run(item, undefined, update => { if (update.type === 'approval') updates.push(update); }));
  await nextTick();
  h.remoteEvents.push({ event: 'approval/request', agentId: SESSION });
  t.mock.timers.tick(1_000);
  assert.deepEqual(updates, [], 'no admitted WeChat turn can own the approval yet');
  h.remoteEvents.length = 0;
  h.admit(agent, item);
  h.remoteEvents.push({ event: 'approval/request', agentId: other.id },
    { event: 'user-questions/request', agentId: SESSION });
  h.publish(agent, 'approval/asked', { id: 'automatic-decision' });
  t.mock.timers.tick(1_000);
  assert.deepEqual(updates, []);

  h.remoteEvents.push(
    { event: 'approval/request', agentId: SESSION, body: 'private tool arguments' },
    { event: 'approval/request', agentId: SESSION });
  t.mock.timers.tick(1_000);
  assert.deepEqual(updates, [{ type: 'approval', pending: true }]);

  h.remoteEvents.pop();
  t.mock.timers.tick(500);
  assert.equal(updates.length, 1, 'another tool decision is still pending');
  h.remoteEvents.pop();
  t.mock.timers.tick(500);
  assert.deepEqual(updates.at(-1), { type: 'approval', pending: false });
  h.complete(agent, item, 'reply');
  assert.equal((await pending).text, 'reply');
});

test('a resumed live turn exposes its existing approval and clears it on interruption', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const h = harness(t, { reportToolApprovals: true, timeoutMs: 10_000 });
  const item = entry('approval-ended');
  const agent = h.borrow();
  const updates = [];
  h.admit(agent, item);
  h.remoteEvents.push({ event: 'approval/request', agentId: SESSION });
  const pending = observe(h.backend.run(item, undefined, update => { if (update.type === 'approval') updates.push(update.pending); }));
  await nextTick();
  t.mock.timers.tick(1_000);
  assert.deepEqual(updates, [true]);

  h.complete(agent, item, '', 'interrupted');
  await pending;
  assert.deepEqual(updates, [true, false]);
  assert.equal(h.listeners.size, 0);
});

test('channel turn binding precedes native followup and disposes after completion', async (t) => {
  const order = [];
  const h = harness(t, { onFollowup: () => { order.push('followup'); } });
  const item = entry('tool-scope', { bindTurn(agent) {
    assert.equal(agent.id, SESSION);
    order.push('admit');
    return () => { order.push('dispose'); };
  } });
  const agent = h.borrow();
  const pending = observe(h.backend.run(item));
  await nextTick();
  assert.deepEqual(order, ['admit', 'followup']);
  h.complete(agent, item);
  await pending;
  assert.deepEqual(order, ['admit', 'followup', 'dispose']);
});

test('new sessions use a private cwd and old base cwd remains valid for isolated histories', async (t) => {
  const perSession = `${WORKSPACE}/${SESSION}`;
  const workspaceForSession = async id => `${WORKSPACE}/${id}`;
  const h = harness(t, { workspaceForSession });
  const agent = await h.backend.ensureAgent(entry());
  assert.equal(agent.session.header.cwd, perSession);
  assert.equal(h.backend.isSafe(SESSION), true);
  const legacy = harness(t, { workspaceForSession, stored: { header: { id: SESSION, cwd: WORKSPACE, agentPreset: PRESET_ID } } });
  assert.equal((await legacy.backend.ensureAgent(entry())).session.header.cwd, WORKSPACE);
  const other = harness(t, { workspaceForSession });
  other.borrow(SESSION, { header: { cwd: `${WORKSPACE}/${OTHER_SESSION}` } });
  await assert.rejects(other.backend.ensureAgent(entry()), bridgeError('FORBIDDEN'));
});

test('interrupt cancels only a live matching bridge Agent with clean history', (t) => {
  const h = harness(t);
  assert.equal(h.backend.interrupt(SESSION), false);
  assert.equal(h.calls.resume.length, 0);
  const agent = h.borrow(SESSION, { status: 'running' });
  h.borrow(OTHER_SESSION, { header: { cwd: `${WORKSPACE}/foreign` }, status: 'running' });
  assert.equal(h.backend.interrupt(OTHER_SESSION), false);
  assert.equal(h.backend.interrupt(SESSION), true);
  assert.deepEqual(h.calls.cancel.map(value => value.agent), [agent]);
});

test('hasSession requires a real live or persisted exact scope and never resumes the session', async (t) => {
  const h = harness(t);
  assert.equal(await h.backend.hasSession('ordinary-web-session'), false);
  assert.equal(await h.backend.hasSession(SESSION), false);
  const agent = h.borrow();
  assert.equal(await h.backend.hasSession(SESSION), true);
  h.cells.set(agent.session, { ...h.projection.stateOf(agent.session), contaminated: true });
  assert.equal(await h.backend.hasSession(SESSION), false);
  const stored = harness(t, { stored: { header: { id: SESSION, cwd: WORKSPACE, agentPreset: PRESET_ID } } });
  assert.equal(await stored.backend.hasSession(SESSION), true);
  assert.equal(stored.calls.resume.length, 0);
  const foreign = harness(t, { stored: { header: { id: SESSION, cwd: '/foreign', agentPreset: PRESET_ID } } });
  assert.equal(await foreign.backend.hasSession(SESSION), false);
});

test('reviewed native command executes once, rejects unreviewed slash text and survives a replay', async (t) => {
  const runs = [];
  const h = harness(t, { commands: {
    find: (_agent, name) => name === 'compact' ? { definitionId: '@deepseek-ai/dsh-command-compact' } : undefined,
    execute: async (agent, line, attachments, signal) => {
      runs.push({ agent, line });
      assert.deepEqual(attachments, []);
      assert.equal(signal.aborted, false);
      return { commandId: 'command', result: { kind: 'success', text: 'Compaction finished.' } };
    },
  } });
  const agent = h.borrow();
  const item = entry('cmd', { text: '/compact' });
  const result = await h.backend.run(item);
  assert.equal(result.text, 'Compaction finished.');
  assert.deepEqual(await h.backend.run(item), result);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].agent, agent);
  assert.equal(h.calls.followup.length, 0);
  await h.backend.run(entry('unknown-cmd', { text: '/restart' }));
  await h.backend.run(entry('compact-with-args', { text: '/compact unexpected argument' }));
  assert.equal(h.calls.followup.length, 0);
  assert.equal(runs.length, 1);
});

test('a compact receipt with an unknown result cannot execute twice after restart', async (t) => {
  let saved = [];
  let executions = 0;
  const state = {
    get: () => saved,
    set: async (receipts) => {
      if (receipts.some(receipt => receipt.text)) throw new Error('result persistence failed');
      saved = receipts;
    },
  };
  const options = {
    commands: {
      find: () => ({ definitionId: '@deepseek-ai/dsh-command-compact' }),
      async execute() { executions++; return { result: { kind: 'success', text: 'Compacted.' } }; },
    },
  };
  const first = harness(t, { ...options, commandReceipts: createCommandReceipts(state) });
  const item = entry('cmd-interrupted', { text: '/compact' });
  await assert.rejects(first.backend.run(item), /result persistence failed/);
  const restored = harness(t, { ...options, commandReceipts: createCommandReceipts(state) });
  assert.match((await restored.backend.run(item)).text, /执行结果无法确认/);
  assert.equal(executions, 1);
});

test('status and skill commands expose only scope metadata and model selection follows the host catalog', async (t) => {
  const choices = [];
  const h = harness(t, {
    llm: { async listModels(provider) { return provider === 'safe-provider' ? [{ provider, id: 'safe/model' }] : []; } },
    skills: { async list({ cwd, scope, signal }) {
      assert.equal(cwd, WORKSPACE);
      assert.equal(scope.id, SESSION);
      assert.equal(signal.aborted, false);
      return [{ name: 'safe-skill', path: 'PRIVATE_PATH', invocation: { userInvocable: true } },
        { name: 'private-skill', invocation: { userInvocable: false } }];
    } },
  });
  h.borrow(SESSION, { model: { current: () => MODEL, select: (route) => choices.push(route) } });
  assert.match((await h.backend.run(entry('status', { text: '/status' }))).text, /fake-provider\/fake-model/);
  assert.match((await h.backend.run(entry('model', { text: '/model' }))).text, /fake-provider\/fake-model/);
  const listed = await h.backend.run(entry('skill', { text: '/skill' }));
  assert.match(listed.text, /safe-skill/);
  assert.doesNotMatch(listed.text, /private-skill|PRIVATE_PATH/);
  const allowed = entry('model-select', { text: '/model safe-provider/safe/model' });
  await h.backend.run(allowed);
  await h.backend.run(allowed);
  await h.backend.run(entry('unlisted-model', { text: '/model safe-provider/unlisted' }));
  assert.deepEqual(choices, [{ provider: 'safe-provider', model: 'safe/model' }]);
  assert.equal(h.calls.followup.length, 0);
});

test('canceling slow model discovery does not leave a later model-selection mutation', async (t) => {
  const lookup = deferred();
  const requested = deferred();
  const controller = new AbortController();
  const choices = [];
  const h = harness(t, { llm: { listModels() { requested.resolve(); return lookup.promise; } } });
  h.borrow(SESSION, { model: { current: () => MODEL, select: route => choices.push(route) } });
  const pending = h.backend.run(entry('slow-model', { text: '/model safe-provider/safe-model' }), controller.signal);
  await requested.promise;
  controller.abort();
  await pending;
  lookup.resolve([{ provider: 'safe-provider', id: 'safe-model' }]);
  await nextTick();
  assert.deepEqual(choices, []);
});

test('schedule relay filters historical, unbound, and contaminated outcomes and retries durable delivery', async (t) => {
  const header = id => ({ id, cwd: WORKSPACE, agentPreset: PRESET_ID });
  const reminder = (number, time, text) => [
    { type: 'turn/start', data: { turn: number } },
    { type: 'user/message', surfaceOp: 'append', data: { role: 'user', source: { kind: 'schedule' },
      id: `f9b58b71-7679-4574-8f4e-112f0e11a20${number}` } },
    { type: 'assistant/message', data: { turn: number, message: { content: [{ type: 'text', text }] } } },
    { type: 'turn/end', data: { turn: number, reason: { kind: 'completed' } }, time },
  ];
  const data = new Map([
    [SESSION, [...reminder(1, 90, 'historical'), ...reminder(2, 110, 'allowed')]],
    [OTHER_SESSION, [...reminder(3, 110, 'unbound')]],
  ]);
  const state = new Map([[LEGACY_WEIXIN_PRESET_ID, { enabledAt: 100 }]]);
  const receiptStore = { get: key => state.get(key), async put(key, value) { state.set(key, value); } };
  const options = {
    inspect: id => data.has(id) ? { header: header(id), revision: data.get(id).length } : undefined,
    read: id => ({ header: header(id), events: data.get(id).map((event, seq) => ({ seq, time: 110, ...event })) }),
  };
  const h = harness(t, options);
  const attempted = [];
  const retry = deferred();
  const stop = h.backend.startScheduleRelay({ listSessions: () => [SESSION], state: receiptStore, retryMs: 5,
    async send(receipt) {
      attempted.push(receipt);
      if (attempted.length === 1) return false;
      retry.resolve();
      return true;
    },
  });
  let timer;
  try {
    await Promise.race([retry.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('relay did not retry')), 1_000);
    })]);
  } finally { clearTimeout(timer); }
  await stop();
  assert.deepEqual(attempted.map(item => item.text), ['allowed', 'allowed']);
  assert.equal(attempted[0].messageId, attempted[1].messageId);
  assert.deepEqual(state.get(SESSION), { deliveredSeq: 7 });
  assert.equal(h.calls.resume.length, 0);
  assert.equal(h.listeners.size, 0);

  data.get(SESSION).push(...reminder(3, 150, 'blocked'),
    { type: 'user/message', surfaceOp: 'append', data: { id: 'desktop-user-message', source: { kind: 'user' } } });
  const restored = harness(t, options);
  const list = deferred();
  let unexpected = false;
  restored.backend.startScheduleRelay({ state: receiptStore, retryMs: 5,
    listSessions() { list.resolve(); return [SESSION]; }, send() { unexpected = true; return true; } });
  await list.promise;
  await new Promise(resolve => setTimeout(resolve, 10));
  await restored.backend.close();
  assert.equal(unexpected, false);
  assert.deepEqual(state.get(SESSION), { deliveredSeq: 7 });
});

test('new sessions use explicit isolated metadata, selected route, scoped setup and cancellation', async (t) => {
  const h = harness(t);
  const signal = new AbortController().signal;
  const item = entry('fresh', { parentSession: 'NEVER_INHERIT', seed: ['PRIVATE_HISTORY'] });
  const agent = await h.backend.ensureAgent(item, signal);
  assert.equal(agent.id, item.sessionId);
  assert.equal(h.calls.create.length, 1);
  assert.equal(h.calls.resume.length, 0);
  const request = h.calls.create[0];
  assert.equal(request.sessionId, item.sessionId);
  assert.deepEqual(request.meta, { cwd: WORKSPACE, agentPreset: 'standard' });
  assert.deepEqual(request.agentOptions, { ...MODEL, maxTokens: 3000 });
  assert.equal(request.signal, signal);
  assert.equal(request.seed, undefined);
  assert.equal(request.inheritedEventCount, undefined);
  assert.equal(request.meta.parentSession, undefined);
  assert.deepEqual(h.calls.stat[0], { id: item.sessionId, settings: { signal } });
  assert.deepEqual(h.calls.mount, [{ agentCtx: agent.ctx, preset: 'standard' }]);
  assert.equal(h.backend.handles.get(agent.id).agent, agent);
  assert.equal(h.backend.live.get(agent.id), agent);
});

test('resume preserves durable identity/model history instead of seeding from another conversation', async (t) => {
  const h = harness(t, { stored: { header: { id: SESSION, cwd: WORKSPACE, agentPreset: PRESET_ID }, revision: 'opaque' } });
  const signal = new AbortController().signal;
  const agent = await h.backend.ensureAgent(entry(), signal);
  assert.equal(h.calls.create.length, 0);
  assert.equal(h.calls.resume.length, 1);
  const request = h.calls.resume[0];
  assert.equal(request.resumeSessionId, SESSION);
  assert.equal(request.signal, signal);
  assert.equal(request.agentOptions?.provider, undefined);
  assert.equal(request.agentOptions?.model, undefined);
  assert.equal(request.meta, undefined);
  assert.equal(request.seed, undefined);
  assert.deepEqual(h.calls.mount, [{ agentCtx: agent.ctx, preset: PRESET_ID }]);
});

test('legacy presets in saved and live sessions require a new conversation before running', async (t) => {
  const oldPreset = 'weixin-bridge-chat';
  const cold = harness(t, {
    selection: null, stored: { header: { id: SESSION, cwd: WORKSPACE, agentPreset: oldPreset } },
  });
  await assert.rejects(cold.backend.ensureAgent(entry()), bridgeError('LEGACY_PRESET', 409));
  assert.equal(cold.calls.resume.length, 0);
  assert.equal(await cold.backend.hasSession(SESSION), false);

  const live = harness(t);
  live.borrow(SESSION, { header: { agentPreset: oldPreset }, preset: oldPreset });
  await assert.rejects(live.backend.ensureAgent(entry()), bridgeError('LEGACY_PRESET', 409));
  assert.equal(live.calls.followup.length, 0);
  assert.equal(await live.backend.hasSession(SESSION), false);
});

test('safe existing live agents are borrowed without factory/model/persistence work', async (t) => {
  const h = harness(t, { selection: null });
  const agent = h.borrow();
  assert.equal(await h.backend.ensureAgent(entry()), agent);
  assert.equal(h.calls.stat.length, 0);
  assert.equal(h.calls.create.length, 0);
  assert.equal(h.calls.resume.length, 0);
  assert.equal(h.backend.handles.size, 0);
  await h.backend.close();
  assert.equal(h.calls.dispose.length, 0, 'a bare Agent is not an AgentHandle disposal capability');
  assert.equal(h.live.get(agent.id), agent);
});

test('invalid session ids, closed backends and pre-aborted requests fail before factory access', async (t) => {
  const h = harness(t);
  await assert.rejects(h.backend.ensureAgent(entry('bad', { sessionId: 'ordinary-web-session' })), bridgeError('INVALID_REQUEST', 400));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.backend.ensureAgent(entry(), controller.signal), bridgeError('BUSY', 409));
  await h.backend.close();
  await assert.rejects(h.backend.ensureAgent(entry()), bridgeError('BUSY', 409));
  assert.equal(h.calls.get.length, 0);
  assert.equal(h.calls.create.length, 0);
});

for (const header of [
  { id: SESSION, cwd: '/different-workspace', agentPreset: PRESET_ID },
  { id: SESSION, cwd: WORKSPACE, agentPreset: 'ordinary-preset' },
]) {
  test(`persisted metadata isolation rejects ${header.cwd}/${header.agentPreset}`, async (t) => {
    const h = harness(t, { stored: { header, revision: 'opaque' } });
    await assert.rejects(h.backend.ensureAgent(entry()), bridgeError('FORBIDDEN', 403));
    assert.equal(h.calls.create.length, 0);
    assert.equal(h.calls.resume.length, 0);
  });
}

for (const changes of [{ header: { cwd: '/changed-workspace' } }, { preset: 'changed-preset' }]) {
  test(`live metadata isolation is rechecked (${JSON.stringify(changes)})`, async (t) => {
    const h = harness(t);
    h.borrow(SESSION, changes);
    await assert.rejects(h.backend.ensureAgent(entry()), bridgeError('FORBIDDEN', 403));
    assert.equal(h.calls.stat.length, 0);
    assert.equal(h.calls.followup.length, 0);
  });
}

test('an unavailable default model blocks creation after checking for a saved session', async (t) => {
  const h = harness(t, { selection: null });
  await assert.rejects(h.backend.ensureAgent(entry()), bridgeError('MODEL_UNAVAILABLE', 409));
  assert.equal(h.calls.stat.length, 1);
  assert.equal(h.calls.create.length, 0);
});

test('SECURITY: a newly acquired handle failing isolation validation is disposed, not orphaned', async (t) => {
  const h = harness(t, { createdAgent: { preset: 'unexpected-preset' } });
  await assert.rejects(h.backend.ensureAgent(entry()), bridgeError('FORBIDDEN', 403));
  assert.deepEqual(h.calls.dispose, [SESSION]);
  assert.equal(h.backend.handles.size, 0);
  assert.equal(h.backend.live.size, 0);
  assert.equal(h.live.has(SESSION), false);
});

for (const cause of ['abort', 'close']) {
  test(`a factory settling after ${cause} disposes its late handle`, async (t) => {
    const gate = deferred();
    const ready = deferred();
    const controller = new AbortController();
    const h = harness(t, { afterFactory: async (_kind, _request, handle) => { ready.resolve(handle); await gate.promise; return handle; } });
    const pending = h.backend.ensureAgent(entry(), controller.signal);
    const rejected = assert.rejects(pending, bridgeError('BUSY', 409));
    await ready.promise;
    if (cause === 'abort') controller.abort(); else await h.backend.close();
    gate.resolve();
    await rejected;
    assert.deepEqual(h.calls.dispose, [SESSION]);
    assert.equal(h.backend.handles.size, 0);
    assert.equal(h.backend.live.size, 0);
  });
}

test('fresh submissions freeze the stable message envelope and obey both durability barriers', async (t) => {
  const firstFlush = deferred();
  const finalFlush = deferred();
  const firstStarted = deferred();
  const h = harness(t, { onFlush: async (count) => {
    if (count === 1) { firstStarted.resolve(); await firstFlush.promise; }
    else if (count === 2) await finalFlush.promise;
  } });
  const agent = h.borrow();
  const item = entry();
  let settled = false;
  const result = h.backend.run(item).finally(() => { settled = true; });
  try {
    await firstStarted.promise;
    assert.equal(h.calls.followup.length, 1);
    const message = h.calls.followup[0].message;
    assert.deepEqual(message, userMessage(item));
    for (const part of [message, message.source, message.content, message.content[0]]) assert.equal(Object.isFrozen(part), true);
    assert.equal(h.backend.waiters.size, 0, 'new input is not acknowledged before its inbox flush');
    h.complete(agent, item);
    await nextTick();
    assert.equal(settled, false);
    firstFlush.resolve();
    await nextTick();
    assert.equal(h.calls.flush, 2, 'a completed turn also needs a durable terminal barrier');
    assert.equal(settled, false);
    finalFlush.resolve();
    assert.equal((await result).text, 'final answer');
    assert.equal(h.calls.whenIdle, 0);
  } finally {
    firstFlush.resolve(); finalFlush.resolve();
    await result.catch(() => {});
  }
});

for (const terminal of ['completed', 'failed']) {
  test(`cached ${terminal} receipts never follow up again and wait for flush before return`, async (t) => {
    const gate = deferred();
    const started = deferred();
    const h = harness(t, { onFlush: async () => { started.resolve(); await gate.promise; } });
    const agent = h.borrow();
    const item = entry();
    h.seedQueued(agent, item);
    if (terminal === 'completed') h.complete(agent, item, 'durable prior reply');
    else agent.inbox.remove(item.messageId);
    let settled = false;
    const pending = h.backend.run(item).finally(() => { settled = true; });
    try {
      await Promise.race([started.promise, pending]);
      await nextTick();
      assert.equal(h.calls.followup.length, 0);
      assert.equal(h.calls.flush, 1);
      assert.equal(settled, false, 'a terminal receipt returned before persistence.flush()');
      gate.resolve();
      assert.equal((await pending).state, terminal);
    } finally {
      gate.resolve();
      await pending.catch(() => {});
    }
  });
}

test('queued input already owned by a running driver is observed without duplicate followup', async (t) => {
  const h = harness(t);
  const agent = h.borrow(SESSION, { status: 'running' });
  const item = entry();
  h.seedQueued(agent, item);
  const pending = observe(h.backend.run(item));
  await nextTick();
  assert.equal(h.calls.followup.length, 0);
  assert.equal(h.calls.remove.length, 0);
  h.complete(agent, item, 'one model answer');
  assert.equal((await pending).text, 'one model answer');
  assert.equal(h.calls.flush, 1);
});

test('idle restored next-turn input is reawakened once with the same original message id/content', async (t) => {
  const h = harness(t);
  const agent = h.borrow();
  const item = entry('restore');
  const original = h.seedQueued(agent, item);
  const pending = observe(h.backend.run(item));
  await nextTick();
  assert.equal(h.calls.remove.length, 1);
  assert.equal(h.calls.remove[0].messageId, item.messageId);
  assert.equal(h.calls.followup.length, 1);
  assert.deepEqual(h.calls.followup[0].message, original);
  assert.equal(h.calls.followup[0].message.id, item.messageId);
  assert.equal(h.projection.stateOf(agent.session).contaminated, false);
  assert.equal(completionOf(h.projection.stateOf(agent.session), item.messageId).state, 'queued');
  h.complete(agent, item, 'recovered answer');
  const completed = await pending;
  assert.equal(completed.text, 'recovered answer');
  assert.deepEqual(await h.backend.run(item), completed);
  assert.equal(h.calls.followup.length, 1, 'a terminal retry must not repeat the wakeup');
});

test('unexpected idle next-step input fails closed instead of being resubmitted as a WeChat followup', async (t) => {
  const h = harness(t);
  const agent = h.borrow();
  const item = entry('unexpected-steering');
  h.seedQueued(agent, item, 'next-step');
  assert.deepEqual(await h.backend.run(item), { state: 'failed', text: '', reason: 'interrupted' });
  assert.equal(h.calls.remove.length, 0);
  assert.equal(h.calls.followup.length, 0);
  assert.equal(h.calls.flush, 1);
  assert.equal(agent.inbox.nextStep.length, 1);
});

test('running receipts with no remaining inbox on an idle driver fail interrupted without resubmitting', async (t) => {
  const h = harness(t);
  const agent = h.borrow();
  const item = entry();
  h.seedQueued(agent, item);
  h.admit(agent, item);
  agent.status = 'idle';
  assert.deepEqual(await h.backend.run(item), { state: 'failed', text: '', reason: 'interrupted' });
  assert.equal(h.calls.followup.length, 0);
  assert.equal(h.calls.flush, 1);
});

for (const terminal of [false, true]) {
  test(`SECURITY: trusted entry text must match the ${terminal ? 'terminal' : 'queued'} durable fingerprint`, async (t) => {
    const h = harness(t);
    const agent = h.borrow(SESSION, { status: 'running' });
    const original = entry('bound-content');
    h.seedQueued(agent, original);
    if (terminal) h.complete(agent, original, 'PRIVATE_UNRELATED_REPLY');
    const changed = { ...original, text: 'different trusted receipt content' };
    const result = await h.backend.run(changed);
    assert.equal(result.state, 'failed');
    assert.equal(result.text, '');
    assert.equal(result.reason, 'contaminated');
    assert.equal(h.calls.followup.length, 0);
    assert.equal(h.calls.remove.length, 0);
    assert.ok(h.calls.flush >= 1);
  });
}

test('permanent Web contamination fails closed without submitting model input', async (t) => {
  const h = harness(t);
  const agent = h.borrow();
  h.publish(agent, 'user/message', { id: 'web-message', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE_WEB_INPUT' }] }, { surfaceOp: 'append' });
  const result = await h.backend.run(entry());
  assert.deepEqual(result, { state: 'failed', text: '', reason: 'contaminated' });
  assert.equal(h.calls.followup.length, 0);
  assert.equal(h.calls.flush, 1);
});

test('unrelated Session objects and unrelated event kinds cannot resolve a message waiter', async (t) => {
  const h = harness(t);
  const agent = h.borrow();
  const item = entry();
  h.seedQueued(agent, item); h.admit(agent, item);
  let settled = false;
  const pending = h.backend.waitForCompletion(agent, item.messageId).finally(() => { settled = true; });
  const result = { id: item.messageId, fingerprint: contentFingerprint(userMessage(item)), state: 'completed', text: 'correct answer', reason: 'completed', turn: 1 };
  h.cells.set(agent.session, { ...h.projection.stateOf(agent.session), records: [result] });
  h.notify({ ...agent.session }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  h.notify({ id: OTHER_SESSION }, { type: 'turn/end', data: {} });
  h.notify(agent.session, { type: 'tool/result', data: {} });
  await nextTick();
  assert.equal(settled, false);
  h.notify(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  assert.deepEqual(await pending, result);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.backend.waiters.size, 0);
});

test('waiters settle only after their exact turn ends, not on assistant text or another turn end', async (t) => {
  const h = harness(t);
  const agent = h.borrow();
  const item = entry();
  h.seedQueued(agent, item); h.admit(agent, item, 5);
  let settled = false;
  const pending = h.backend.waitForCompletion(agent, item.messageId).finally(() => { settled = true; });
  h.publish(agent, 'assistant/message', { turn: 5, step: 1, stream: [], message: { role: 'assistant', content: [{ type: 'text', text: 'candidate' }] } }, { surfaceOp: 'append' });
  h.publish(agent, 'turn/end', { turn: 4, reason: { kind: 'completed' } });
  await nextTick();
  assert.equal(settled, false);
  h.publish(agent, 'turn/end', { turn: 5, reason: { kind: 'completed' } });
  assert.equal((await pending).text, 'candidate');
});

test('terminal state is checked immediately after subscribing, without waiting for another event', async (t) => {
  const h = harness(t);
  const agent = h.borrow();
  const item = entry();
  const expected = h.complete(agent, item);
  assert.deepEqual(await h.backend.waitForCompletion(agent, item.messageId), expected);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.backend.waiters.size, 0);
});

test('abort between ensureAgent and submission sends no followup', async (t) => {
  const h = harness(t);
  h.borrow();
  const controller = new AbortController();
  const pending = h.backend.run(entry(), controller.signal);
  controller.abort();
  await assert.rejects(pending, bridgeError('BUSY', 409));
  assert.equal(h.calls.followup.length, 0);
  assert.equal(h.calls.flush, 0);
});

for (const throws of [false, true]) {
  test(`parent cancellation cancels active work and cleans listeners even if cancel throws=${throws}`, async (t) => {
    const h = harness(t, { cancelError: throws ? new Error('queue write failed') : undefined });
    const agent = h.borrow();
    const item = entry();
    h.seedQueued(agent, item); h.admit(agent, item);
    const controller = new AbortController();
    const pending = h.backend.waitForCompletion(agent, item.messageId, controller.signal);
    const rejected = assert.rejects(pending, bridgeError('BUSY', 409));
    assert.equal(h.listeners.size, 1);
    controller.abort(new Error('PRIVATE_ABORT_REASON'));
    await rejected;
    assert.equal(h.calls.cancel.length, 1);
    assert.equal(h.calls.cancel[0].cause.kind, 'hook');
    assert.equal(h.listeners.size, 0);
    assert.equal(h.backend.waiters.size, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });
}

test('queued cancellation cannot be reentrantly resolved by cancel() publishing a canceled inbox splice', async (t) => {
  const h = harness(t);
  const agent = h.borrow(SESSION, { status: 'running' });
  const item = entry('not-yet-admitted');
  h.seedQueued(agent, item);
  const controller = new AbortController();
  const rejected = assert.rejects(h.backend.waitForCompletion(agent, item.messageId, controller.signal), bridgeError('BUSY', 409));
  controller.abort();
  await rejected;
  assert.equal(h.calls.cancel.length, 1);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.backend.waiters.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('queued deadlines retain timeout settlement despite synchronous cancel-generated inbox events', async (t) => {
  const h = harness(t, { timeoutMs: 15 });
  const agent = h.borrow(SESSION, { status: 'running' });
  const item = entry('deadline-before-admission');
  h.seedQueued(agent, item);
  const result = await h.backend.waitForCompletion(agent, item.messageId);
  assert.deepEqual(result, { state: 'failed', text: '', reason: 'timeout' });
  assert.equal(h.calls.cancel.length, 1);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.backend.waiters.size, 0);
});

test('pre-aborted completion waits release their subscription and cancel active work', async (t) => {
  const h = harness(t);
  const agent = h.borrow();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.backend.waitForCompletion(agent, entry().messageId, controller.signal), bridgeError('BUSY', 409));
  assert.equal(h.calls.cancel.length, 1);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.backend.waiters.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('response deadlines cancel the Agent and return a text-free timeout result with full cleanup', async (t) => {
  const h = harness(t, { timeoutMs: 15 });
  const agent = h.borrow();
  const item = entry();
  h.seedQueued(agent, item); h.admit(agent, item);
  const controller = new AbortController();
  assert.deepEqual(await h.backend.waitForCompletion(agent, item.messageId, controller.signal), { state: 'failed', text: '', reason: 'timeout' });
  assert.equal(h.calls.cancel.length, 1);
  assert.equal(h.calls.cancel[0].cause.kind, 'hook');
  assert.equal(h.listeners.size, 0);
  assert.equal(h.backend.waiters.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('stopWork cancels all current waiters but permits a later resumed operation', async (t) => {
  const h = harness(t);
  const first = h.borrow();
  const second = h.borrow(OTHER_SESSION);
  const firstItem = entry();
  const secondItem = entry('other', { sessionId: OTHER_SESSION });
  h.seedQueued(first, firstItem); h.admit(first, firstItem);
  h.seedQueued(second, secondItem); h.admit(second, secondItem);
  const stopped = [first, second].map((agent, index) => assert.rejects(
    h.backend.waitForCompletion(agent, [firstItem, secondItem][index].messageId), bridgeError('BUSY', 409),
  ));
  await h.backend.stopWork();
  await Promise.all(stopped);
  assert.equal(h.backend.closed, false);
  assert.equal(h.calls.cancel.length, 2);
  assert.equal(h.listeners.size, 0);
  assert.equal(h.backend.waiters.size, 0);
  const completion = h.complete(first, firstItem, 'after resume');
  assert.deepEqual(await h.backend.waitForCompletion(first, firstItem.messageId), completion);
});

test('close stops waiters, drains owned handles, clears bookkeeping, and is sequentially idempotent', async (t) => {
  const gate = deferred();
  const disposalsStarted = deferred();
  const h = harness(t, { onDispose: async () => { if (h.calls.dispose.length === 2) disposalsStarted.resolve(); await gate.promise; } });
  const first = await h.backend.ensureAgent(entry());
  const second = await h.backend.ensureAgent(entry('other', { sessionId: OTHER_SESSION }));
  const waiting = assert.rejects(h.backend.waitForCompletion(first, entry().messageId), bridgeError('BUSY', 409));
  let settled = false;
  const closing = h.backend.close().finally(() => { settled = true; });
  try {
    await disposalsStarted.promise;
    await waiting;
    assert.equal(h.backend.closed, true);
    assert.equal(settled, false, 'close returned before AgentHandle.dispose drained');
    assert.equal(h.listeners.size, 0);
    assert.equal(h.backend.waiters.size, 0);
    gate.resolve();
    await closing;
    assert.equal(h.backend.handles.size, 0);
    assert.equal(h.backend.live.size, 0);
    assert.equal(h.live.has(first.id), false);
    assert.equal(h.live.has(second.id), false);
    await h.backend.close();
    assert.equal(h.calls.dispose.length, 2);
  } finally { gate.resolve(); await closing.catch(() => {}); }
});

test('close attempts every owned disposer, clears maps, and propagates a disposal failure', async (t) => {
  const failure = new Error('dispose failed');
  const h = harness(t, { onDispose: async (agent) => { if (agent.id === SESSION) throw failure; } });
  await h.backend.ensureAgent(entry());
  await h.backend.ensureAgent(entry('other', { sessionId: OTHER_SESSION }));
  await assert.rejects(h.backend.close(), (error) => error === failure);
  assert.deepEqual(new Set(h.calls.dispose), new Set([SESSION, OTHER_SESSION]));
  assert.equal(h.backend.handles.size, 0);
  assert.equal(h.backend.live.size, 0);
});

test('isSafe combines live metadata and permanent projection contamination, failing closed on read errors', (t) => {
  const h = harness(t);
  assert.equal(h.backend.isSafe(SESSION), true);
  const agent = h.borrow();
  assert.equal(h.backend.isSafe(SESSION), true);
  h.presets.set(agent.session, 'other-preset');
  assert.equal(h.backend.isSafe(SESSION), false);
  h.presets.set(agent.session, PRESET_ID);
  h.cells.set(agent.session, { ...h.projection.stateOf(agent.session), contaminated: true });
  assert.equal(h.backend.isSafe(SESSION), false);
  const broken = harness(t, { projectionError: new Error('projection failed') });
  broken.borrow();
  assert.equal(broken.backend.isSafe(SESSION), false);
});

test('a failed submission flush does not make a retry issue duplicate followup', async (t) => {
  const failure = new Error('flush failed');
  const h = harness(t, { onFlush: async (count) => { if (count === 1) throw failure; } });
  const agent = h.borrow();
  const item = entry();
  await assert.rejects(h.backend.run(item), (error) => error === failure);
  assert.equal(h.calls.followup.length, 1);
  const retry = h.backend.run(item);
  await nextTick();
  assert.equal(h.calls.followup.length, 1);
  h.complete(agent, item, 'single answer after failed barrier');
  assert.equal((await retry).text, 'single answer after failed barrier');
  assert.equal(h.calls.followup.length, 1);
});

test('terminal flush failure propagates instead of acknowledging or resubmitting the answer', async (t) => {
  const failure = new Error('terminal flush failed');
  const h = harness(t, { onFlush: async () => { throw failure; } });
  const agent = h.borrow();
  const item = entry();
  h.complete(agent, item, 'not acknowledged before durable');
  await assert.rejects(h.backend.run(item), (error) => error === failure);
  assert.equal(h.calls.followup.length, 0);
  assert.equal(h.backend.waiters.size, 0);
});
