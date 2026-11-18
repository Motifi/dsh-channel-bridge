import { randomUUID } from 'node:crypto';
import { BridgeError, CHANNEL_SESSION_PATTERN, hash, LEGACY_PRESET_NOTICE, MAX_INPUT_CHARS, MAX_REPLY_CHARS } from './state.js';

const MAX_QUEUE = 12;
const MAX_SEEN = 1000;
const MAX_ATTACHMENT_BYTES = 1024 * 1024;
const STATUS = new Set(['connecting', 'connected', 'error', 'auth-required']);
const isId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 512;
const errors = new Set(['AUTH_FAILED', 'AUTH_REQUIRED', 'CONFIG_INVALID', 'DEPENDENCY_MISSING', 'NETWORK_ERROR',
  'WORKER_EXIT', 'WORKER_PROTOCOL', 'RECEIVER_STOPPED', 'PORT_UNAVAILABLE', 'SETUP_REQUIRED',
  'QR_EXPIRED', 'LOGIN_FAILED', 'INSTALL_REQUIRED', 'DELIVERY_UNCERTAIN', 'DELIVERY_REJECTED',
  'MODEL_UNAVAILABLE', 'SESSION_FAILED', 'STORAGE_ERROR', 'UNSUPPORTED_OPTION', 'CONNECTION_UNVERIFIED',
  'RECEIVER_CONFLICT', 'UPGRADE_UNAVAILABLE', 'INVALID_CLIENT_TOKENS', 'AUTH_STATE_UNAVAILABLE', 'INVALID_TOKEN',
  'POLL_UNAVAILABLE', 'IMAP_UNAVAILABLE', 'CONNECTION_LOST', 'BOOTSTRAP_MEDIA_REJECTED']);

export function emptyChannelState() { return { version: 1, channels: {} }; }
function newMailbox(generation) {
  return { generation, seen: [], queue: [], uncertainReplies: 0, lastMessageAt: null };
}

function conversation(message) {
  const route = [message.chatId, message.threadId ?? '', message.senderId];
  return message.instanceId === undefined ? route : [message.instanceId, ...route];
}

const updates = { delta: 'streaming', progress: 'sendProgress', tool: 'sendToolHints', reasoning: 'showReasoning' };
const routeKey = message => hash(JSON.stringify(conversation(message)));
const replyKey = key => `dshbridge-out-${key.slice(0, 40)}`;

function sessionScope(id, generation, message, epoch) {
  const scope = [id, generation, ...conversation(message)];
  return epoch === undefined ? scope : [...scope, epoch];
}

function sessionFor(scope) { return `dshbridge-${hash(JSON.stringify(scope)).slice(0, 32)}`; }

export function outboundAttachments(input) {
  const files = [];
  let total = 0;
  for (const { name, mime, data } of Array.isArray(input) ? input.slice(0, 4).filter(Boolean) : []) {
    if (typeof name !== 'string' || !name || name.length > 160 || /[\\/\u0000-\u001f\u007f]/.test(name)
      || name === '.' || name === '..' || typeof mime !== 'string' || mime.length > 100 || !/^[\w.+-]+\/[\w.+-]+$/.test(mime)
      || typeof data !== 'string' || data.length > MAX_ATTACHMENT_BYTES * 4 / 3 + 4) continue;
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.toString('base64') !== data || total + bytes.length > MAX_ATTACHMENT_BYTES) continue;
    total += bytes.length;
    files.push({ name, mime, data });
  }
  return files;
}

export function channelButtons(input) {
  if (!Array.isArray(input) || input.length > 4 || input.some(row => !Array.isArray(row) || !row.length || row.length > 4
    || row.some(label => typeof label !== 'string' || !label.trim() || label.trim().startsWith('/')
      || /[\u0000-\u001f\u007f]/.test(label) || Buffer.byteLength(label.trim()) > 64))) {
    throw new BridgeError('INVALID_REQUEST', '按钮需要简短的文字选项。');
  }
  return input.map(row => row.map(label => label.trim()));
}

