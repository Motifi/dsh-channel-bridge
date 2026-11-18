import { z } from 'zod';
import { BridgeError } from './state.js';
import { emptyChannelState } from './channel-bridge.js';

const identifier = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const generation = z.uuid();
const messageSchema = z.object({
  id: identifier, senderId: identifier, chatId: identifier, threadId: identifier.optional(), replyTo: identifier.optional(),
  instanceId: identifier.optional(), requireExistingSession: z.literal(true).optional(),
  text: z.string().max(12000), route: z.json().optional(),
  attachments: z.array(z.never()).max(0), content: z.array(z.json()).max(24).optional(),
}).strict();
const mailboxSchema = z.object({
  generation, seen: z.array(digest).max(1000), uncertainReplies: z.number().int().nonnegative(),
  lastMessageAt: z.number().int().nonnegative().nullable(),
  queue: z.array(z.object({
    key: digest, phase: z.enum(['queued', 'ready', 'sending']), message: messageSchema,
    reply: z.string().max(7000).optional(), retryAt: z.number().int().nonnegative().optional(), proactive: z.literal(true).optional(),
    destinationSessionId: z.string().regex(/^dshbridge-[a-f0-9]{32}$/).optional(),
    files: z.array(z.object({ name: z.string().max(160), mime: z.string().max(200), data: z.string().max(1398104) }).strict()).max(4).optional(),
    buttons: z.array(z.array(z.string().min(1).max(64)).min(1).max(4)).max(4).optional(),
  }).strict()).max(12),
  routes: z.record(digest, z.object({
    sessionId: z.string().regex(/^dshbridge-[a-f0-9]{32}$/), epoch: digest.optional(), message: messageSchema,
    established: z.boolean().optional(), lastSeenAt: z.number().int().nonnegative().optional(),
  }).strict()).optional(),
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

// DSH requires exactly two lowercase, hyphenated credential key segments.
const channelCredentialKey = id => `dsh-channel-bridge/${id.replaceAll('_', '-')}`;

export function channelAccounts(credentials) {
  function decode(record) {
    if (!record) return null;
    const result = record.kind === 'grant' && recordSchema.safeParse(record.payload);
    if (!result?.success) throw new BridgeError('STORAGE_ERROR', 'DSH 渠道凭据格式异常。', 500);
    return result.data;
  }
  return {
    async get(id) { return decode(await credentials.readRecord(channelCredentialKey(id))); },
    async set(id, value) {
      const payload = recordSchema.parse(value);
      await credentials.modifyRecord(channelCredentialKey(id), async () => ({ kind: 'grant', payload }));
    },
    async delete(id) { await credentials.deleteRecord(channelCredentialKey(id)); },
  };
}

const replyOptions = z.object({
  streaming: z.boolean(),
  sendProgress: z.boolean(),
  sendToolHints: z.boolean(),
  showReasoning: z.boolean(),
}).partial();
const replyUpdate = replyOptions.strict();

export function channelPreferences(credentials) {
  const key = id => channelCredentialKey(`preferences-${id}`);
  function read(record) {
    if (!record) return {};
    // Saved records can contain settings from older plugin versions.
    const result = record.kind === 'grant' && replyOptions.safeParse(record.payload);
    if (!result?.success) throw new BridgeError('STORAGE_ERROR', 'DSH 渠道回复设置格式异常。', 500);
    return result.data;
  }
  return {
    async get(id) { return read(await credentials.readRecord(key(id))); },
    async update(id, change) {
      const parsed = replyUpdate.safeParse(change);
      if (!parsed.success) throw new BridgeError('INVALID_REQUEST', '存在无效的渠道回复设置。');
      const record = await credentials.modifyRecord(key(id), async current => ({
        kind: 'grant', payload: { ...read(current), ...parsed.data },
      }));
      return read(record);
    },
  };
}
