import { randomBytes } from 'node:crypto';
import { ILinkClient, extractMediaMessage, extractTextMessage, splitText, validateBaseUrl } from './ilink.js';
import {
  VERSION, MAX_USERS, MAX_SEEN, MAX_INBOX, MAX_OUTBOX, MAX_INPUT_CHARS, MAX_REPLY_CHARS,
  PAIRING_TTL_MS, LOGIN_TTL_MS, CONTEXT_MAX_AGE_MS,
  BridgeError, accountKey, inputKey, messageId, clientId, freshPairingCode,
  pairingHash, matchesPairingCode, initialState, trimState, safeError, delay,
} from './state.js';

const pendingOutput = item => ['pending', 'blocked', 'sending'].includes(item.state);
const pendingInput = item => ['queued', 'submitted'].includes(item.state);
const freshSessionId = () => `wxbridge-${randomBytes(16).toString('hex')}`;
const pendingLogin = login => login && ['waiting', 'scanned', 'verify-code'].includes(login.status);

/** Purely injected runtime: testable without a live DSH, network, or model. */
export class WeixinBridge {
  constructor({ store, accounts, backend, qrCode, clientFactory = options => new ILinkClient(options),
    workspaceDir, now = Date.now, wait = delay, contextBudget = 8, pollTimeoutMs = 35000, admitAttachments }) {
    Object.assign(this, { store, accounts, backend, qrCode, clientFactory, workspaceDir, now, wait, contextBudget, pollTimeoutMs, admitAttachments });
    this.state = initialState();
    this.status = 'disconnected'; this.lastError = null; this.lastPollAt = null;
    this.accountView = null; this.login = null;
    this.stateTail = Promise.resolve(); this.controlTail = Promise.resolve();
    this.lifetime = new AbortController(); this.tasks = new Set();
    this.channel = null; this.channelTasks = []; this.closed = false;
  }

  async initialize() {
    this.state = structuredClone(this.store.read() ?? initialState());
    let account;
    try { account = await this.accounts.get(); }
    catch (error) {
      this.status = 'error';
      this.lastError = safeError(error);
      return this.snapshot();
    }
    if (account) {
      this.accountView = { botId: account.botId, userId: account.userId };
      if (this.state.accountKey !== account.id) {
        await this.mutate(state => Object.assign(state, initialState(), { accountKey: account.id }));
      }
      // An interrupted HTTP send has an unknown outcome. Never blindly replay it.
      await this.mutate(state => {
        for (const item of state.outbox) if (item.state === 'sending') {
          item.state = 'uncertain'; item.lastError = '上次发送结果不确定，请在 DSH 查看回答。';
        }
      });
      this.status = this.state.enabled ? 'connecting' : 'paused';
      if (this.state.enabled) this.startChannel();
    } else if (this.state.enabled || this.state.accountKey) {
      await this.mutate(state => Object.assign(state, initialState()));
    }
    return this.snapshot();
  }

