import { z } from 'zod';
import { MAX_OUTBOUND_MEDIA_BASE64, MAX_OUTBOUND_MEDIA_FILES } from './ilink.js';
import { initialState, MAX_REPLY_CHARS } from './state.js';

const time = z.number().int().nonnegative();
const text = z.string().max(1024);
const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const session = z.string().regex(/^wxbridge-[a-f0-9]{32}$/);
const input = z.string().regex(/^wxbridge-in-[a-f0-9]{48}$/);
const projectionInput = z.string().regex(/^(?:wxbridge|dshbridge)-in-[a-f0-9]{48}$/);
const outboundFile = z.object({
  name: z.string().min(1).max(255), mime: text.optional(),
  data: z.string().min(1).max(MAX_OUTBOUND_MEDIA_BASE64),
}).strict();
const maxReplyParts = 4 + MAX_OUTBOUND_MEDIA_FILES;

export const accountSchema = z.object({
  id: hash, token: z.string().min(1).max(8192), baseUrl: z.string().url().max(512),
  botId: z.string().max(256), userId: z.string().max(256),
  contexts: z.array(z.object({
    userId: id, token: z.string().min(1).max(16384), updatedAt: time,
    version: z.number().int().nonnegative(), count: z.number().int().min(0).max(100),
  }).strict()).max(24),
}).strict();

export const stateSchema = z.object({
  version: z.literal(1), enabled: z.boolean(), accountKey: z.union([hash, z.literal('')]), cursor: z.string().max(65536),
  seen: z.array(hash).max(1000),
  recoveryReceipts: z.array(hash).max(1000).optional(),
  users: z.array(z.object({
    userId: id, status: z.enum(['pending', 'approved', 'revoked']), firstSeenAt: time, lastSeenAt: time,
    sessionId: z.union([session, z.literal('')]), pairingHash: z.union([hash, z.literal('')]),
    pairingExpiresAt: time, pairingAttempts: z.number().int().min(0).max(5),
    pairingStatus: z.enum(['sent', 'failed', 'expired']), lastError: text,
  }).strict()).max(24),
  inbox: z.array(z.object({
    id: hash, messageId: input, userId: id, sessionId: session, accountKey: hash,
    text: z.string().max(24000), content: z.array(z.json()).max(24).optional(),
    streamedPrefix: z.string().max(4800).optional(),
    streamedParts: z.number().int().min(1).max(2).optional(),
    approvalNoticeAttempted: z.literal(true).optional(),
    approvalNoticeReserved: z.literal(true).optional(),
    failureStatus: z.enum(['task-failed', 'interrupted', 'model-required', 'legacy-preset']).optional(),
    createdAt: time, state: z.enum(['queued', 'submitted', 'completed', 'failed']), lastError: text,
  }).strict()).max(100),
  outbox: z.array(z.object({
    id: id, userId: id, accountKey: hash, sessionId: z.union([session, z.literal('')]),
    messageId: z.union([input, z.literal('')]),
    parts: z.array(z.union([z.string().min(1).max(3600), outboundFile])).min(1).max(maxReplyParts),
    nextPart: z.number().int().min(0).max(maxReplyParts),
    state: z.enum(['pending', 'blocked', 'sending', 'sent', 'failed', 'uncertain']),
    contextVersion: z.number().int().nonnegative(), createdAt: time, lastError: text,
  }).strict()).max(65),
}).strict();

export const domainSpec = {
  name: 'weixinbridge', version: 1, tables: {},
  global: { schema: stateSchema, initial: initialState() },
};

const record = z.object({ id: projectionInput, fingerprint: hash, state: z.enum(['queued', 'running', 'completed', 'failed']),
  turn: time, text: z.string().max(MAX_REPLY_CHARS + 200), reason: z.string().max(100) }).strict();
export const projectionSchema = z.object({
  eligible: z.boolean(), channel: z.literal(true).optional(), turn: time,
  active: z.array(projectionInput), candidate: z.string().max(MAX_REPLY_CHARS + 200),
  scheduleActive: z.array(z.uuidv4()).optional(),
  scheduleResult: z.object({ messageId: z.uuidv4(), seq: time, time, text: z.string().max(MAX_REPLY_CHARS + 200) }).strict().optional(),
  contaminated: z.boolean(), records: z.array(record).max(500),
  inbox: z.object({ 'next-turn': z.array(z.string()), 'next-step': z.array(z.string()) }).strict(),
}).strict();
