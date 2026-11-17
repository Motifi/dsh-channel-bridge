import z from '@deepseek-ai/schemastery';
import QRCode from 'qrcode';
import { resolveWorkspaceDir } from './lib/workspace.js';
import { WeixinBridge } from './lib/bridge.js';
import { AgentBackend } from './lib/agent-backend.js';
import { domainSpec, accountSchema, projectionSchema } from './lib/schemas.js';
import { initialProjection, applyProjection } from './lib/projection.js';
import { createApiHandler } from './lib/http.js';
import { BridgeError, SESSION_PATTERN, accountKey } from './lib/state.js';
import { validateBaseUrl } from './lib/ilink.js';
import { CHAT_ONLY_REASON } from './session-policy.js';

export const name = 'weixin-bridge';
export const inject = ['agents', 'agentPresets', 'agentDefaultModel', 'sessionPersistence',
  'sessionProjections', 'credentials', 'storageDomain', 'tools', 'webServer', 'connection', 'workingDirectory'];

export const Config = z.object({
  workspaceDir: z.string().description('Optional existing absolute directory. Omit to create weixin-workspace inside the DSH default directory.'),
  pollTimeoutMs: z.number().step(1).min(5000).max(60000).default(35000),
  contextBudget: z.number().step(1).min(1).max(8).default(8),
  responseTimeoutMs: z.number().step(1).min(30000).max(300000).default(180000),
});

const CREDENTIAL_KEY = 'weixin-bridge/account';
function checkedAccount(value) {
  const parsed = accountSchema.safeParse(value);
  if (!parsed.success) throw new BridgeError('STORAGE_ERROR', '微信凭据记录格式不正确，请断开后重新扫码。', 500);
  const account = parsed.data;
  try { account.baseUrl = validateBaseUrl(account.baseUrl); }
  catch { throw new BridgeError('STORAGE_ERROR', '保存的微信服务地址无效，请重新扫码。', 500); }
  if (account.id !== accountKey(account)) throw new BridgeError('STORAGE_ERROR', '微信账号记录不匹配，请重新扫码。', 500);
  return account;
}
function accountStore(credentials) {
  const decode = record => {
    if (!record) return null;
    if (record.kind !== 'grant') throw new BridgeError('STORAGE_ERROR', '微信凭据记录类型不正确。', 500);
    return checkedAccount(record.payload);
  };
  return {
    async get() { return decode(await credentials.readRecord(CREDENTIAL_KEY)); },
    async set(account) {
      const payload = checkedAccount(account);
      await credentials.modifyRecord(CREDENTIAL_KEY, async () => ({ kind: 'grant', payload }));
    },
    async update(change) {
      const record = await credentials.modifyRecord(CREDENTIAL_KEY, async current => {
        const account = decode(current);
        if (!account) return undefined;
        return { kind: 'grant', payload: checkedAccount(change(account)) };
      });
      return decode(record);
    },
    async delete() { await credentials.deleteRecord(CREDENTIAL_KEY); },
  };
}
function toolSnapshot(snapshot) {
  // QR content establishes authority and is deliberately user-only, even as an image.
  return { ...snapshot, login: snapshot.login ? {
    status: snapshot.login.status, expiresAt: snapshot.login.expiresAt,
    verificationFailed: snapshot.login.verificationFailed,
  } : null };
}

export async function apply(ctx, config) {
  const workspaceDir = await resolveWorkspaceDir(config.workspaceDir, ctx.workingDirectory.defaultDirectory);
  const domain = await ctx.storageDomain.open(domainSpec);
  let projection, backend, bridge;
  ctx.effect(() => async () => {
    const failures = [];
    for (const dispose of [() => bridge?.close(), () => backend?.close(), () => projection?.dispose(), () => domain.close()]) {
      try { await dispose(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'WeChat bridge cleanup did not fully settle.');
  });
  projection = await ctx.sessionProjections.register({
    key: 'weixin-bridge-turns', stateVersion: 2, stateSchema: projectionSchema,
    init: header => initialProjection(header), apply: applyProjection,
  });
  backend = new AgentBackend(ctx, { projection, workspaceDir, timeoutMs: config.responseTimeoutMs });
  bridge = new WeixinBridge({
    store: { read: () => domain.global.get(), write: state => domain.global.set(state) },
    accounts: accountStore(ctx.credentials), backend, workspaceDir,
    contextBudget: config.contextBudget, pollTimeoutMs: config.pollTimeoutMs,
    qrCode: async content => {
      if (typeof content !== 'string' || !content || content.length > 8192) {
        throw new BridgeError('AUTH_REQUIRED', '微信返回的二维码无效，请重试。', 502);
      }
      return QRCode.toDataURL(content, { type: 'image/png', errorCorrectionLevel: 'M', margin: 3, scale: 6 });
    },
  });
  // This guard also covers an already-live bridge session even if another UI changes its preset.
  ctx.effect(() => ctx.tools.guard(execution => SESSION_PATTERN.test(execution.agent?.id || '')
    ? { reason: CHAT_ONLY_REASON, info: { name: 'WeixinChatOnlyError', code: 'WEIXIN_CHAT_ONLY' } }
    : undefined));
  ctx.provide('weixinBridge', bridge);
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/plugins/weixin-bridge/api',
    handler: createApiHandler({ connection: ctx.connection, bridge }) }));
  ctx.effect(() => ctx.tools.register({
    name: 'weixin_bridge',
    description: 'Inspect the WeChat bridge, pause it, or disconnect it. QR login, resuming access, and user approvals are user-only in Settings → WeChat connection; this tool cannot grant access or return login QR codes.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'pause', 'disconnect'], description: 'Read status, pause polling and work, or forget the connection and approvals while retaining DSH chat history.' },
    }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args) {
      const action = { status: 'status', pause: 'connection.pause', disconnect: 'connection.disconnect' }[args?.action];
      if (!action) throw new BridgeError('INVALID_REQUEST', '不支持的微信管理操作。');
      return toolSnapshot(await bridge.action(action));
    },
    isConcurrencySafe: args => args?.action === 'status',
  }));
  await bridge.initialize();
}