  track(promise) {
    this.tasks.add(promise);
    void promise.then(() => this.tasks.delete(promise), () => this.tasks.delete(promise));
    return promise;
  }
  mutate(change) {
    const operation = this.stateTail.then(async () => {
      const next = structuredClone(this.state);
      const result = await change(next);
      trimState(next);
      await this.store.write(next);
      this.state = next;
      return result;
    });
    this.stateTail = operation.catch(() => {});
    return operation;
  }
  control(operation) {
    const result = this.controlTail.then(() => {
      if (this.closed) throw new BridgeError('BUSY', '插件正在关闭，请稍后重试。', 409);
      return operation();
    });
    this.controlTail = result.catch(() => {});
    return result;
  }
  snapshot() {
    const login = this.login;
    const expired = login && login.expiresAt <= this.now() && pendingLogin(login);
    return structuredClone({
      version: VERSION, connectionStatus: this.status, enabled: this.state.enabled,
      account: this.accountView, workspaceDir: this.workspaceDir,
      model: this.backend.model(),
      login: login ? {
        id: login.id, status: expired ? 'expired' : login.status,
        qrDataUrl: !expired && pendingLogin(login) ? login.qrDataUrl : '', expiresAt: login.expiresAt,
        verificationFailed: Boolean(login.verificationFailed), ...(login.error ? { error: login.error } : {}),
      } : null,
      users: this.state.users.map(user => ({
        userId: user.userId, status: user.status, firstSeenAt: user.firstSeenAt, lastSeenAt: user.lastSeenAt,
        ...(user.sessionId ? { sessionId: user.sessionId } : {}),
        ...(user.pairingExpiresAt ? { pairingExpiresAt: user.pairingExpiresAt } : {}),
        ...(user.pairingStatus ? { pairingStatus: user.pairingExpiresAt <= this.now() ? 'expired' : user.pairingStatus } : {}),
        ...(user.lastError ? { lastError: user.lastError } : {}),
      })),
      pendingReplies: this.state.inbox.filter(pendingInput).length + this.state.outbox.filter(pendingOutput).length,
      failedReplies: this.state.outbox.filter(item => ['failed', 'uncertain'].includes(item.state)).length,
      lastPollAt: this.lastPollAt, lastError: this.lastError,
    });
  }

  async action(action, args = {}, { user = false } = {}) {
    if (action === 'status') return this.snapshot();
    const authorityActions = ['login.start', 'login.verify', 'login.cancel', 'connection.resume', 'user.approve', 'user.revoke'];
    if (authorityActions.includes(action) && !user) throw new BridgeError('FORBIDDEN', '此操作只能由本人在 DSH 设置中完成。', 403);
    return this.control(async () => {
      switch (action) {
        case 'login.start': await this.startLogin(Boolean(args.force)); break;
        case 'login.verify': this.verifyLogin(args.loginId, args.code); break;
        case 'login.cancel': this.cancelLogin(args.loginId); break;
        case 'connection.pause': await this.pause(); break;
        case 'connection.resume': await this.resume(); break;
        case 'connection.disconnect': await this.disconnect(); break;
        case 'user.approve': await this.approve(args.userId, args.code); break;
        case 'user.revoke': await this.revoke(args.userId); break;
        default: throw new BridgeError('INVALID_REQUEST', '不支持的微信连接操作。');
      }
      return this.snapshot();
    });
  }

