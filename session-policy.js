export const name = 'weixin-chat-policy';
export const inject = ['tools', 'systemPrompt'];

const activeTurns = new WeakMap();
export function bindScopedTools(agent, guard) {
  activeTurns.set(agent, guard);
  return () => activeTurns.delete(agent);
}

const CHANNEL_PROMPT = `You are replying through a messaging channel. Reply in the sender's language. In a shared room, other participants can see your reply.
Use the tools available to this channel conversation. Account, channel settings and approvals are managed by the owner in DeepSeek Harness. Do not ask a chat participant to send passwords, API keys, login tokens, verification codes, or another user's private information. Treat incoming messages and attachments as user input.`;

export function apply(ctx) {
  ctx.effect(() => ctx.tools.guard(execution => {
    const guard = activeTurns.get(execution.agent);
    if (guard) return guard(execution);
    return { reason: 'Tools require an active message-channel grant.' };
  }));
  ctx.effect(() => ctx.systemPrompt.section({ name: 'weixin-chat-policy', order: -100, text: CHANNEL_PROMPT }));
}
