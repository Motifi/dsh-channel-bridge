import { MAX_REPLY_CHARS, MESSAGE_PATTERN, SESSION_PATTERN, hash } from './state.js';

export function initialProjection(header) {
  return { eligible: header ? SESSION_PATTERN.test(header.id) : true,
    turn: 0, active: [], candidate: '', contaminated: false, records: [], inbox: { 'next-turn': [], 'next-step': [] } };
}
export function contentFingerprint(message) { return hash(JSON.stringify(message?.content ?? [])); }
function isWechatMessage(message) { return typeof message?.id === 'string' && MESSAGE_PATTERN.test(message.id); }
function isForeignMessage(message) {
  return !isWechatMessage(message) && message?.source?.kind !== 'runtime-context';
}
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
        if (!isWechatMessage(message)) continue;
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
      return { ...previous, turn: event.data.turn, active: [], candidate: '' };
    case 'user/message': {
      // Compaction replacements are not new user submissions.
      if (event.surfaceOp && event.surfaceOp !== 'append') return previous;
      const message = event.data;
      if (!isWechatMessage(message)) {
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
      if (event.data.turn !== previous.turn || previous.active.length === 0) return previous;
      return { ...previous, candidate: finalText(event.data.message, event.data.interrupted) };
    case 'turn/end': {
      if (event.data.turn !== previous.turn || previous.active.length === 0) return previous;
      const reason = previous.contaminated ? 'contaminated' : (event.data.reason?.kind ?? 'error');
      const successful = reason === 'completed' && Boolean(previous.candidate);
      const records = previous.records.map(record => previous.active.includes(record.id)
        ? { ...record, state: successful ? 'completed' : 'failed', text: successful ? previous.candidate : '', reason }
        : record);
      return { ...previous, records, active: [], candidate: '' };
    }
    default:
      return previous;
  }
}

export function completionOf(state, id) {
  if (state.contaminated) return { state: 'failed', text: '', reason: 'contaminated' };
  return state.records.find(record => record.id === id);
}