  cancelLogin(id) {
    if (!this.login) return;
    if (id && id !== this.login.id) throw new BridgeError('LOGIN_EXPIRED', '扫码页面已更新，请刷新后重试。', 409);
    this.login.controller.abort();
    if (pendingLogin(this.login)) this.login.status = 'expired';
    this.login.qrDataUrl = '';
    if (this.status === 'connecting') this.status = this.accountView ? 'paused' : 'disconnected';
  }
  async startLogin(force) {
    this.cancelLogin();
    await this.pause();
    const saved = await this.accounts.get();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    const client = this.clientFactory({});
    const id = randomBytes(18).toString('hex');
    this.login = { id, controller, status: 'waiting', qrDataUrl: '', expiresAt: this.now() + LOGIN_TTL_MS,
      client, currentBase: 'https://ilinkai.weixin.qq.com', qrcodeId: '', verifyCode: '', verificationFailed: false, refreshes: 0, force };
    const login = this.login;
    this.status = 'connecting'; this.lastError = null;
    try {
      const qr = await client.fetchQr({ localTokens: saved ? [saved.token] : [], force, signal });
      if (this.login !== login || signal.aborted) return;
      login.qrcodeId = qr.qrcodeId;
      login.qrDataUrl = await this.qrCode(qr.qrContent);
      if (signal.aborted || this.login !== login) return;
      this.track(this.pollLogin(login, signal));
    } catch (error) {
      if (!signal.aborted && this.login === login) {
        login.status = 'failed'; login.error = safeError(error); login.qrDataUrl = '';
        this.status = this.accountView ? 'paused' : 'disconnected';
      }
      throw error;
    }
  }
  verifyLogin(id, code) {
    const login = this.login;
    if (!login || login.id !== id || login.expiresAt <= this.now() || !pendingLogin(login)) {
      throw new BridgeError('LOGIN_EXPIRED', '二维码已过期，请重新扫码。', 409);
    }
    if (login.status !== 'verify-code') throw new BridgeError('LOGIN_VERIFY_REQUIRED', '当前登录不需要验证码，请等待扫码结果。', 409);
    if (typeof code !== 'string' || !/^\d{1,12}$/.test(code.trim())) throw new BridgeError('INVALID_REQUEST', '请输入微信中显示的数字验证码。');
    login.verifyCode = code.trim(); login.status = 'scanned';
  }
  async pollLogin(login, signal) {
    try {
      while (!signal.aborted && this.login === login && this.now() < login.expiresAt) {
        if (login.status === 'verify-code') { await this.wait(500, signal); continue; }
        let data;
        try {
          data = await login.client.pollQr({ qrcodeId: login.qrcodeId, baseUrl: login.currentBase, verifyCode: login.verifyCode, signal });
        } catch (error) {
          if (signal.aborted) return;
          if (error.retryable) { await this.wait(1500, signal); continue; }
          throw error;
        }
        if (signal.aborted || this.login !== login) return;
        if (data.status === 'confirmed') {
          const token = typeof data.bot_token === 'string' ? data.bot_token : '';
          if (!token || token.length > 8192) throw new BridgeError('AUTH_REQUIRED', '微信未返回有效登录凭据，请重新扫码。', 502);
          const baseUrl = data.baseurl ? validateBaseUrl(data.baseurl) : login.currentBase;
          const botId = typeof data.ilink_bot_id === 'string' ? data.ilink_bot_id.slice(0, 256) : '';
          const userId = typeof data.ilink_user_id === 'string' ? data.ilink_user_id.slice(0, 256) : '';
          const account = { token, baseUrl, botId, userId, contexts: [] };
          account.id = accountKey(account);
          await this.control(async () => {
            if (this.login !== login || signal.aborted || this.closed) return;
            await this.stopChannel();
            const changed = this.state.accountKey !== account.id;
            await this.accounts.set(account);
            await this.mutate(state => {
              if (changed) Object.assign(state, initialState());
              state.accountKey = account.id; state.enabled = true;
              for (const output of state.outbox) if (output.state === 'blocked') output.contextVersion = 0;
            });
            this.accountView = { botId, userId }; this.status = 'connecting'; this.lastError = null;
            login.status = 'succeeded'; login.qrDataUrl = ''; login.verifyCode = '';
            this.startChannel();
          });
          return;
        }
        if (data.status === 'scaned_but_redirect') {
          const host = String(data.redirect_host || '');
          if (host) login.currentBase = validateBaseUrl(host.startsWith('https://') ? host : `https://${host}`);
          login.status = 'scanned';
        } else if (data.status === 'need_verifycode') {
          login.verificationFailed = Boolean(login.verifyCode); login.verifyCode = ''; login.status = 'verify-code';
        } else if (['expired', 'verify_code_blocked'].includes(data.status)) {
          if (++login.refreshes > 3) { login.status = 'expired'; break; }
          const qr = await login.client.fetchQr({ force: login.force, signal });
          if (signal.aborted || this.login !== login) return;
          login.qrcodeId = qr.qrcodeId; login.qrDataUrl = await this.qrCode(qr.qrContent);
          login.currentBase = 'https://ilinkai.weixin.qq.com'; login.status = 'waiting'; login.verifyCode = '';
        } else if (data.status === 'binded_redirect') {
          throw new BridgeError('AUTH_REQUIRED', '微信报告已有绑定，请选择重新扫码并确认目标账号。', 409);
        } else if (['scaned', 'scanned'].includes(data.status)) login.status = 'scanned';
        await this.wait(1000, signal);
      }
      if (!signal.aborted && this.login === login && pendingLogin(login)) login.status = 'expired';
    } catch (error) {
      if (!signal.aborted && this.login === login) { login.status = 'failed'; login.error = safeError(error); }
    } finally {
      if (this.login === login && ['expired', 'failed'].includes(login.status)) {
        login.qrDataUrl = ''; this.status = this.accountView ? 'paused' : 'disconnected';
      }
    }
  }