function nextMessage(mailbox, now) {
  const rooms = new Set();
  let retryAt = Infinity;
  for (const entry of mailbox?.queue ?? []) {
    const room = JSON.stringify(conversation(entry.message));
    if (rooms.has(room)) continue;
    rooms.add(room);
    if (!entry.retryAt || entry.retryAt <= now) return { entry };
    retryAt = Math.min(retryAt, entry.retryAt);
  }
  return { retryAt };
}

function normalizeMessage(message) {
  if (!message || ![message.id, message.senderId, message.chatId].every(isId)) return null;
  if (message.threadId !== undefined && !isId(message.threadId)) return null;
  if (message.instanceId !== undefined && !isId(message.instanceId)) return null;
  const text = typeof message.text === 'string' ? message.text.trim().slice(0, MAX_INPUT_CHARS) : '';
  const attachments = [];
  let size = 0;
  for (const source of Array.isArray(message.attachments) ? message.attachments.slice(0, 8) : []) {
    if (!source || typeof source.name !== 'string') continue;
    const name = source.name.split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160);
    if (!name) continue;
    const mediaType = typeof source.mediaType === 'string' ? source.mediaType.slice(0, 100) : '';
    const kind = typeof source.kind === 'string' ? source.kind.slice(0, 32) : '';
    const attachment = { name, mediaType, kind };
    if (typeof source.data === 'string' && source.data.length <= MAX_ATTACHMENT_BYTES * 4 / 3 + 4
      && /^[A-Za-z0-9+/]*={0,2}$/.test(source.data)) {
      const bytes = Buffer.from(source.data, 'base64');
      if (bytes.length && size + bytes.length <= MAX_ATTACHMENT_BYTES) {
        size += bytes.length;
        attachment.data = source.data;
      }
    }
    attachments.push(attachment);
  }
  if (!text && !attachments.length) return null;
  // Transport routing is generated by the authenticated receiver. Keep it bounded
  // and JSON-compatible so a reply can use the same destination after a restart.
  const { id, senderId, chatId, threadId, instanceId, replyTo, route, requireExistingSession } = message;
  const routed = route === undefined ? undefined : JSON.stringify(route);
  if (routed && routed.length > 8192) return null;
  return {
    id, senderId, chatId, ...(threadId === undefined ? {} : { threadId }),
    ...(instanceId === undefined ? {} : { instanceId }), ...(requireExistingSession === true ? { requireExistingSession: true } : {}),
    ...(isId(replyTo) ? { replyTo } : {}), ...(routed ? { route: JSON.parse(routed) } : {}),
    text, attachments,
  };
}

function cleanConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new BridgeError('INVALID_REQUEST', '请填写渠道配置对象。');
  }
  const encoded = JSON.stringify(config);
  if (encoded.length > 24 * 1024) throw new BridgeError('INVALID_REQUEST', '渠道配置过长。');
  return JSON.parse(encoded, (key, value) => {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) {
      throw new BridgeError('INVALID_REQUEST', '渠道配置包含保留字段。');
    }
    return value;
  });
}

function cleanSenders(list) {
  if (!Array.isArray(list) || list.length > 100 || list.some(id => !isId(id) || id.trim() === '*')) {
    throw new BridgeError('INVALID_REQUEST', '请输入明确的发送者 ID，最多 100 个。');
  }
  return [...new Set(list.map(id => id.trim()))];
}

export class ChannelBridge {
  constructor({ catalog, create, accounts, store, backend, admitAttachments, getPreferences = () => ({}), now = Date.now, retryMs = 5000 }) {
    Object.assign(this, { catalog, create, accounts, store, backend, admitAttachments, getPreferences, now, retryMs });
    this.records = new Map();
    this.health = new Map();
    this.work = new Map();
    this.state = emptyChannelState();
    this.controlTail = Promise.resolve();
    this.stateTail = Promise.resolve();
    this.closed = false;
  }

