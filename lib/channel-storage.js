import { z } from 'zod';
import { BridgeError } from './state.js';
import { emptyChannelState } from './channel-bridge.js';

const identifier = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const generation = z.uuid();
const messageSchema = z.object({
  id: identifier, senderId: identifier, chatId: identifier, threadId: identifier.optional(), replyTo: identifier.optional(),
  text: z.string().max(12000), route: z.json().optional(),
  attachments: z.array(z.never()).max(0), content: z.array(z.json()).max(24).optional(),
}).strict();
const mailboxSchema = z.object({
  generation, seen: z.array(digest).max(1000), uncertainReplies: z.number().int().nonnegative(),
  lastMessageAt: z.number().int().nonnegative().nullable(),
  queue: z.array(z.object({
    key: digest, phase: z.enum(['queued', 'ready', 'sending']), message: messageSchema,
    reply: z.string().max(7000).optional(), retryAt: z.number().int().nonnegative().optional(),
  }).strict()).max(12),
}).strict();

export const channelDomainSpec = {
  name: 'dshchannelbridge', version: 1, tables: {},
  global: {
    schema: z.object({ version: z.literal(1), channels: z.record(z.string().regex(/^[a-z_]{1,32}$/), mailboxSchema) }).strict(),
    initial: emptyChannelState(),
  },
};

const recordSchema = z.object({
  generation, enabled: z.boolean(), config: z.record(z.string(), z.json()),
  allowedSenders: z.array(identifier).max(100), authState: z.string().max(2 * 1024 * 1024).optional(),
}).strict();

export function channelAccounts(credentials) {
  const key = id => `dsh-channel-bridge/${id}`;
  function decode(record) {
    if (!record) return null;
    const result = record.kind === 'grant' && recordSchema.safeParse(record.payload);
    if (!result?.success) throw new BridgeError('STORAGE_ERROR', 'DSH 渠道凭据格式异常。', 500);
    return result.data;
  }
  return {
    async get(id) { return decode(await credentials.readRecord(key(id))); },
    async set(id, value) {
      const payload = recordSchema.parse(value);
      await credentials.modifyRecord(key(id), async () => ({ kind: 'grant', payload }));
    },
    async delete(id) { await credentials.deleteRecord(key(id)); },
  };
}
