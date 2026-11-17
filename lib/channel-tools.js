import { BridgeError, CHANNEL_SESSION_PATTERN, SESSION_PATTERN } from './state.js';
import { bindScopedTools } from '../session-policy.js';

const BOOLEAN_PREFERENCES = ['streaming', 'sendProgress', 'sendToolHints', 'showReasoning'];
const PRIVATE_TOOL = /^(?:weixin_bridge|run_code|cordis(?:_|$)|session_|working_directory|team_|terminal|bash|pwsh|powershell|(?:exec|shell|job|plugin|worktree)(?:_|$))/i;
const isBridge = id => typeof id === 'string' && (SESSION_PATTERN.test(id) || CHANNEL_SESSION_PATTERN.test(id));
const allowedName = name => typeof name === 'string' && /^[\w.-]{1,128}$/.test(name) && !PRIVATE_TOOL.test(name)
  && (!name.startsWith('schedule_') || name === 'schedule_create');
const deny = { kind: 'deny', reason: 'This tool is outside the Message Channels permission for the active conversation.',
  info: { name: 'ChannelToolPermissionError', code: 'CHANNEL_TOOL_FORBIDDEN' } };

export function parseChannelPreferences(value, previous = { allowedTools: [] }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BridgeError('INVALID_REQUEST', '请输入有效的渠道权限。');
  }
  const result = { ...previous };
  for (const [key, setting] of Object.entries(value)) {
    if (key === 'allowedTools' && Array.isArray(setting) && setting.length <= 128 && setting.every(allowedName)) {
      result.allowedTools = [...new Set(setting)];
    } else if (BOOLEAN_PREFERENCES.includes(key) && typeof setting === 'boolean') {
      result[key] = setting;
    } else {
      throw new BridgeError('INVALID_REQUEST', '存在无效或不可授予的渠道权限。');
    }
  }
  return result;
}

export class ChannelTools {
  constructor({ stateOf, findAgent = () => undefined, globalNames = () => [], checkArguments = () => true }) {
    this.stateOf = stateOf;
    this.findAgent = findAgent;
    this.globalNames = globalNames;
    this.checkArguments = checkArguments;
    this.turns = new Map();
    this.idleMasks = new Map();
    this.parents = new WeakMap();
    this.approved = new WeakSet();
  }

  root(agent) {
    if (!agent) return undefined;
    if (isBridge(agent.id)) return agent.id;
    if (this.parents.has(agent)) return this.parents.get(agent);
    let parent = agent.session?.header;
    const seen = new Set([agent.id]);
    while (parent?.origin === 'subagent' && parent.parentSession && !seen.has(parent.parentSession)) {
      const id = parent.parentSession;
      seen.add(id);
      if (isBridge(id)) { this.parents.set(agent, id); return id; }
      const ancestor = this.findAgent(id);
      if (ancestor && this.parents.has(ancestor)) {
        const root = this.parents.get(ancestor);
        this.parents.set(agent, root);
        return root;
      }
      parent = ancestor?.session?.header;
    }
  }

  bind(agent, turn) {
    if (this.turns.has(agent.id)) throw new BridgeError('BUSY', '渠道会话已有任务在执行。', 409);
    this.unmask(agent);
    const names = turn.getPolicy().allowedTools;
    const definitions = new Map(agent.ctx?.tools.schemas(agent).filter(({ name }) => names.includes(name))
      .map(({ name }) => [name, agent.ctx.tools.get(name, agent)]) ?? []);
    const visible = definitions.size || agent.ctx ? [...definitions.keys()] : names;
    let unrestrict;
    try { unrestrict = agent.ctx?.tools.restrict({ allow: visible }); }
    catch {
      // Locally registered names are exempt from inherited masks and still go
      // through the scoped guard. Keep masking every inherited global name.
      const inherited = new Set(this.globalNames());
      unrestrict = agent.ctx?.tools.restrict({ allow: visible.filter(name => inherited.has(name)) });
    }
    const bound = { ...turn, agent, definitions, visible };
    const unbind = bindScopedTools(agent, execution => this.denial(execution));
    this.turns.set(agent.id, bound);
    return () => {
      if (this.turns.get(agent.id) === bound) this.turns.delete(agent.id);
      unbind();
      unrestrict?.();
      this.maskIdle(agent);
    };
  }

  maskIdle(agent) {
    if (this.closed || !agent.ctx || !isBridge(agent.id) || this.turns.has(agent.id) || this.idleMasks.has(agent)) return;
    this.idleMasks.set(agent, agent.ctx.tools.restrict({ allow: [] }));
  }

  unmask(agent) {
    this.idleMasks.get(agent)?.();
    this.idleMasks.delete(agent);
  }

  close() {
    this.closed = true;
    for (const agent of this.idleMasks.keys()) this.unmask(agent);
  }

  active(execution) {
    const id = this.root(execution.agent);
    if (!id) return undefined;
    const turn = this.turns.get(id);
    const state = turn && this.stateOf(turn.agent.session);
    if (!turn || turn.signal?.aborted || execution.signal?.aborted || state?.contaminated || state?.scheduleActive?.length
      || state?.active.length !== 1 || state.active[0] !== turn.messageId) return null;
    if (execution.agent === turn.agent || execution.agent.session?.header?.cwd === turn.agent.session.header.cwd) return turn;
    return null;
  }

  permits(execution) {
    const turn = this.active(execution);
    if (turn === undefined) return undefined;
    const { name, agent, arguments: args } = execution;
    if (!turn || !allowedName(name) || !turn.visible.includes(name) || !turn.getPolicy().allowedTools.includes(name)) return false;
    if (name.startsWith('schedule_') && (agent !== turn.agent || name !== 'schedule_create' || args?.target !== 'this_session')) return false;
    if (agent !== turn.agent && (name === 'channel_send' || /(?:subagent|spawn|delegate)/i.test(name))) return false;
    if (agent.ctx?.tools.get(name, agent) !== turn.definitions.get(name)) return false;
    return true;
  }

  async prepare(execution, ask, next) {
    const permitted = this.permits(execution);
    if (permitted === undefined) return next();
    if (!permitted) return deny;
    if (!await this.checkArguments(execution)) return deny;
    const downstream = await next();
    if (downstream.kind === 'deny' || downstream.kind === 'cancel') return downstream;
    const turn = this.active(execution);
    if (!turn) return deny;
    const { agent, name, callId, signal } = execution;
    const outcome = await ask?.({ agent, toolName: name, callId, signal,
      reason: downstream.reason ?? `Approve ${name} for this ${turn.channelId} message-channel conversation.` });
    if (outcome !== 'allowed-once' || !this.permits(execution) || !await this.checkArguments(execution)) return deny;
    this.approved.add(execution.token);
    return { kind: 'allow' };
  }

  denial(execution) {
    const permitted = this.permits(execution);
    return permitted === undefined || (permitted && this.approved.has(execution.token)) ? undefined : deny;
  }
}

export function channelToolChoices(schemas) {
  return [...new Set(schemas.map(({ name }) => name).filter(allowedName))].sort();
}
