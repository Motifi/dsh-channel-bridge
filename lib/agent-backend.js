import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { BridgeError, MAX_REPLY_CHARS, PRESET_ID, SESSION_PATTERN, hash } from './state.js';
import { applyProjection, completionOf, contentFingerprint, initialProjection } from './projection.js';

const COMPACT_COMMAND = '@deepseek-ai/dsh-command-compact';
const COMMAND_HELP = '会话命令：/help、/new、/stop、/status、/model、/model 服务商/模型、/skill、/compact。';
const COMMAND_RESULT_UNKNOWN = '上一条命令的执行结果无法确认，请在 DSH 查看会话状态。';
const SELECT_MODEL = /^\/model[ \t]+([a-z\d._-]{1,96})\/([a-z\d._:@/-]{1,160})$/i;
const receiptHash = z.string().regex(/^[a-f0-9]{64}$/);
export const commandDomainSpec = {
  name: 'channelcommands', version: 1,
  tables: {
    schedule_relay: { valueSchema: z.union([
      z.object({ enabledAt: z.number().int().nonnegative() }).strict(),
      z.object({ deliveredSeq: z.number().int().nonnegative() }).strict(),
    ]) },
  },
  global: {
    schema: z.array(z.object({ key: receiptHash, fingerprint: receiptHash,
      text: z.string().max(MAX_REPLY_CHARS).optional() }).strict()).max(500),
    initial: [],
  },
};

const MAX_SCHEDULE_BATCH = 64;
const LOG_BATCH = 256;