  startChannel() {
    if (this.closed || this.channel || !this.state.enabled) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
    this.channel = controller;
    const guarded = operation => operation.catch(async error => {
      if (signal.aborted || this.closed) return;
      this.lastError = safeError(error); this.status = 'error'; controller.abort();
    });
    this.channelTasks = [this.track(guarded(this.poll(signal))), this.track(guarded(this.work(signal)))];
  }
  async stopChannel() {
    this.channel?.abort();
    await this.backend.stopWork();
    await Promise.allSettled(this.channelTasks);
    this.channel = null; this.channelTasks = [];
  }
  async pause() {
    this.cancelLogin();
    await this.mutate(state => { state.enabled = false; });
    await this.stopChannel();
    this.status = this.accountView ? 'paused' : 'disconnected';
  }
  async resume() {
    const account = await this.accounts.get();
    if (!account || account.id !== this.state.accountKey) throw new BridgeError('NOT_CONNECTED', '请先扫码连接微信。', 409);
    await this.stopChannel();
    await this.mutate(state => { state.enabled = true; });
    this.status = 'connecting'; this.lastError = null;
    this.startChannel();
  }
  async disconnect() {
    this.cancelLogin();
    await this.pause();
    await this.accounts.delete();
    await this.mutate(state => Object.assign(state, initialState()));
    this.accountView = null; this.login = null; this.status = 'disconnected'; this.lastError = null; this.lastPollAt = null;
  }
  async approve(userId, code) {
    const user = this.state.users.find(user => user.userId === userId);
    if (!user || user.status !== 'pending') throw new BridgeError('INVALID_REQUEST', '请先从微信发送一条消息，获取新的配对请求。');
    if (this.state.users.some(user => user.status === 'approved' && user.userId !== userId)) {
      throw new BridgeError('ALREADY_APPROVED', '首版仅允许本人一个微信用户；请先撤销现有用户。', 409);
    }
    if (!user.pairingExpiresAt || user.pairingExpiresAt <= this.now() || (user.pairingAttempts || 0) >= 5) {
      throw new BridgeError('PAIRING_CODE_EXPIRED', '配对码已过期，请从微信再发一条消息获取新码。', 409);
    }
    if (!matchesPairingCode(user, code)) {
      await this.mutate(state => {
        const current = state.users.find(item => item.userId === userId);
        current.pairingAttempts = (current.pairingAttempts || 0) + 1;
        if (current.pairingAttempts >= 5) { current.pairingExpiresAt = 0; current.pairingHash = ''; }
      });
      throw new BridgeError('PAIRING_CODE_INVALID', '配对码不正确，请对照微信收到的 8 位配对码。');
    }
    await this.mutate(state => {
      const current = state.users.find(item => item.userId === userId);
      current.status = 'approved'; current.sessionId ||= freshSessionId();
      current.pairingHash = ''; current.pairingExpiresAt = 0; current.lastError = '';
    });
  }
  async revoke(userId) {
    if (!this.state.users.some(user => user.userId === userId)) throw new BridgeError('INVALID_REQUEST', '未找到此微信用户。');
    const enabled = this.state.enabled;
    await this.pause();
    await this.mutate(state => {
      const user = state.users.find(user => user.userId === userId);
      user.status = 'revoked'; user.pairingHash = ''; user.pairingExpiresAt = 0;
      for (const item of state.inbox) if (item.userId === userId && pendingInput(item)) item.state = 'failed';
      for (const item of state.outbox) if (item.userId === userId && pendingOutput(item)) item.state = 'failed';
    });
    await this.accounts.update(account => ({ ...account, contexts: account.contexts.filter(context => context.userId !== userId) }));
    if (enabled) await this.resume();
  }
  isApproved(userId, key = this.state.accountKey) {
    return this.state.accountKey === key && this.state.users.some(user => user.userId === userId && user.status === 'approved');
  }
  active(signal) { return !this.closed && !signal.aborted && this.state.enabled; }
  async requireAccount() {
    const account = await this.accounts.get();
    if (!account || account.id !== this.state.accountKey) throw new BridgeError('NOT_CONNECTED', '微信连接状态已改变，请重新连接。', 409);
    return account;
  }
  async authExpired(signal) {
    if (signal?.aborted) return;
    this.lastError = '微信登录已失效，请重新扫码连接。';
    await this.mutate(state => { state.enabled = false; });
    this.status = 'auth-required'; this.channel?.abort();
  }
  async poll(signal) {
    let failures = 0;
    let timeoutMs = this.pollTimeoutMs;
    while (this.active(signal)) {
      const started = this.now();
      try {
        const account = await this.requireAccount();
        const client = this.clientFactory({ token: account.token, baseUrl: account.baseUrl });
        const data = await client.getUpdates({ cursor: this.state.cursor, timeoutMs, signal });
        if (!this.active(signal)) break;
        failures = 0; this.status = 'connected'; this.lastError = null; this.lastPollAt = this.now();
        if (Number.isFinite(data.longpolling_timeout_ms) && data.longpolling_timeout_ms > 0) {
          timeoutMs = Math.max(5000, Math.min(60000, data.longpolling_timeout_ms));
        }
        if (data.msgs != null && !Array.isArray(data.msgs)) throw new BridgeError('INTERNAL_ERROR', '微信返回的消息列表格式异常，未确认拉取游标。', 502);
        if (data.get_updates_buf !== undefined && (typeof data.get_updates_buf !== 'string' || data.get_updates_buf.length > 65536)) {
          throw new BridgeError('INTERNAL_ERROR', '微信返回的拉取游标格式异常，未确认此批消息。', 502);
        }
        const messages = data.msgs ?? [];
        // Persist accepted inputs before acknowledging the server's cursor.
        for (const raw of messages) {
          if (!this.active(signal)) break;
          await this.receive(raw, account.id, signal, client);
        }
        if (this.active(signal) && typeof data.get_updates_buf === 'string') {
          await this.mutate(state => { state.cursor = data.get_updates_buf; });
        }
        if (this.now() - started < 250) await this.wait(500, signal);
      } catch (error) {
        if (!this.active(signal)) break;
        if (error.kind === 'auth') { await this.authExpired(signal); break; }
        this.lastError = safeError(error); this.status = 'error';
        if (error instanceof BridgeError || error.retryable !== true) throw error;
        await this.wait(++failures >= 3 ? 30000 : 2000, signal);
      }
    }
  }

