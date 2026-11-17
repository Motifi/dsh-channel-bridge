import { BridgeError, PRESET_ID, SESSION_PATTERN } from './state.js';
import { completionOf, contentFingerprint } from './projection.js';

/** The DSH adapter. All model calls pass through public Agent APIs. */
export class AgentBackend {
  constructor(ctx, { projection, workspaceDir, timeoutMs = 180000,
    presetId = PRESET_ID, sessionPattern = SESSION_PATTERN }) {
    this.ctx = ctx;
    this.projection = projection;
    this.workspaceDir = workspaceDir;
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
    let agent = this.ctx.agents.get(entry.sessionId);
    if (agent) {
      this.assertIsolated(agent);
      this.live.set(agent.id, agent);
      return agent;
    }
    const selection = this.model();
    if (!selection) throw new BridgeError('MODEL_UNAVAILABLE', '请先在 DSH 的模型设置中选择可用模型。', 409);
    const stored = await this.ctx.sessionPersistence.stat(entry.sessionId, { signal });
    if (stored && (stored.header.agentPreset !== this.presetId || stored.header.cwd !== this.workspaceDir)) {
      throw new BridgeError('FORBIDDEN', '此会话不属于隔离的渠道聊天，已拒绝复用。', 403);
    }
    const setup = async (agentCtx) => {
      await this.ctx.agentPresets.mount(agentCtx, this.presetId);
    };
    const handle = stored
      ? await this.ctx.agents.resume({ resumeSessionId: entry.sessionId, setup, signal })
      : await this.ctx.agents.create({
        sessionId: entry.sessionId,
        meta: { cwd: this.workspaceDir, agentPreset: this.presetId },
        agentOptions: { ...selection, maxTokens: 3000 }, setup, signal,
      });
    if (this.closed || signal?.aborted) { await handle.dispose(); throw new BridgeError('BUSY', '渠道会话已暂停。', 409); }
    agent = handle.agent;
    try { this.assertIsolated(agent); }
    catch (error) { await handle.dispose(); throw error; }
    this.handles.set(agent.id, handle);
    this.live.set(agent.id, agent);
    return agent;
  }

  assertIsolated(agent) {
    if (agent.session.header.cwd !== this.workspaceDir
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

  async run(entry, signal) {
    const agent = await this.ensureAgent(entry, signal);
    const existing = completionOf(this.projection.stateOf(agent.session), entry.messageId);
    const content = [...(entry.text ? [{ type: 'text', text: entry.text }] : []), ...(entry.content ?? [])];
    const fingerprint = contentFingerprint({ content });
    if (existing?.fingerprint && existing.fingerprint !== fingerprint) {
      return this.settled({ state: 'failed', text: '', reason: 'contaminated' });
    }
    if (!existing) {
      if (signal?.aborted) throw new BridgeError('BUSY', '渠道会话已暂停。', 409);
      const message = Object.freeze({
        id: entry.messageId, role: 'user', source: Object.freeze({ kind: 'user' }),
        content: Object.freeze(content.map(part => Object.freeze(part))),
      });
      agent.followup(message);
      // Acknowledge the receipt only after the durable inbox reaches its barrier.
      await this.ctx.sessionPersistence.flush();
    } else if (['completed', 'failed'].includes(existing.state)) {
      return this.settled(existing);
    } else if (agent.status === 'idle') {
      const pending = agent.inbox.nextTurn.find(message => message.id === entry.messageId);
      if (existing.state !== 'queued' || !pending || contentFingerprint(pending) !== fingerprint) {
        return this.settled({ state: 'failed', text: '', reason: pending ? 'contaminated' : 'interrupted' });
      }
      // Resume restores the durable inbox but does not wake it. Move the one
      // still-unclaimed original message atomically, then use the public wake API.
      agent.inbox.remove(entry.messageId);
      agent.followup(pending);
      await this.ctx.sessionPersistence.flush();
    }
    return this.settled(await this.waitForCompletion(agent, entry.messageId, signal));
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
    await this.stopWork();
    const results = await Promise.allSettled([...this.handles.values()].map(handle => handle.dispose()));
    this.handles.clear(); this.live.clear();
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}
