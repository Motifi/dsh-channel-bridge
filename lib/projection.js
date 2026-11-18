import { CHANNEL_MESSAGE_PATTERN, CHANNEL_SESSION_PATTERN, MAX_REPLY_CHARS, MESSAGE_PATTERN, SESSION_PATTERN, hash } from './state.js';

const NATIVE_MESSAGE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const isNativeUserMessage = message => message?.role === 'user'
  && typeof message.id === 'string' && NATIVE_MESSAGE_ID.test(message.id);
const isScheduleMessage = message => message?.source?.kind === 'schedule' && message.role === 'user'
  && isNativeUserMessage(message);
const HOST_CONTEXT_FORMS = new Map([
  ['agent-instructions', 'instructions'],
  ['agent-message', 'relay'],
  ['model-selection', 'notice'],
  ['plan-mode', 'notice'],
  ['skill-catalog', 'catalog'],
  ['skill-invocation', 'instructions'],
  ['subagent-settled', 'notice'],
  ['time-context', 'snapshot'],
  ['tool-goal', 'notice'],
]);
const isHostContext = message => message?.source?.kind === 'runtime-context' || (isNativeUserMessage(message)
  && (message.source?.kind === 'working-directory' || message.source?.kind === 'user-approval'
    || (typeof message.source?.form === 'string'
    && HOST_CONTEXT_FORMS.get(message.source.kind) === message.source.form)));

export function initialProjection(header) {
  const channel = Boolean(header && CHANNEL_SESSION_PATTERN.test(header.id));
  return { eligible: header ? SESSION_PATTERN.test(header.id) || channel : true,
    ...(channel ? { channel } : {}),
    turn: 0, active: [], scheduleActive: [], candidate: '', contaminated: false,
    records: [], inbox: { 'next-turn': [], 'next-step': [] } };
}
export function contentFingerprint(message) { return hash(JSON.stringify(message?.content ?? [])); }
function remember(records, record) {
  return [...records.filter(item => item.id !== record.id), record].slice(-500);
}
function finalText(message, interrupted) {
  if (interrupted || !Array.isArray(message?.content) || message.content.some(block => block.type === 'tool-call')) return '';
  return message.content.filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n').slice(0, MAX_REPLY_CHARS + 200).trim();
}

/** Pure incremental fold. No network, writes, or transcript rescans in apply(). */
export function applyProjection(previous, event) {
  if (!previous.eligible) return previous;
  const pattern = previous.channel ? CHANNEL_MESSAGE_PATTERN : MESSAGE_PATTERN;
  const isBridgeMessage = message => typeof message?.id === 'string' && pattern.test(message.id);
  const isForeignMessage = message => !isBridgeMessage(message) && !isScheduleMessage(message) && !isHostContext(message);
  switch (event.type) {
    case 'agent/inbox/spliced': {
      const data = event.data;
      if (data.target !== 'next-turn' && data.target !== 'next-step') return previous;
      const inserted = Array.isArray(data.inserted) ? data.inserted : [];
      const before = previous.inbox[data.target];
      const after = [...before];
      const removed = after.splice(data.start, data.removedCount ?? 0, ...inserted.map(item => item.id));
      let records = previous.records;
      let altered = false;
      for (const message of inserted) {
        if (!isBridgeMessage(message)) continue;
        const existing = records.find(record => record.id === message.id);
        const fingerprint = contentFingerprint(message);
        if (existing && existing.fingerprint !== fingerprint) altered = true;
        if (!existing || (existing.state === 'failed' && existing.reason === 'canceled' && existing.fingerprint === fingerprint)) {
          records = remember(records, { id: message.id, fingerprint, state: 'queued', turn: 0, text: '', reason: '' });
        }
      }
      if (data.outcome === 'canceled') {
        records = records.map(record => removed.includes(record.id)
          ? { ...record, state: 'failed', text: '', reason: 'canceled' } : record);
      }
      return { ...previous, records, contaminated: previous.contaminated || altered || inserted.some(isForeignMessage),
        inbox: { ...previous.inbox, [data.target]: after } };
    }
    case 'turn/start':
      return { ...previous, turn: event.data.turn, active: [], scheduleActive: [], candidate: '' };
    case 'user/message': {
      // Compaction replacements are not new user submissions.
      if (event.surfaceOp && event.surfaceOp !== 'append') return previous;
      const message = event.data;
      if (event.surfaceOp === 'append' && isScheduleMessage(message)) {
        return { ...previous, scheduleActive: [...new Set([...(previous.scheduleActive ?? []), message.id])] };
      }
      if (!isBridgeMessage(message)) {
        return isForeignMessage(message) && !previous.contaminated
          ? { ...previous, contaminated: true } : previous;
      }
      const existing = previous.records.find(record => record.id === message.id);
      const fingerprint = contentFingerprint(message);
      return { ...previous,
        active: [...new Set([...previous.active, message.id])],
        contaminated: previous.contaminated || Boolean(existing && existing.fingerprint !== fingerprint),
        records: remember(previous.records, { id: message.id, fingerprint: existing?.fingerprint || fingerprint,
          state: 'running', turn: previous.turn, text: '', reason: '' }),
      };
    }
    case 'assistant/message':
      if (event.data.turn !== previous.turn || (!previous.active.length && !previous.scheduleActive?.length)) return previous;
      return { ...previous, candidate: finalText(event.data.message, event.data.interrupted) };
    case 'turn/end': {
      const scheduledId = previous.scheduleActive?.[0];
      if (event.data.turn !== previous.turn || (!previous.active.length && !scheduledId)) return previous;
      const reason = previous.contaminated ? 'contaminated' : scheduledId && previous.active.length ? 'mixed-turn' : (event.data.reason?.kind ?? 'error');
      const successful = reason === 'completed' && Boolean(previous.candidate);
      const records = previous.records.map(record => previous.active.includes(record.id)
        ? { ...record, state: successful ? 'completed' : 'failed', text: successful ? previous.candidate : '', reason }
        : record);
      const scheduleResult = successful && scheduledId
        ? { messageId: scheduledId, seq: event.seq, time: event.time, text: previous.candidate }
        : previous.scheduleResult;
      return { ...previous, ...(scheduleResult ? { scheduleResult } : {}), records, active: [], scheduleActive: [], candidate: '' };
    }
    default:
      return previous;
  }
}

export function completionOf(state, id) {
  if (state.contaminated) return { state: 'failed', text: '', reason: 'contaminated' };
  return state.records.find(record => record.id === id);
}