  async setContext(key, userId, token) {
    await this.accounts.update(account => {
      if (account.id !== key) return account;
      const old = account.contexts.find(context => context.userId === userId);
      const context = { userId, token, updatedAt: this.now(), version: (old?.version || 0) + 1,
        count: old?.token === token ? old.count : 0 };
      return { ...account, contexts: [...account.contexts.filter(context => context.userId !== userId), context].slice(-MAX_USERS) };
    });
  }
  async receive(raw, key, signal, client) {
    const textMessage = extractTextMessage(raw);
    const mediaMessage = this.admitAttachments && client?.downloadMedia ? extractMediaMessage(raw) : null;
    const message = mediaMessage || textMessage;
    if (!message || !message.contextToken || !this.active(signal) || this.state.accountKey !== key) return;
    const id = inputKey(key, message.userId, message.id);
    if (this.state.seen.includes(id)) return;
    const known = this.state.users.find(user => user.userId === message.userId);
    const bound = this.state.users.find(user => user.status === 'approved');
    if (bound && bound.userId !== message.userId) {
      await this.mutate(state => { state.seen.push(id); });
      return;
    }
    if (!known && this.state.users.length >= MAX_USERS) return;
    if ((!known || known.status !== 'approved') && !textMessage) return;
    await this.setContext(key, message.userId, message.contextToken);
    if (!known || known.status !== 'approved') {
      let code = '';
      await this.mutate(state => {
        let user = state.users.find(user => user.userId === message.userId);
        if (!user) {
          user = { userId: message.userId, status: 'pending', firstSeenAt: this.now(), lastSeenAt: this.now(),
            sessionId: '', pairingHash: '', pairingExpiresAt: 0, pairingAttempts: 0, pairingStatus: 'expired', lastError: '' };
          state.users.push(user);
        }
        user.lastSeenAt = this.now();
        if (user.pairingExpiresAt <= this.now() || user.pairingStatus === 'failed' || user.status === 'revoked') {
          code = freshPairingCode(); user.status = 'pending'; user.pairingHash = pairingHash(user.userId, code);
          user.pairingExpiresAt = this.now() + PAIRING_TTL_MS; user.pairingAttempts = 0; user.pairingStatus = 'failed';
        }
        state.seen.push(id);
      });
      if (code && this.active(signal)) {
        try {
          await this.sendRaw(message.userId,
            `DSH 微信连接配对码：${code}\n请在 DSH → 消息渠道 → 微信中输入此码，仅批准你本人的账号。10 分钟内有效。批准后请重新发送消息。`,
            clientId(id, 'pairing'), signal);
          await this.mutate(state => {
            const user = state.users.find(user => user.userId === message.userId);
            if (user && user.pairingHash === pairingHash(user.userId, code)) { user.pairingStatus = 'sent'; user.lastError = ''; }
          });
        } catch (error) {
          if (signal.aborted) return;
          if (error.kind === 'auth') { await this.authExpired(signal); return; }
          await this.mutate(state => {
            const user = state.users.find(user => user.userId === message.userId);
            if (user) user.lastError = safeError(error);
          });
        }
      }
      return;
    }
    await this.mutate(async state => {
      const user = state.users.find(user => user.userId === message.userId);
      if (!this.active(signal) || state.accountKey !== key || user?.status !== 'approved' || state.seen.includes(id)) return;
      let notice = '';
      if ([...message.text].length > MAX_INPUT_CHARS) notice = '消息过长，请分成较短的文本重新发送（每条最多 12000 字符）。';
      else if (state.inbox.filter(pendingInput).length >= MAX_INBOX
        || state.outbox.filter(pendingOutput).length >= MAX_OUTBOX) notice = '当前待处理消息较多，请等待已有回复后再发送。';
      else if (state.inbox.filter(item => item.createdAt > this.now() - 60000).length >= 10) notice = '消息过于频繁，请稍等一分钟后再发送。';
      if (notice) {
        user.lastSeenAt = this.now();
        state.seen.push(id);
        this.addOutput(state, { id: `notice-${id}`, userId: message.userId, key, text: notice });
        return;
      }
      let content;
      if (mediaMessage?.media?.length) {
        const downloaded = await client.downloadMedia(mediaMessage.media, { signal });
        if (!this.active(signal)) return;
        content = await this.admitAttachments(downloaded);
        if (!this.active(signal)) return;
      }
      user.lastSeenAt = this.now();
      state.seen.push(id);
      if (content?.length === 0 && !message.text) return;
      state.inbox.push({ id, messageId: messageId(id), userId: message.userId, sessionId: user.sessionId,
        accountKey: key, text: message.text, ...(content ? { content } : {}),
        createdAt: this.now(), state: 'queued', lastError: '' });
    });
  }

