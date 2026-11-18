import { BridgeError, CHANNEL_SESSION_PATTERN, SESSION_PATTERN } from './state.js';

const isBridgeSession = id => typeof id === 'string'
  && (SESSION_PATTERN.test(id) || CHANNEL_SESSION_PATTERN.test(id));

export class ChannelTurns {
  constructor({ stateOf, findAgent }) {
    this.stateOf = stateOf;
    this.findAgent = findAgent;
    this.turns = new Map();
  }

  canManageBridge(agent) {
    const seen = new Set();
    while (agent && !seen.has(agent.id)) {
      if (isBridgeSession(agent.id)) return false;
      const { origin, parentSession } = agent.session.header;
      if (origin !== 'subagent') return true;
      if (!parentSession || isBridgeSession(parentSession)) return false;
      seen.add(agent.id);
      agent = this.findAgent(parentSession);
    }
    return false;
  }

  bind(agent, turn) {
    if (this.turns.has(agent)) throw new BridgeError('BUSY', '渠道会话已有任务在执行。', 409);
    this.turns.set(agent, turn);
    return () => {
      if (this.turns.get(agent) === turn) this.turns.delete(agent);
    };
  }

  bound(agent, signal) {
    const turn = this.turns.get(agent);
    if (turn && !turn.signal?.aborted && !signal?.aborted) return turn;
  }

  active(agent, signal) {
    const turn = this.bound(agent, signal);
    if (!turn) return undefined;
    const state = this.stateOf(agent.session);
    if (!state.contaminated && !state.scheduleActive?.length
      && state.active.length === 1 && state.active[0] === turn.messageId) return turn;
  }
}