async function awaitAvailable(operation, signal) {
  signal.throwIfAborted();
  const aborted = Promise.withResolvers();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try { return await Promise.race([Promise.resolve().then(operation), aborted.promise]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

async function readScheduled(handle, previous, deliveredSeq, enabledAt, signal) {
  let offset = previous?.offset ?? 0;
  let view = previous?.view ?? initialProjection(handle.header);
  let pending = previous?.pending.filter(receipt => receipt.seq > deliveredSeq) ?? [];
  let overflow = previous?.overflow ?? false;
  while (!view.contaminated && !signal.aborted) {
    const { events } = await handle.read(offset, LOG_BATCH, { signal });
    for (const event of events) {
      view = applyProjection(view, event);
      const receipt = view.scheduleResult;
      if (receipt && receipt.seq === event.seq && receipt.seq > deliveredSeq && receipt.time >= enabledAt) {
        if (pending.length < MAX_SCHEDULE_BATCH) pending.push(receipt);
        else overflow = true;
      }
    }
    offset += events.length;
    if (events.length < LOG_BATCH) break;
  }
  if (view.contaminated) pending = [];
  return { offset, view, pending, overflow };
}

export function createCommandReceipts(global) {
  let tail = Promise.resolve();
  const serialize = work => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
  return {
    claim(key, fingerprint) {
      return serialize(async () => {
        const current = global.get();
        const existing = current.find(receipt => receipt.key === key);
        if (existing) return existing;
        await global.set([...current, { key, fingerprint }].slice(-500));
      });
    },
    finish(key, fingerprint, text) {
      return serialize(async () => {
        const current = global.get();
        await global.set([...current.filter(receipt => receipt.key !== key), { key, fingerprint, text }].slice(-500));
      });
    },
  };
}

/** The DSH adapter. All model calls pass through public Agent APIs. */
export class AgentBackend {
  constructor(ctx, { projection, workspaceDir, timeoutMs = 180000,
    presetId = PRESET_ID, sessionPattern = SESSION_PATTERN, workspaceForSession, commandReceipts }) {
    this.ctx = ctx;
    this.projection = projection;
    this.workspaceDir = workspaceDir;
    this.workspaceForSession = workspaceForSession;
    this.commandReceipts = commandReceipts;
    this.workspaces = new WeakMap();
    this.timeoutMs = timeoutMs;
    this.presetId = presetId;
    this.sessionPattern = sessionPattern;
    this.handles = new Map();
    this.live = new Map();
    this.waiters = new Set();
    this.closed = false;
  }

  model() {
    try {
      const selection = this.ctx.agentDefaultModel.currentSelection();
      return selection?.provider && selection?.model ? selection : null;
    } catch { return null; }
  }

  async ensureAgent(entry, signal) {
    if (this.closed || signal?.aborted) throw new BridgeError('BUSY', '渠道会话已暂停。', 409);
    if (!this.sessionPattern.test(entry.sessionId)) throw new BridgeError('INVALID_REQUEST', '无效的渠道会话。');
    const workspace = this.workspaceForSession ? await this.workspaceForSession(entry.sessionId) : this.workspaceDir;
    if (typeof workspace !== 'string' || !isAbsolute(workspace)) {
      throw new BridgeError('FORBIDDEN', '无法为渠道会话分配隔离工作区。', 403);
    }
    if (this.closed || signal?.aborted) throw new BridgeError('BUSY', '渠道会话已暂停。', 409);
    let agent = this.ctx.agents.get(entry.sessionId);
    if (agent) {
      this.assertIsolated(agent, workspace);
      this.workspaces.set(agent, agent.session.header.cwd);
      this.live.set(agent.id, agent);
      return agent;
    }
    const selection = this.model();
    if (!selection) throw new BridgeError('MODEL_UNAVAILABLE', '请先在 DSH 的模型设置中选择可用模型。', 409);
    const stored = await this.ctx.sessionPersistence.stat(entry.sessionId, { signal });
    if (stored && (stored.header.agentPreset !== this.presetId
      || (stored.header.cwd !== workspace && stored.header.cwd !== this.workspaceDir))) {
      throw new BridgeError('FORBIDDEN', '此会话不属于隔离的渠道聊天，已拒绝复用。', 403);
    }
    const setup = async (agentCtx) => {
      await this.ctx.agentPresets.mount(agentCtx, this.presetId);
    };
    const handle = stored
      ? await this.ctx.agents.resume({ resumeSessionId: entry.sessionId, setup, signal })
      : await this.ctx.agents.create({
        sessionId: entry.sessionId,
        meta: { cwd: workspace, agentPreset: this.presetId },
        agentOptions: { ...selection, maxTokens: 3000 }, setup, signal,
      });
    if (this.closed || signal?.aborted) { await handle.dispose(); throw new BridgeError('BUSY', '渠道会话已暂停。', 409); }
    agent = handle.agent;
    try {
      const cwd = stored?.header.cwd ?? workspace;
      if (agent.session.header.cwd !== cwd) throw new BridgeError('FORBIDDEN', '渠道会话的工作区不匹配。', 403);
      this.assertIsolated(agent, workspace);
      this.workspaces.set(agent, cwd);
    }
    catch (error) { await handle.dispose(); throw error; }
    this.handles.set(agent.id, handle);
    this.live.set(agent.id, agent);
    return agent;
  }

  assertIsolated(agent, workspace) {
    const cwd = agent.session.header.cwd;
    const known = this.workspaces.get(agent);
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || (known !== undefined && cwd !== known)
      || (cwd !== this.workspaceDir && cwd !== (workspace ?? known))
      || this.ctx.agentPresets.presetForSession(agent.session) !== this.presetId) {
      throw new BridgeError('FORBIDDEN', '此会话的工作区或预设已改变，已停止渠道接入。', 403);
    }
  }

  isSafe(sessionId) {
    const agent = this.ctx.agents.get(sessionId);
    if (!agent) return true;
    try { this.assertIsolated(agent); return !this.projection.stateOf(agent.session).contaminated; }
    catch { return false; }
  }

  async hasSession(sessionId, signal) {
    if (this.closed || signal?.aborted || typeof sessionId !== 'string' || !this.sessionPattern.test(sessionId)) return false;
    try {
      const agent = this.ctx.agents.get(sessionId);
      const stored = agent ? undefined : await this.ctx.sessionPersistence.stat(sessionId, { signal });
      if ((!agent && !stored) || this.closed || signal?.aborted) return false;
      const workspace = this.workspaceForSession ? await this.workspaceForSession(sessionId) : this.workspaceDir;
      if (this.closed || signal?.aborted) return false;
      if (!agent) return stored.header.id === sessionId && stored.header.agentPreset === this.presetId
        && typeof stored.header.cwd === 'string' && isAbsolute(stored.header.cwd)
        && (stored.header.cwd === workspace || stored.header.cwd === this.workspaceDir);
      if (agent.id !== sessionId || this.ctx.agents.get(sessionId) !== agent) return false;
      this.assertIsolated(agent, workspace);
      this.workspaces.set(agent, agent.session.header.cwd);
      return !this.projection.stateOf(agent.session).contaminated;
    } catch { return false; }
  }

  interrupt(sessionId) {
    if (this.closed || typeof sessionId !== 'string' || !this.sessionPattern.test(sessionId)) return false;
    const agent = this.ctx.agents.get(sessionId);
    if (!agent || agent.id !== sessionId || agent.status === 'idle') return false;
    try {
      this.assertIsolated(agent);
      if (this.projection.stateOf(agent.session).contaminated) return false;
      agent.cancel({ kind: 'hook', reason: 'Message channel stop command' });
      return true;
    } catch { return false; }
  }

  startScheduleRelay({ listSessions, send, state, retryMs = 15_000 }) {
    if (this.stopScheduleRelay || this.closed || !state) return;
    const controller = new AbortController();
    const { signal } = controller;
    const observed = new Map();
    let running;
    let requested = false;
    const reconcile = async () => {
      let { enabledAt } = state.get(this.presetId) ?? {};
      if (enabledAt === undefined) {
        enabledAt = Date.now();
        await state.put(this.presetId, { enabledAt });
      }
      const sessions = new Set(await listSessions());
      for (const id of observed.keys()) if (!sessions.has(id)) observed.delete(id);
      let flush;
      for (const sessionId of sessions) {
        if (signal.aborted) break;
        try {
          if (!await this.hasSession(sessionId, signal)) continue;
          if (this.ctx.agents.get(sessionId)) await (flush ??= this.ctx.sessionPersistence.flush());
          const stored = await this.ctx.sessionPersistence.stat(sessionId, { signal });
          if (!stored) continue;
          const deliveredSeq = state.get(sessionId)?.deliveredSeq ?? -1;
          let snapshot = observed.get(sessionId);
          if (!snapshot || snapshot.revision !== stored.revision) {
            const handle = await this.ctx.sessionPersistence.open(sessionId, 'read', { signal });
            try {
              if (handle.header.id !== sessionId || handle.header.agentPreset !== this.presetId
                || handle.header.cwd !== stored.header.cwd || handle.inheritedEventCount !== 0) continue;
              snapshot = { ...await readScheduled(handle, snapshot, deliveredSeq, enabledAt, signal), revision: stored.revision };
              observed.set(sessionId, snapshot);
            } finally { await handle.close(); }
          }
          while (snapshot.pending.length && !signal.aborted) {
            const { messageId, text, seq } = snapshot.pending[0];
            if (!await this.hasSession(sessionId, signal) || !await send({ sessionId, messageId, text })) break;
            await state.put(sessionId, { deliveredSeq: seq });
            snapshot.pending.shift();
          }
          if (!snapshot.pending.length && snapshot.overflow) observed.delete(sessionId);
        } catch {
          // The next reconciliation retries the same durable outcome, without
          // advancing its cursor if routing or persistence could not complete.
        }
      }
    };
    const wake = () => {
      if (signal.aborted) return;
      if (running) { requested = true; return; }
      running = reconcile().catch(() => {}).finally(() => {
        running = undefined;
        if (requested) { requested = false; wake(); }
      });
    };
    const off = this.ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end' && this.sessionPattern.test(session.header.id)
        && this.projection.stateOf(session).scheduleResult?.seq === event.seq) wake();
    });
    const timer = setInterval(wake, retryMs);
    timer.unref();
    this.stopScheduleRelay = async () => {
      controller.abort();
      off();
      clearInterval(timer);
      await running;
    };
    wake();
    return this.stopScheduleRelay;
  }

  async run(entry, signal, onUpdate) {
    const agent = await this.ensureAgent(entry, signal);
    const existing = completionOf(this.projection.stateOf(agent.session), entry.messageId);
    const content = [...(entry.text ? [{ type: 'text', text: entry.text }] : []), ...(entry.content ?? [])];
    const fingerprint = contentFingerprint({ content });
    if (existing?.fingerprint && existing.fingerprint !== fingerprint) {
      return this.settled({ state: 'failed', text: '', reason: 'contaminated' });
    }
    if (existing && ['completed', 'failed'].includes(existing.state)) {
      return this.settled(existing);
    }
    const command = typeof entry.text === 'string' ? entry.text.trim() : '';
    if (!existing && !entry.content?.length && /^\/[a-z][a-z0-9_-]*(?=\s|$)/i.test(command)) {
      return this.runCommand(agent, entry, command, fingerprint, signal);
    }
    let disposeTools;
    const off = typeof onUpdate === 'function' ? this.observeTurn(agent, entry, onUpdate) : undefined;
    try {
      if (!existing) {
        if (signal?.aborted) throw new BridgeError('BUSY', '渠道会话已暂停。', 409);
        const message = Object.freeze({
          id: entry.messageId, role: 'user', source: Object.freeze({ kind: 'user' }),
          content: Object.freeze(content.map(part => Object.freeze(part))),
        });
        if (entry.admitTools) disposeTools = await entry.admitTools(agent);
        if (this.closed || signal?.aborted) throw new BridgeError('BUSY', '渠道会话已暂停。', 409);
        agent.followup(message);
        // Acknowledge the receipt only after the durable inbox reaches its barrier.
        await this.ctx.sessionPersistence.flush();
      } else if (agent.status === 'idle') {
        const pending = agent.inbox.nextTurn.find(message => message.id === entry.messageId);
        if (existing.state !== 'queued' || !pending || contentFingerprint(pending) !== fingerprint) {
          return this.settled({ state: 'failed', text: '', reason: pending ? 'contaminated' : 'interrupted' });
        }
        if (entry.admitTools) disposeTools = await entry.admitTools(agent);
        if (this.closed || signal?.aborted) throw new BridgeError('BUSY', '渠道会话已暂停。', 409);
        // Resume restores the durable inbox but does not wake it. Move the one
        // still-unclaimed original message atomically, then use the public wake API.
        agent.inbox.remove(entry.messageId);
        agent.followup(pending);
        await this.ctx.sessionPersistence.flush();
      }
      return await this.settled(await this.waitForCompletion(agent, entry.messageId, signal));
    } finally {
      off?.();
      await disposeTools?.();
    }
  }

  async runCommand(agent, entry, command, fingerprint, signal) {
    // A crash after the durable intent may have left a committed mutation.
    // Do not repeat the command when the delivery outcome is unknown.
    const reply = text => this.settled({ state: 'completed', text, reason: 'completed' });
    const service = name => this.ctx.get ? this.ctx.get(name) : this.ctx[name];
    if (command === '/model' || command === '/status') {
      const selected = agent.model?.current?.();
      const label = selected?.provider && selected.model ? `${selected.provider}/${selected.model}`.slice(0, 240) : '未配置';
      return reply(command === '/model' ? `当前模型：${label}`
        : `会话状态：${agent.status === 'idle' ? '空闲' : '处理中'}\n当前模型：${label}`);
    }
    if (command === '/skill') {
      const skills = agent.ctx?.get?.('skills') ?? service('skills');
      const readSignal = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
      try {
        const entries = await awaitAvailable(() => skills?.list({ cwd: agent.session.header.cwd, scope: agent, signal: readSignal }), readSignal);
        const names = (entries ?? []).filter(skill => skill.invocation?.userInvocable
          && typeof skill.name === 'string' && /^[a-z\d][a-z\d-]{0,79}$/i.test(skill.name))
          .slice(0, 64).map(skill => skill.name);
        return reply(names.length ? `此会话可见技能：${names.join('、')}` : '此会话没有可列出的技能。');
      } catch { return reply('暂时无法读取此会话的技能。'); }
    }
    const modelRoute = SELECT_MODEL.exec(command);
    const compact = command === '/compact';
    if (!compact && !modelRoute) return reply(COMMAND_HELP);
    if (agent.status !== 'idle') return reply('请等待当前会话回复完成后再执行此命令。');
    const commands = compact ? service('commands') : undefined;
    const llm = modelRoute ? service('llm') : undefined;
    if (compact && commands?.find(agent, 'compact')?.definitionId !== COMPACT_COMMAND) {
      return reply('当前 DSH 没有启用会话压缩命令。');
    }
    if (modelRoute && (!llm?.listModels || !agent.model?.select)) return reply('当前 DSH 无法选择此会话的模型。');
    if (!this.commandReceipts) return reply('当前 DSH 无法保存此会话的命令状态。');
    const controller = new AbortController();
    const commandSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]);
    const stop = () => controller.abort(new BridgeError('BUSY', '渠道会话已暂停。', 409));
    this.waiters.add(stop);
    try {
      if (this.closed || commandSignal.aborted) throw new BridgeError('BUSY', '渠道会话已暂停。', 409);
      const key = hash(JSON.stringify([agent.id, entry.messageId]));
      const existing = await this.commandReceipts.claim(key, fingerprint);
      if (existing) {
        return existing.fingerprint === fingerprint ? reply(existing.text || COMMAND_RESULT_UNKNOWN)
          : this.settled({ state: 'failed', text: '', reason: 'contaminated' });
      }
      if (commandSignal.aborted) throw new BridgeError('BUSY', '渠道会话已暂停。', 409);
      let text;
      try {
        if (compact) {
          // Re-check the definition after the async durability barrier.
          const execution = commands.find(agent, 'compact')?.definitionId === COMPACT_COMMAND && agent.status === 'idle'
            && !this.projection.stateOf(agent.session).contaminated
            ? await commands.execute(agent, '/compact', [], commandSignal) : undefined;
          text = typeof execution?.result?.text === 'string' && execution.result.text.trim()
            ? execution.result.text.trim().slice(0, MAX_REPLY_CHARS) : '会话压缩未完成，请在 DSH 查看状态。';
        } else {
          const [, provider, model] = modelRoute;
          const catalog = await awaitAvailable(() => llm.listModels(provider), commandSignal);
          if (commandSignal.aborted || agent.status !== 'idle' || this.projection.stateOf(agent.session).contaminated) {
            text = '会话模型未修改，请在 DSH 查看状态。';
          } else if (!catalog.some(item => item.provider === provider && item.id === model)) {
            text = 'DSH 当前模型目录没有这个服务商与模型组合。';
          } else {
            agent.model.select({ provider, model });
            text = `此会话的后续消息将使用 ${provider}/${model}。`;
          }
        }
      } catch {
        text = compact ? '会话压缩未完成，请在 DSH 查看状态。' : '无法选择该模型，请在 DSH 检查模型目录。';
      }
      await this.ctx.sessionPersistence.flush();
      await this.commandReceipts.finish(key, fingerprint, text);
      return { state: 'completed', text, reason: 'completed' };
    } finally {
      this.waiters.delete(stop);
    }
  }

  observeTurn(agent, entry, onUpdate) {
    const { messageId, allowReasoning } = entry;
    let attempt;
    let latestRevision = 0;
    let textBudget = MAX_REPLY_CHARS;
    let reasoningBudget = MAX_REPLY_CHARS;
    let hintBudget = 64;
    const scopedTurn = () => {
      const state = this.projection.stateOf(agent.session);
      if (!state.contaminated && !state.scheduleActive?.length && state.active.length === 1 && state.active[0] === messageId) return state.turn;
    };
    const emit = (type, text, metadata) => {
      try { Promise.resolve(onUpdate({ type, text, metadata })).catch(() => {}); }
      catch { /* Transport presentation never interrupts the Agent. */ }
    };
    const events = this.ctx.on('session/event', (session, event) => {
      if (session !== agent.session || (event.type !== 'user/message' && event.type !== 'tool/call')) return;
      const turn = scopedTurn();
      if (turn === undefined || !hintBudget) return;
      if (event.type === 'user/message' && event.data.id === messageId && event.surfaceOp === 'append') {
        hintBudget--;
        emit('progress', '正在处理', { turn });
      } else if (event.type === 'tool/call' && event.data.turn === turn && typeof event.data.name === 'string'
        && /^[a-z\d_-]{1,80}$/i.test(event.data.name)) {
        hintBudget--;
        emit('tool', event.data.name, { turn, step: event.data.step, name: event.data.name });
      }
    });
    const stream = this.ctx.on('agent/assistant-stream', ({ agent: source, frame }) => {
      if (source !== agent) return;
      if (frame.type === 'start') {
        if (frame.turn !== scopedTurn() || frame.revision <= latestRevision) return;
        latestRevision = frame.revision;
        attempt = frame;
        return;
      }
      if (!attempt || attempt.attemptId !== frame.attemptId || latestRevision >= frame.revision
        || attempt.turn !== scopedTurn()) return;
      latestRevision = frame.revision;
      if (frame.type === 'end') { attempt = undefined; return; }
      const { chunk } = frame;
      if (!chunk || typeof chunk.text !== 'string' || !chunk.text) return;
      const meta = { turn: attempt.turn, step: attempt.step, revision: frame.revision, index: frame.index };
      if (chunk.type === 'text-delta' && textBudget) {
        const text = chunk.text.slice(0, textBudget);
        textBudget -= text.length;
        emit('delta', text, meta);
      } else if (chunk.type === 'reasoning-delta' && allowReasoning === true && reasoningBudget) {
        const text = chunk.text.slice(0, reasoningBudget);
        reasoningBudget -= text.length;
        emit('reasoning', text, meta);
      }
    }, { global: true });
    return () => { stream(); events(); };
  }

  async settled(result) {
    // A committed turn/end is in-memory until this durability barrier resolves.
    await this.ctx.sessionPersistence.flush();
    return result;
  }

  waitForCompletion(agent, messageId, signal) {
    return new Promise((resolve, reject) => {
      let done = false;
      let off;
      let timer;
      const cleanup = () => {
        off?.(); clearTimeout(timer); signal?.removeEventListener('abort', abort);
        this.waiters.delete(stop);
      };
      const finish = (value, error) => {
        if (done) return;
        done = true; cleanup();
        if (error) reject(error); else resolve(value);
      };
      const stop = () => {
        // cancel() can synchronously publish canceled inbox splices. Detach first.
        finish(undefined, new BridgeError('BUSY', '渠道会话已暂停。', 409));
        try { agent.cancel({ kind: 'hook', reason: 'Message channel paused' }); } catch { /* disposal still drains */ }
      };
      const abort = () => stop();
      const check = () => {
        const record = completionOf(this.projection.stateOf(agent.session), messageId);
        if (record && ['completed', 'failed'].includes(record.state)) finish(record);
      };
      this.waiters.add(stop);
      off = this.ctx.on('session/event', (session, event) => {
        if (session === agent.session && ['turn/end', 'agent/inbox/spliced', 'user/message'].includes(event.type)) check();
      });
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        finish({ state: 'failed', text: '', reason: 'timeout' });
        try { agent.cancel({ kind: 'hook', reason: 'Message channel response deadline exceeded' }); } catch { /* fail closed */ }
      }, this.timeoutMs);
      if (signal?.aborted || this.closed) stop(); else check();
    });
  }

  async stopWork() {
    for (const stop of [...this.waiters]) stop();
  }
  async close() {
    this.closed = true;
    await this.stopScheduleRelay?.();
    await this.stopWork();
    const results = await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()));
    this.handles.clear(); this.live.clear();
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}