  addOutput(state, { id, userId, key, text, sessionId = '', messageId = '', reserved = false }) {
    if (state.outbox.some(item => item.id === id)) return true;
    if (state.outbox.filter(pendingOutput).length >= MAX_OUTBOX + (reserved ? 1 : 0)) return false;
    const clipped = [...String(text)].slice(0, MAX_REPLY_CHARS).join('');
    let parts = splitText(clipped);
    if (parts.length > 4) parts = parts.slice(0, 4);
    if (String(text).length > clipped.length || splitText(clipped).length > 4) {
      const tail = '\n……内容较长，完整回答请在 DSH 查看。';
      if (!parts.length) parts = [tail.trim()];
      else parts[parts.length - 1] = [...parts.at(-1)].slice(0, 1700).join('') + tail;
    }
    if (!parts.length) return false;
    state.outbox.push({ id, userId, accountKey: key, sessionId, messageId, parts,
      nextPart: 0, state: 'pending', contextVersion: 0, createdAt: this.now(), lastError: '' });
    return true;
  }
  async work(signal) {
    while (this.active(signal)) {
      const entry = this.state.inbox.find(pendingInput);
      if (entry && this.state.outbox.filter(pendingOutput).length >= MAX_OUTBOX) {
        await this.deliver(signal);
        await this.wait(1000, signal);
        continue;
      }
      if (entry && this.isApproved(entry.userId, entry.accountKey)) {
        await this.mutate(state => { const item = state.inbox.find(item => item.id === entry.id); if (item) item.state = 'submitted'; });
        let result;
        try { result = await this.backend.run(entry, signal); }
        catch (error) {
          if (signal.aborted) break;
          result = { state: 'failed', reason: error.code === 'MODEL_UNAVAILABLE' ? 'model' : 'error', text: '' };
        }
        if (!this.active(signal) || !this.isApproved(entry.userId, entry.accountKey)) break;
        const failures = {
          timeout: '本次回复超时，请稍后重新发送消息。',
          contaminated: '这个会话在 DSH 中有额外输入，为保护隐私已停止转发。请从微信重新发送，将开启新的隔离会话。',
          model: 'DSH 暂时没有可用模型，请在 DSH 模型设置中完成配置后重新发送。',
          interrupted: '上次处理因 DSH 重启或暂停而中断，请重新发送消息。',
        };
        const text = result.state === 'completed' ? result.text
          : (failures[result.reason] || '本次没有生成可发送的回答，请在 DSH 检查模型设置后重新发送。');
        await this.mutate(state => {
          const item = state.inbox.find(item => item.id === entry.id);
          if (!item) return;
          item.state = result.state === 'completed' ? 'completed' : 'failed';
          item.lastError = result.state === 'completed' ? '' : text;
          const user = state.users.find(user => user.userId === entry.userId);
          if (user) { user.lastError = item.lastError; if (result.reason === 'contaminated') user.sessionId = freshSessionId(); }
          if (!this.addOutput(state, { id: `reply-${entry.id}`, userId: entry.userId, key: entry.accountKey,
            text, sessionId: result.reason === 'contaminated' ? '' : entry.sessionId, messageId: entry.messageId, reserved: true })) {
            throw new BridgeError('BUSY', '回复队列已满，已保留此条输入，等待恢复后处理。', 409);
          }
        });
      } else if (entry) {
        await this.mutate(state => { const item = state.inbox.find(item => item.id === entry.id); if (item) item.state = 'failed'; });
      }
      await this.deliver(signal);
      if (!this.state.inbox.some(pendingInput)) await this.wait(1000, signal);
    }
  }

