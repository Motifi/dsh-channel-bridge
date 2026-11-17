import { z } from 'zod';
import { initialState, MAX_REPLY_CHARS } from './state.js';

const time = z.number().int().nonnegative();
const text = z.string().max(1024);
const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const session = z.string().regex(/^wxbridge-[a-f0-9]{32}$/);
const input = z.string().regex(/^wxbridge-in-[a-f0-9]{48}$/);

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
  users: z.array(z.object({
    userId: id, status: z.enum(['pending', 'approved', 'revoked']), firstSeenAt: time, lastSeenAt: time,
    sessionId: z.union([session, z.literal('')]), pairingHash: z.union([hash, z.literal('')]),
    pairingExpiresAt: time, pairingAttempts: z.number().int().min(0).max(5),
    pairingStatus: z.enum(['sent', 'failed', 'expired']), lastError: text,
  }).strict()).max(24),
  inbox: z.array(z.object({
    id: hash, messageId: input, userId: id, sessionId: session, accountKey: hash,
    text: z.string().max(24000), createdAt: time, state: z.enum(['queued', 'submitted', 'completed', 'failed']), lastError: text,
  }).strict()).max(100),
  outbox: z.array(z.object({
    id: id, userId: id, accountKey: hash, sessionId: z.union([session, z.literal('')]),
    messageId: z.union([input, z.literal('')]),
    parts: z.array(z.string().min(1).max(3600)).min(1).max(4), nextPart: z.number().int().min(0).max(4),
    state: z.enum(['pending', 'blocked', 'sending', 'sent', 'failed', 'uncertain']),
    contextVersion: z.number().int().nonnegative(), createdAt: time, lastError: text,
  }).strict()).max(65),
}).strict();

export const domainSpec = {
  name: 'weixinbridge', version: 1, tables: {},
  global: { schema: stateSchema, initial: initialState() },
};

const record = z.object({ id: input, fingerprint: hash, state: z.enum(['queued', 'running', 'completed', 'failed']),
  turn: time, text: z.string().max(MAX_REPLY_CHARS + 200), reason: z.string().max(100) }).strict();
export const projectionSchema = z.object({
  eligible: z.boolean(), turn: time, active: z.array(input), candidate: z.string().max(MAX_REPLY_CHARS + 200),
  contaminated: z.boolean(), records: z.array(record).max(500),
  inbox: z.object({ 'next-turn': z.array(z.string()), 'next-step': z.array(z.string()) }).strict(),
}).strict();
