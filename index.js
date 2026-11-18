import z from '@deepseek-ai/schemastery';
import { randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { readChannelFile, resolveWeixinWorkspace, resolveWorkspaceDir } from './lib/workspace.js';
import { WeixinBridge } from './lib/bridge.js';
import { AgentBackend, commandDomainSpec, createCommandReceipts } from './lib/agent-backend.js';
import { domainSpec, accountSchema, projectionSchema } from './lib/schemas.js';
import { ChannelBridge, channelButtons } from './lib/channel-bridge.js';
import { channelAccounts, channelDomainSpec, channelPreferences } from './lib/channel-storage.js';
import { ChannelTurns } from './lib/channel-tools.js';
import { createNanobotTransport } from './lib/nanobot-transport.js';
import { telegram } from './lib/channels/telegram.js';
import { websocket } from './lib/channels/websocket.js';
import catalog from './transport/channels.json' with { type: 'json' };
import { initialProjection, applyProjection } from './lib/projection.js';
import { createApiHandler, validateChannelRequest } from './lib/http.js';
import { BridgeError, CHANNEL_SESSION_PATTERN, LEGACY_CHANNEL_PRESET_ID, SESSION_PATTERN, accountKey } from './lib/state.js';
import { validateBaseUrl } from './lib/ilink.js';

export const name = 'weixin-bridge';
export const inject = ['agents', 'agentPresets', 'agentDefaultModel', 'sessionPersistence',
  'sessionProjections', 'credentials', 'storageDomain', 'tools', 'webServer', 'connection', 'workingDirectory', 'attachments'];

export const Config = z.object({
  workspaceDir: z.string().description('Optional existing absolute directory. Omit to reuse the approved WeChat session directory or create weixin-workspace inside the DSH default directory.'),
  pollTimeoutMs: z.number().step(1).min(5000).max(60000).default(35000),
  contextBudget: z.number().step(1).min(1).max(8).default(8),
  responseTimeoutMs: z.number().step(1).min(30000).max(300000).default(180000),
  nanobotPython: z.string().default('python3').description('Python executable for the pinned nanobot transports. Use the absolute path of a dedicated virtual environment.'),
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

async function admitAttachments(attachments, inputs) {
  const content = [];
  for (const { name, data, mediaType } of inputs) {
    const label = JSON.stringify(name);
    if (!data) {
      content.push({ type: 'text', text: `[Attachment ${label}: unavailable or above size limit]` });
      continue;
    }
    try {
      if (attachments.imageLimits.mediaTypes.includes(mediaType)) {
        content.push(...await attachments.admitPromptContent([{ type: 'image', name, data, mediaType }]));
      } else {
        const attachment = await attachments.admitEncodedFile({ data, name });
        content.push({ type: 'file', attachment });
        if (/^text\//.test(mediaType) || ['application/json', 'application/xml'].includes(mediaType)) {
          const bytes = Buffer.from(data, 'base64').subarray(0, 4000);
          const text = new TextDecoder().decode(bytes).replaceAll('\0', '');
          content.push({ type: 'text', text: `Text excerpt from attachment ${label}:\n${text}` });
        }
      }
    } catch {
      content.push({ type: 'text', text: `[Attachment ${label}: rejected by DSH attachment storage]` });
    }
  }
  return content;
}

function channelCatalog() {
  const streaming = new Set(['discord', 'feishu', 'matrix', 'mattermost', 'telegram', 'websocket', 'weixin']);
  const reasoning = new Set(['linear', 'websocket']);
  return catalog.channels.map(({ id, label, login, fields, officialUrl }) => ({
    id, name: label, officialUrl,
    fields: fields.filter(({ field }) => !['allowFrom', 'enabled'].includes(field)),
    interactiveLogin: login && ['whatsapp', 'linear'].includes(id),
    replyOptions: [...(streaming.has(id) ? ['streaming'] : []),
      ...(id === 'email' ? [] : ['sendProgress', 'sendToolHints']), ...(reasoning.has(id) ? ['showReasoning'] : [])],
    replyDefaults: { streaming: streaming.has(id) && !['matrix', 'weixin'].includes(id) },
  }));
}

export async function apply(ctx, config) {
  const domain = await ctx.storageDomain.open(domainSpec);
  let projection, commandDomain, backend, bridge, channelDomain, channelBackend, channels;
  ctx.effect(() => async () => {
    const failures = [];
    for (const dispose of [() => channels?.close(), () => bridge?.close(), () => channelBackend?.close(),
      () => backend?.close(), () => projection?.dispose(), () => commandDomain?.close(), () => channelDomain?.close(), () => domain.close()]) {
      try { await dispose(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Message channel cleanup did not fully settle.');
  });
  const workspaceDir = await resolveWeixinWorkspace(config.workspaceDir, ctx.workingDirectory.defaultDirectory, {
    state: domain.global.get(), sessionPersistence: ctx.sessionPersistence,
  });
  projection = await ctx.sessionProjections.register({
    key: 'weixin-bridge-turns', stateVersion: 4, stateSchema: projectionSchema,
    init: header => initialProjection(header), apply: applyProjection,
  });
  const preferences = channelPreferences(ctx.credentials);
  commandDomain = await ctx.storageDomain.open(commandDomainSpec);
  const commandReceipts = createCommandReceipts(commandDomain.global);
  const replySettings = new Map();
  const items = channelCatalog();
  const replyOptionsOf = id => replySettings.get(id) ?? {};
  await Promise.allSettled(items.map(async ({ id }) => replySettings.set(id, await preferences.get(id))));
  const privateWorkspaces = await resolveWorkspaceDir(undefined, ctx.workingDirectory.defaultDirectory, 'channel-private-workspaces');
  const workspaceForSession = id => resolveWorkspaceDir(undefined, privateWorkspaces, id);
  const weixinWorkspaces = config.workspaceDir === undefined ? privateWorkspaces
    : await resolveWorkspaceDir(undefined, workspaceDir, 'channel-private-workspaces');
  const workspaceForWeixin = id => resolveWorkspaceDir(undefined, weixinWorkspaces, id);
  const toolWorkspace = turn => (turn.channelId === 'weixin' ? workspaceForWeixin : workspaceForSession)(turn.agent.id);
  const turns = new ChannelTurns({
    stateOf: session => projection.stateOf(session), findAgent: id => ctx.agents.get(id),
  });
  const forChannel = (native, channelIdOf) => ({
    isSafe: id => native.isSafe(id), model: () => native.model(), stopWork: () => native.stopWork(),
    isSafeForDelivery: id => ctx.agents.get(id) ? native.hasSession(id) : true,
    interrupt: id => native.interrupt?.(id),
    hasSession: id => native.hasSession(id),
    run(entry, signal, onUpdate) {
      const channelId = channelIdOf(entry);
      return native.run({ ...entry,
        bindTurn: agent => turns.bind(agent, { agent, messageId: entry.messageId, signal, channelId }),
      }, signal, onUpdate);
    },
  });
  backend = new AgentBackend(ctx, { projection, workspaceDir, workspaceForSession: workspaceForWeixin,
    commandReceipts, timeoutMs: config.responseTimeoutMs });
  bridge = new WeixinBridge({
    store: { read: () => domain.global.get(), write: state => domain.global.set(state) },
    accounts: accountStore(ctx.credentials), backend: forChannel(backend, () => 'weixin'), workspaceDir,
    contextBudget: config.contextBudget, pollTimeoutMs: config.pollTimeoutMs,
    admitAttachments: inputs => admitAttachments(ctx.attachments, inputs),
    deliveryOptions: () => {
      const options = replyOptionsOf('weixin');
      return { ...options, blockStreaming: options.streaming === true };
    },
    qrCode: async content => {
      if (typeof content !== 'string' || !content || content.length > 8192) {
        throw new BridgeError('AUTH_REQUIRED', '微信返回的二维码无效，请重试。', 502);
      }
      return QRCode.toDataURL(content, { type: 'image/png', errorCorrectionLevel: 'M', margin: 3, scale: 6 });
    },
  });
  const channelWorkspace = await resolveWorkspaceDir(undefined, ctx.workingDirectory.defaultDirectory, 'channel-workspace');
  channelDomain = await ctx.storageDomain.open(channelDomainSpec);
  channelBackend = new AgentBackend(ctx, {
    projection, workspaceDir: channelWorkspace, timeoutMs: config.responseTimeoutMs,
    legacyPresetId: LEGACY_CHANNEL_PRESET_ID, sessionPattern: CHANNEL_SESSION_PATTERN,
    workspaceForSession, commandReceipts,
  });
  channels = new ChannelBridge({
    catalog: items, accounts: channelAccounts(ctx.credentials), backend: forChannel(channelBackend, entry => entry.channelId),
    getPreferences: replyOptionsOf,
    store: { read: () => channelDomain.global.get(), write: state => channelDomain.global.set(state) },
    admitAttachments: inputs => admitAttachments(ctx.attachments, inputs),
    create(settings, callbacks, id) {
      if (id === 'websocket') return websocket.create(settings, {
        ...callbacks, registerUpgrade: spec => ctx.webServer.registerUpgrade(spec),
      });
      if (id === 'telegram' && settings.mode !== 'webhook' && !settings.proxyUrl && !settings.useProxy) {
        return telegram.create(settings, callbacks);
      }
      return createNanobotTransport(id, settings, callbacks, { python: config.nanobotPython });
    },
  });
  // DSH resolves step tools before appending the claimed inbox messages.
  ctx.effect(() => ctx.tools.register({
    name: 'channel_send',
    description: 'Send a message, reply options, or up to four small files to this Agent’s authorized chat. Paths stay inside its isolated workspace. With no arguments, return the workspace path.',
    parameters: { type: 'object', properties: {
      text: { type: 'string', maxLength: 6800 },
      files: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 1024 } },
      buttons: { type: 'array', maxItems: 4, items: { type: 'array', minItems: 1, maxItems: 4,
        items: { type: 'string', maxLength: 64 } } },
    }, additionalProperties: false },
    output: { schema: { type: 'object', properties: { queued: { type: 'boolean' }, workspace: { type: 'string' } }, additionalProperties: false },
      render: (_args, result) => [{ type: 'text', text: result.workspace ?? 'Message queued for this channel conversation.' }] },
    async execute({ text = '', files = [], buttons = [] }, execution) {
      const turn = turns.active(execution.agent, execution.signal);
      if (!turn) throw new BridgeError('FORBIDDEN', '当前会话没有渠道发送权限。', 403);
      const workspace = await toolWorkspace(turn);
      const choices = channelButtons(buttons);
      const message = text.trim();
      if (!message && !files.length) {
        if (choices.length) throw new BridgeError('INVALID_REQUEST', '请为按钮添加一条消息。');
        return { workspace };
      }
      const attachments = [];
      let remaining = 1024 * 1024;
      for (const path of files) {
        const file = await readChannelFile(workspace, path, remaining);
        remaining -= Buffer.from(file.data, 'base64').length;
        attachments.push(file);
      }
      if (turns.active(execution.agent, execution.signal) !== turn) {
        throw new BridgeError('FORBIDDEN', '当前会话的渠道发送权限已撤销。', 403);
      }
      const sender = turn.channelId === 'weixin' ? bridge : channels;
      const queued = await sender.sendToSession(turn.agent.id, {
        id: execution.callId || randomUUID(), attachments, buttons: choices,
        text: turn.channelId === 'weixin' && choices.length
          ? [message, ...choices.map(row => row.map(label => `［${label}］`).join(' '))].filter(Boolean).join('\n') : message,
      });
      if (!queued) throw new BridgeError('BUSY', '渠道当前无法接收该消息。', 409);
      return { queued };
    },
  }, { when: ({ agent, signal }) => Boolean(turns.bound(agent, signal)) }));
  ctx.provide('weixinBridge', bridge);
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/plugins/weixin-bridge/api',
    handler: createApiHandler({ connection: ctx.connection, bridge }) }));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/plugins/channel-bridge/api',
    handler: createApiHandler({
      connection: ctx.connection, bridge: { async action(action, args) {
        if (action === 'preferences.update') {
          const item = items.find(item => item.id === args.id);
          if (!item || (args.preferences && Object.keys(args.preferences)
            .some(key => !item.replyOptions.includes(key)))) {
            throw new BridgeError('INVALID_REQUEST', '渠道不支持此选项。');
          }
          replySettings.set(args.id, await preferences.update(args.id, args.preferences));
        }
        const snapshot = await channels.action(action === 'preferences.update' ? 'status' : action, args);
        const weixin = toolSnapshot(bridge.snapshot());
        const channel = snapshot.channels.find(item => item.id === 'weixin');
        Object.assign(channel, {
          status: weixin.connectionStatus, enabled: weixin.enabled, configured: Boolean(weixin.account),
          lastMessageAt: weixin.lastPollAt, pendingMessages: weixin.pendingReplies,
          allowedSenders: weixin.users.filter(user => user.status === 'approved').map(user => user.userId),
        });
        return { ...snapshot, channels: snapshot.channels.map(item => ({ ...item, preferences: replyOptionsOf(item.id) })),
          upstreamCommit: catalog.upstreamCommit };
      } },
      header: 'x-dsh-channel-bridge', maxBytes: 32 * 1024, validate: validateChannelRequest,
    }) }));
  ctx.effect(() => ctx.tools.register({
    name: 'weixin_bridge',
    description: 'Inspect the WeChat bridge, pause it, or disconnect it. QR login, resuming access, and user approvals are user-only on the Message Channels page; this tool cannot grant access or return login QR codes.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['status', 'pause', 'disconnect'], description: 'Read status, pause polling and work, or forget the connection and approvals while retaining DSH chat history.' },
    }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, execution) {
      if (!turns.canManageBridge(execution.agent)) {
        throw new BridgeError('FORBIDDEN', '请在 DSH 中管理微信连接。', 403);
      }
      const action = { status: 'status', pause: 'connection.pause', disconnect: 'connection.disconnect' }[args?.action];
      if (!action) throw new BridgeError('INVALID_REQUEST', '不支持的微信管理操作。');
      return toolSnapshot(await bridge.action(action));
    },
    isConcurrencySafe: args => args?.action === 'status',
  }, { when: ({ agent }) => turns.canManageBridge(agent) }));
  await bridge.initialize();
  await channels.initialize();
  const weixinSessions = () => bridge.snapshot().users.filter(user => user.status === 'approved' && user.sessionId).map(user => user.sessionId);
  const channelSessions = () => channels.boundSessions();
  const scheduleRelay = commandDomain.table('schedule_relay');
  backend.startScheduleRelay({
    state: scheduleRelay,
    listSessions: weixinSessions,
    send: ({ sessionId, messageId, text }) => bridge.sendToSession(sessionId, { id: messageId, text }),
  });
  channelBackend.startScheduleRelay({
    state: scheduleRelay,
    listSessions: channelSessions,
    send: ({ sessionId, messageId, text }) => channels.sendToSession(sessionId, { id: messageId, text }),
  });
  ctx.effect(() => ctx.on('schedule/resolve-agent', async (sessionId, next) => {
    const isWeixin = SESSION_PATTERN.test(sessionId);
    if (!isWeixin && !CHANNEL_SESSION_PATTERN.test(sessionId)) return next();
    const target = isWeixin ? backend : channelBackend;
    if (!(isWeixin ? weixinSessions() : channelSessions()).includes(sessionId) || !await target.hasSession(sessionId)) {
      throw new BridgeError('FORBIDDEN', '此渠道会话已解除关联。', 403);
    }
    return target.ensureAgent({ sessionId });
  }, { prepend: true }));
}