  async refreshedContext(userId, signal) {
    let account = await this.requireAccount();
    let context = account.contexts.find(context => context.userId === userId);
    if (!context) return null;
    if (this.now() - context.updatedAt >= CONTEXT_MAX_AGE_MS) {
      try {
        const data = await this.clientFactory({ token: account.token, baseUrl: account.baseUrl })
          .getConfig({ userId, contextToken: context.token, signal });
        if (typeof data.context_token === 'string' && data.context_token && data.context_token !== context.token) {
          await this.setContext(account.id, userId, data.context_token);
          account = await this.requireAccount(); context = account.contexts.find(context => context.userId === userId);
        }
      } catch (error) { if (error.kind === 'auth' || signal.aborted) throw error; }
    }
    return context;
  }
  async sendRaw(userId, text, id, signal) {
    const context = await this.refreshedContext(userId, signal);
    if (!context) throw Object.assign(new Error('Context unavailable'), { kind: 'context', retryable: false });
    let reserved = false;
    const account = await this.accounts.update(account => {
      const current = account.contexts.find(item => item.userId === userId);
      if (current?.token !== context.token || current.count >= this.contextBudget) return account;
      reserved = true;
      return { ...account, contexts: account.contexts.map(item => item.userId === userId ? { ...item, count: item.count + 1 } : item) };
    });
    if (!reserved || !account) throw Object.assign(new Error('Context budget unavailable'), { kind: 'context', retryable: false });
    if (!this.active(signal) || account.id !== this.state.accountKey) throw new BridgeError('BUSY', '微信连接已暂停。', 409);
    return this.clientFactory({ token: account.token, baseUrl: account.baseUrl })
      .sendText({ userId, text, contextToken: context.token, clientId: id, signal });
  }
  async deliver(signal) {
    for (const output of this.state.outbox.filter(pendingOutput)) {
      if (!this.active(signal)) return;
      if (!this.isApproved(output.userId, output.accountKey)) {
        await this.mutate(state => { const item = state.outbox.find(item => item.id === output.id); if (item) item.state = 'failed'; });
        continue;
      }
      if (output.sessionId && !this.backend.isSafe(output.sessionId)) {
        await this.mutate(state => {
          const item = state.outbox.find(item => item.id === output.id);
          if (item) { item.state = 'failed'; item.lastError = '会话包含 DSH 端输入，已停止微信转发。'; }
        });
        continue;
      }
      const account = await this.requireAccount();
      const context = account.contexts.find(item => item.userId === output.userId);
      if (output.state === 'blocked' && (!context || context.version <= output.contextVersion)) continue;
      for (let index = output.nextPart; index < output.parts.length; index++) {
        if (!this.active(signal)) return;
        await this.mutate(state => {
          const item = state.outbox.find(item => item.id === output.id);
          if (item) { item.state = 'sending'; item.contextVersion = context?.version || 0; }
        });
        try {
          await this.sendRaw(output.userId, output.parts[index], clientId(output.id, index), signal);
          await this.mutate(state => {
            const item = state.outbox.find(item => item.id === output.id);
            if (item) { item.nextPart = index + 1; item.state = item.nextPart === item.parts.length ? 'sent' : 'pending'; item.lastError = ''; }
          });
        } catch (error) {
          // No transport retry after an ambiguous send: stable IDs alone are not an exactly-once guarantee.
          await this.mutate(state => {
            const item = state.outbox.find(item => item.id === output.id);
            if (!item) return;
            item.state = error.kind === 'context' ? 'blocked'
              : (error.kind === 'business' || error.kind === 'auth' ? 'failed' : 'uncertain');
            item.lastError = error.kind === 'context' ? safeError(error)
              : '微信发送未确认，未自动重发；完整回答可在 DSH 查看。';
          });
          if (error.kind === 'auth') await this.authExpired(signal);
          break;
        }
      }
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true; this.lifetime.abort(); this.login?.controller.abort(); this.channel?.abort();
    await this.backend.stopWork();
    await Promise.allSettled([...this.tasks]);
    await this.controlTail; await this.stateTail;
    this.channel = null; this.channelTasks = [];
  }
}