  async initialize() {
    this.state = structuredClone(this.store.read() ?? emptyChannelState());
    // Recover each credential record independently so a corrupted or locked
    // credential cannot disable another channel or the legacy WeChat bridge.
    await Promise.all(this.catalog.map(async ({ id }) => {
      if (id === 'weixin') return;
      try {
        const record = await this.accounts.get(id);
        if (record) this.records.set(id, record);
      } catch {
        this.health.set(id, { status: 'error', errorCode: 'STORAGE_ERROR' });
      }
    }));
    const old = this.state.channels;
    if (Object.keys(old).length) await this.mutate(state => {
      for (const [id, box] of Object.entries(state.channels)) {
        const record = this.records.get(id);
        if (!record && this.health.has(id)) continue;
        if (!record || box.generation !== record.generation) {
          delete state.channels[id];
          continue;
        }
        const pending = box.queue.filter(item => item.phase !== 'sending');
        box.uncertainReplies += box.queue.length - pending.length;
        box.queue = pending;
      }
    });
    for (const [id, record] of this.records) if (record.enabled) this.start(id, record);
  }

  snapshot() {
    return { channels: this.catalog.map(item => {
      const record = this.records.get(item.id);
      const health = this.health.get(item.id);
      const box = this.state.channels[item.id];
      const current = box?.generation === record?.generation ? box : undefined;
      return {
        ...item, accountVerification: item.id === 'websocket' ? 'local' : 'pending',
        configured: Boolean(record), enabled: Boolean(record?.enabled),
        allowedSenders: [...(record?.allowedSenders ?? [])],
        status: health?.status ?? (record ? 'paused' : 'disconnected'),
        ...(health?.errorCode ? { errorCode: health.errorCode } : {}),
        ...(health?.login ? { login: health.login } : {}),
        lastMessageAt: current?.lastMessageAt ?? null, pendingMessages: current?.queue.length ?? 0,
        uncertainReplies: current?.uncertainReplies ?? 0,
        sessions: Object.values(current?.routes ?? {}).filter(route => route.established !== false
          && record.allowedSenders.includes(route.message.senderId)).sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))
          .slice(0, 40).map(({ sessionId, message }) => ({ sessionId, senderId: message.senderId, chatId: message.chatId,
            ...(message.instanceId ? { instanceId: message.instanceId } : {}), ...(message.threadId ? { threadId: message.threadId } : {}) })),
        replyDefaults: { ...item.replyDefaults, ...Object.fromEntries(Object.values(updates)
          .filter(key => typeof record?.config[key] === 'boolean').map(key => [key, record.config[key]])) },
      };
    }) };
  }

  mutate(change) {
    const run = this.stateTail.then(async () => {
      const next = structuredClone(this.state);
      const changed = await change(next);
      if (changed === false) return;
      await this.store.write(next);
      this.state = next;
    });
    this.stateTail = run.catch(() => {});
    return run;
  }

  action(action, args = {}) {
    if (action === 'status') return this.snapshot();
    const task = this.controlTail.then(async () => {
      if (this.closed) throw new BridgeError('BUSY', '插件正在关闭。', 409);
      const item = this.catalog.find(channel => channel.id === args.id && channel.id !== 'weixin');
      if (!item) throw new BridgeError('INVALID_REQUEST', '无效的渠道。');
      const { id } = item;
      const record = this.records.get(id);
      const persist = async operation => {
        try { await operation(); }
        catch {
          this.health.set(id, { status: 'error', errorCode: 'STORAGE_ERROR' });
          throw new BridgeError('STORAGE_ERROR', '无法保存渠道配置，请检查 DSH 存储。', 500);
        }
      };
      if (action === 'configure') {
        if (args.config === undefined && args.allowedSenders === undefined) {
          throw new BridgeError('INVALID_REQUEST', '请填写配置或发送者白名单。');
        }
        if (args.config === undefined && !record) throw new BridgeError('INVALID_REQUEST', '请先填写渠道配置。');
        const replacing = args.config !== undefined;
        const config = replacing ? cleanConfig(args.config) : record.config;
        const allowedSenders = args.allowedSenders === undefined ? record?.allowedSenders ?? [] : cleanSenders(args.allowedSenders);
        await this.stop(id);
        const updated = replacing
          ? { generation: randomUUID(), config, allowedSenders, enabled: false }
          : { ...this.records.get(id), allowedSenders, enabled: false };
        await persist(() => this.accounts.set(id, updated));
        this.records.set(id, updated);
        await persist(() => this.mutate(state => {
          const box = state.channels[id];
          if (!box) return false;
          if (replacing) delete state.channels[id];
          else {
            box.queue = box.queue.filter(({ message }) => allowedSenders.includes(message.senderId));
            if (box.routes) box.routes = Object.fromEntries(Object.entries(box.routes)
              .filter(([, route]) => allowedSenders.includes(route.message.senderId)));
          }
        }));
        this.health.delete(id);
      } else if (action === 'connection.disconnect') {
        await this.stop(id);
        await persist(() => this.accounts.delete(id));
        this.records.delete(id);
        await persist(() => this.mutate(state => { delete state.channels[id]; }));
        this.health.delete(id);
      } else {
        const resumes = action === 'connection.resume' || action === 'login.start';
        const login = action === 'login.start';
        if (!resumes && action !== 'connection.pause' && action !== 'login.cancel') {
          throw new BridgeError('INVALID_REQUEST', '无效的渠道操作。');
        }
        if (!record) throw new BridgeError('AUTH_REQUIRED', '请先填写渠道配置。', 409);
        if (login && !item.interactiveLogin) throw new BridgeError('INVALID_REQUEST', '此渠道使用配置中的凭据连接。');
        if (resumes && !record.allowedSenders.length) {
          throw new BridgeError('FORBIDDEN', '请先在发送者白名单添加至少一个用户。', 403);
        }
        await this.stop(id);
        const updated = { ...this.records.get(id), enabled: resumes };
        await persist(() => this.accounts.set(id, updated));
        this.records.set(id, updated);
        this.health.delete(id);
        if (resumes) this.start(id, updated, login);
      }
      return this.snapshot();
    });
    this.controlTail = task.catch(() => {});
    return task;
  }

  start(id, record, login = false) {
    if (this.closed) return;
    const work = { controller: new AbortController(), transport: null, drain: null, retryTimer: null, authTail: Promise.resolve() };
    this.work.set(id, work);
    const { signal } = work.controller;
    const active = () => !signal.aborted && this.work.get(id) === work;
    const allowSender = sender => active() && record.allowedSenders.includes(sender);
    this.health.set(id, { status: 'connecting' });
    const setStatus = (status, code) => {
      if (!active() || !STATUS.has(status)) return;
      const errorCode = errors.has(code) ? code : status === 'error' ? 'NETWORK_ERROR'
        : status === 'auth-required' ? 'AUTH_REQUIRED' : undefined;
      const login = this.health.get(id)?.login;
      this.health.set(id, { status, errorCode, login });
      if (status === 'connected') this.kick(id, record, work);
    };
    work.run = Promise.resolve().then(async () => {
      if (!active()) return;
      work.transport = this.create(record.config, {
        signal, allowSender, allowedSenders: record.allowedSenders,
        authState: record.authState, login,
        setDiagnostic: code => {
          if (active() && errors.has(code)) this.health.set(id, { ...this.health.get(id), errorCode: code });
        },
        onAuthState: authState => {
          const persist = work.authTail.then(async () => {
            if (this.work.get(id) !== work || this.records.get(id)?.generation !== record.generation) return;
            if (typeof authState !== 'string' || authState.length > 2 * 1024 * 1024) {
              throw new BridgeError('STORAGE_ERROR', '登录状态超出凭据记录限制。', 500);
            }
            const current = this.records.get(id);
            const updated = { ...current, authState };
            await this.accounts.set(id, updated);
            this.records.set(id, updated);
          });
          work.authTail = persist.catch(() => { setStatus('error', 'STORAGE_ERROR'); });
          return persist;
        },
        onLogin: value => {
          if (!active()) return;
          const qrUrl = value?.qrUrl;
          const authorizationUrl = value?.authorizationUrl;
          let view;
          if (typeof qrUrl === 'string' && qrUrl.length <= 65536 && /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(qrUrl)) {
            view = { qrUrl };
          }
          if (typeof authorizationUrl === 'string' && authorizationUrl.length <= 4096) {
            try {
              const url = new URL(authorizationUrl);
              if (url.origin === 'https://linear.app' && url.pathname.startsWith('/oauth/') && !url.username && !url.password) {
                view = { ...view, authorizationUrl };
              }
            } catch { /* Invalid authorization URL. */ }
          }
          this.health.set(id, { ...this.health.get(id), login: view });
        },
        setStatus,
        onMessage: raw => this.receive(id, record, work, raw, allowSender),
      }, id);
      await work.transport.run();
      if (active() && !['error', 'auth-required'].includes(this.health.get(id)?.status)) {
        setStatus('error', 'RECEIVER_STOPPED');
      }
    }).catch(error => {
      if (error?.kind === 'auth') setStatus('auth-required', error.code);
      else setStatus('error', error?.code);
    });
  }

  async receive(id, record, work, raw, allowSender) {
    if (!allowSender(raw?.senderId)) return false;
    const message = normalizeMessage(raw);
    if (!message) return false;
    const key = hash(JSON.stringify([message.senderId, message.chatId, message.threadId ?? '', message.id,
      ...(message.instanceId === undefined ? [] : [message.instanceId])]));
    let accepted = false;
    await this.mutate(async state => {
      if (!allowSender(message.senderId)) return false;
      let box = state.channels[id];
      if (!box || box.generation !== record.generation) {
        box = newMailbox(record.generation);
        state.channels[id] = box;
      }
      if (box.seen.includes(key) || box.queue.some(entry => entry.key === key)) return false;
      const peer = box.routes?.[routeKey(message)];
      if (message.requireExistingSession && (!peer || (this.backend.hasSession && !await this.backend.hasSession(peer.sessionId)))) return false;
      if (box.queue.length >= MAX_QUEUE) throw new BridgeError('BUSY', '渠道消息队列已满。', 429);
      if (message.attachments.length && this.admitAttachments) {
        message.content = await this.admitAttachments(message.attachments);
        message.attachments = [];
        if (!allowSender(message.senderId)) return false;
      }
      const stop = message.text === '/stop' && !message.attachments.length && !message.content?.length;
      const stopped = stop && peer && this.backend.interrupt?.(peer.sessionId);
      box.queue.push(stop ? { key, phase: 'ready', message, reply: stopped ? '已停止当前请求。' : '没有正在运行的请求。' }
        : { key, phase: 'queued', message });
      box.seen = [...box.seen, key].slice(-MAX_SEEN);
      box.lastMessageAt = this.now();
      accepted = true;
    });
    this.kick(id, record, work);
    return accepted;
  }

  async sendToSession(sessionId, { id: outboundId, text, attachments, buttons = [] }) {
    if (!CHANNEL_SESSION_PATTERN.test(sessionId)) return false;
    for (const [id, box] of Object.entries(this.state.channels)) {
      const peer = Object.values(box.routes ?? {}).find(route => route.sessionId === sessionId);
      const record = this.records.get(id);
      if (!peer || !record?.enabled || record.generation !== box.generation || !record.allowedSenders.includes(peer.message.senderId)) continue;
      const key = hash(JSON.stringify([sessionId, outboundId]));
      const reply = typeof text === 'string' ? text.trim().slice(0, MAX_REPLY_CHARS) : '';
      const files = outboundAttachments(attachments);
      if (!reply && !files.length) return false;
      const choices = channelButtons(buttons);
      let queued = false;
      await this.mutate(state => {
        const current = state.channels[id];
        if (current?.generation !== record.generation || !this.records.get(id)?.allowedSenders.includes(peer.message.senderId)
          || !this.records.get(id)?.enabled || current.routes?.[routeKey(peer.message)]?.sessionId !== sessionId) return false;
        if (current.seen.includes(key)) { queued = true; return false; }
        if (current.queue.length >= MAX_QUEUE) throw new BridgeError('BUSY', '渠道消息队列已满。', 429);
        current.queue.push({ key, phase: 'ready', message: { ...peer.message, id: replyKey(key) }, reply,
          ...(files.length ? { files } : {}), ...(choices.length ? { buttons: choices } : {}),
          proactive: true, destinationSessionId: sessionId });
        current.seen = [...current.seen, key].slice(-MAX_SEEN);
        queued = true;
      });
      const work = this.work.get(id);
      if (queued && work) this.kick(id, record, work);
      return queued;
    }
    return false;
  }

  boundSessions() {
    const sessions = [];
    for (const [id, box] of Object.entries(this.state.channels)) {
      const record = this.records.get(id);
      if (record?.generation !== box.generation) continue;
      for (const peer of Object.values(box.routes ?? {})) {
        if (record.allowedSenders.includes(peer.message.senderId)) sessions.push(peer.sessionId);
      }
    }
    return sessions;
  }

  kick(id, record, work) {
    const connected = () => !work.controller.signal.aborted && this.health.get(id)?.status === 'connected';
    clearTimeout(work.retryTimer);
    if (!connected() || work.drain) return;
    const ready = nextMessage(this.state.channels[id], this.now());
    if (!ready.entry) {
      if (Number.isFinite(ready.retryAt)) {
        work.retryTimer = setTimeout(() => this.kick(id, record, work), Math.max(1, ready.retryAt - this.now()));
        work.retryTimer.unref();
      }
      return;
    }
    const drain = this.drain(id, record, work, connected).catch(() => {
      if (connected()) this.health.set(id, { status: 'error', errorCode: 'STORAGE_ERROR' });
    });
    work.drain = drain.finally(() => {
      work.drain = null;
      this.kick(id, record, work);
    });
  }

  async drain(id, record, work, connected) {
    const { signal } = work.controller;
    const catalogItem = this.catalog.find(item => item.id === id);
    const setError = errorCode => this.health.set(id, { ...this.health.get(id), errorCode });
    while (connected()) {
      const box = this.state.channels[id];
      const { entry } = nextMessage(box, this.now());
      if (!entry || box.generation !== record.generation) return;
      const change = change => this.mutate(state => {
        const mailbox = state.channels[id];
        const found = mailbox?.queue.find(item => item.key === entry.key);
        if (!found) return false;
        change(found, mailbox);
      });
      const finish = uncertain => change((item, mailbox) => {
        mailbox.queue = mailbox.queue.filter(candidate => candidate !== item);
        if (uncertain) mailbox.uncertainReplies++;
      });
      const { message } = entry;
      if (!record.allowedSenders.includes(message.senderId)) {
        await finish(false);
        continue;
      }
      if (entry.destinationSessionId && box.routes?.[routeKey(message)]?.sessionId !== entry.destinationSessionId) {
        await finish(false);
        continue;
      }
      if (entry.phase === 'queued') {
        const route = routeKey(message);
        const rotate = message.text === '/new' && !message.attachments.length && !message.content?.length;
        const epoch = rotate ? entry.key : box.routes?.[route]?.epoch;
        const scope = sessionScope(id, record.generation, message, epoch);
        const sessionId = sessionFor(scope);
        const { content, ...routeMessage } = message;
        const destination = { ...routeMessage, text: '', attachments: [] };
        const rememberRoute = mailbox => {
          mailbox.routes ??= {};
          mailbox.routes[route] = {
            sessionId, ...(epoch === undefined ? {} : { epoch }), message: destination, established: !rotate, lastSeenAt: this.now(),
          };
        };
        await change((item, mailbox) => {
          rememberRoute(mailbox);
          if (rotate) { item.phase = 'ready'; item.reply = '已开始新会话。'; }
        });
        if (rotate) continue;
        let result;
        let updateTail = Promise.resolve();
        let count = 0;
        let pending = 0;
        let updateFailed = false;
        const onUpdate = update => {
          const preference = Object.hasOwn(updates, update?.type) && updates[update.type];
          const settings = this.getPreferences(id);
          const enabled = preference && (!catalogItem.replyOptions || catalogItem.replyOptions.includes(preference))
            && (settings[preference] ?? record.config[preference] ?? catalogItem.replyDefaults?.[preference]);
          if (!enabled || !connected() || updateFailed || pending >= 4 || typeof update.text !== 'string' || !update.text || count >= 512
            || !work.transport.sendUpdate) return;
          count++;
          pending++;
          updateTail = updateTail.then(() => !updateFailed && connected() && work.transport.sendUpdate({
            type: update.type, text: update.text.slice(0, MAX_REPLY_CHARS), metadata: update.metadata,
            messageId: replyKey(entry.key), route: message.route, message,
          })).catch(() => { updateFailed = true; }).finally(() => { pending--; });
        };
        try {
          result = await this.backend.run({
            channelId: id, sessionId, message, text: message.text, content: message.content,
            allowReasoning: (this.getPreferences(id).showReasoning ?? record.config.showReasoning) === true,
            messageId: `dshbridge-in-${hash(JSON.stringify([...scope, entry.key])).slice(0, 48)}`,
          }, signal, onUpdate);
        } catch (error) {
          if (signal.aborted) return;
          if (error?.code === 'LEGACY_PRESET') {
            await change(item => { item.phase = 'ready'; item.reply = LEGACY_PRESET_NOTICE; });
          } else if (error?.code === 'FORBIDDEN') {
            setError('SESSION_FAILED');
            await finish(false);
          } else {
            setError(error?.code === 'MODEL_UNAVAILABLE' ? 'MODEL_UNAVAILABLE' : 'SESSION_FAILED');
            await change(item => { item.retryAt = this.now() + this.retryMs; });
          }
          continue;
        }
        await updateTail;
        if (signal.aborted) return;
        const files = outboundAttachments(result.attachments);
        if (result.state !== 'completed' || (!result.text && !files.length)) {
          setError('SESSION_FAILED');
          await finish(false);
        } else {
          await change(item => {
            item.phase = 'ready'; item.reply = (result.text ?? '').slice(0, MAX_REPLY_CHARS);
            if (files.length) item.files = files;
          });
        }
        continue;
      }
      if (entry.phase === 'sending') {
        setError('DELIVERY_UNCERTAIN');
        await finish(true);
        continue;
      }
      await change(item => { item.phase = 'sending'; });
      if (signal.aborted || !connected()) {
        await change(item => { item.phase = 'ready'; });
        return;
      }
      try {
        const payload = { messageId: replyKey(entry.key), route: message.route, message, text: entry.reply,
          attachments: entry.files, metadata: entry.proactive ? { proactive: true, buttons: entry.buttons } : undefined };
        if (work.transport.sendPayload) await work.transport.sendPayload(payload);
        else await work.transport.send(message, entry.reply, payload);
      } catch (error) {
        if (error?.kind === 'retry' || error?.kind === 'auth') {
          await change(item => { item.phase = 'ready'; });
          if (error.kind === 'auth' && !signal.aborted) {
            this.health.set(id, { status: 'auth-required', errorCode: 'AUTH_REQUIRED' });
            return;
          }
          await change(item => { item.retryAt = this.now() + this.retryMs; });
          continue;
        }
        setError(error?.kind === 'rejected' ? 'DELIVERY_REJECTED' : 'DELIVERY_UNCERTAIN');
        await finish(error?.kind !== 'rejected');
        continue;
      }
      await finish(false);
      if (connected()) setError(undefined);
    }
  }

  async stop(id) {
    const work = this.work.get(id);
    if (!work) return;
    work.controller.abort();
    clearTimeout(work.retryTimer);
    try { await work.transport?.stop?.(); }
    finally {
      await Promise.allSettled([work.run, work.drain, work.authTail]);
      this.work.delete(id);
      this.health.delete(id);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const work of this.work.values()) work.controller.abort();
    await this.controlTail;
    const results = await Promise.allSettled([...this.work.keys()].map(id => this.stop(id)));
    await this.stateTail;
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
}
