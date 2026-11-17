import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

// These are transport/controller and source checks only. No React, DOM, browser, or renderer is emulated.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const start = source.indexOf('// BEGIN CLIENT CORE');
const end = source.indexOf('// END CLIENT CORE');
assert.ok(start >= 0 && end > start, 'testable pure core markers exist');
const coreProgram = `${source.slice(start, end)}\n({
  safeQrSource, liveLogin, deriveLoginView, deriveFeedback, pairingBlock, validSnapshot, bridgeError, errorKey, createApi, createController,
  createChannelApi, parseChannelConfig,
});`;
const core = vm.runInNewContext(coreProgram, { AbortController, setTimeout, clearTimeout, Date });

function snapshot(overrides = {}) {
  return {
    version: '0.1.0', connectionStatus: 'disconnected', enabled: false,
    account: null, workspaceDir: '/private/weixin-chats', model: { provider: 'test', model: 'test-model' },
    login: null, users: [], pendingReplies: 0, failedReplies: 0, lastPollAt: null, lastError: null,
    ...overrides,
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fakeClock() {
  let now = 1_000;
  let sequence = 0;
  const jobs = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay) { const id = ++sequence; jobs.set(id, { fn, at: now + delay, delay }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    get jobs() { return [...jobs.values()]; },
    next() {
      const next = [...jobs.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      assert.ok(next, 'a timer is scheduled');
      jobs.delete(next[0]); now = next[1].at; next[1].fn();
    },
  };
}
async function flush() { for (let i = 0; i < 5; i += 1) await Promise.resolve(); }
function queueApi() {
  const requests = [];
  const api = (action, payload, signal) => {
    const pending = deferred(); requests.push({ action, payload, signal, ...pending }); return pending.promise;
  };
  return { api, requests };
}

test('default timer adapter preserves receiver-sensitive global methods on start, poll and unmount cleanup', async () => {
  // Exercise the timer method's receiver contract, not a simulated DOM or renderer.
  const jobs = new Map();
  const context = vm.createContext({ AbortController, Date, timerJobs: jobs, nextTimer: 0 });
  vm.runInContext(`
    globalThis.setTimeout = function (callback, ms) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      const id = ++globalThis.nextTimer; globalThis.timerJobs.set(id, { callback, ms }); return id;
    };
    globalThis.clearTimeout = function (id) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      globalThis.timerJobs.delete(id);
    };
  `, context);
  const receiverCore = vm.runInContext(coreProgram, context);
  const expected = snapshot();
  const store = receiverCore.createController(async () => expected);
  assert.equal(await store.start(), true);
  assert.equal(store.getSnapshot().snapshot, expected);
  assert.equal(store.getSnapshot().initialLoading, false);
  assert.equal(store.getSnapshot().refreshing, false);
  assert.equal(jobs.size, 1, 'only the next status poll remains');
  assert.doesNotThrow(() => store.stop(), 'closing settings cannot throw from timer cleanup');
  assert.doesNotThrow(() => store.stop(), 'cleanup is idempotent');
  assert.equal(jobs.size, 0);
  assert.equal(await store.start(), true, 'reopening settings still loads status');
  store.stop();
});

test('browser artifact is a lazy factory with React as its only runtime import', async () => {
  let registration;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { registration = value; } } } });
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.equal(manifest.name, '@local/dsh-channel-bridge');
  assert.equal(registration.id, manifest.name, 'browser module identity follows the package name');
  assert.ok(patch.includes(`name: '${manifest.name}'`));
  assert.ok(patch.includes(`name: '${manifest.name}/session-policy'`));
  assert.equal(typeof registration.factory, 'function');
  const imports = [...source.matchAll(/\brequire\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
  assert.deepEqual(imports, ['react']);
  assert.doesNotMatch(source, /window\.confirm|dangerouslySetInnerHTML|createPortal|document\.body|localStorage|sessionStorage/);
  assert.doesNotMatch(source, /<iframe|<script|https?:\/\//);
  assert.match(source, /inject: \['slots', 'locale', 'uiWorkspace'\]/);
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-layout'));
});

test('opens bridge conversations using DSH workspace navigation for tool approvals', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'));
  assert.match(source, /ctx\.uiWorkspace\.openSession\(sessionId\)/);
  assert.match(source, /h\(ChannelSessions, \{ sessions: selected\.sessions \}\)/);
});

test('client contributes a single page after Automation tasks through the official navigation slots', () => {
  let registration;
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(value) { registration = value; } } } });
  const module = registration.factory(() => ({ createElement() {} }));
  const slots = new Map();
  module.apply({
    effect: effect => effect(),
    locale: { register() {}, bind: () => key => key },
    slots: {
      inject(name, register) {
        const before = slots.size;
        register();
        assert.equal(slots.size, before + 1);
        assert.equal(slots.get(name).name, name);
      },
      register(options, component) {
        slots.set(options.name, options);
        assert.equal(typeof component, 'function');
      },
    },
  });
  assert.deepEqual([...slots.keys()], ['main', 'sidebar.panellist']);
  assert.equal(slots.get('main').key, slots.get('sidebar.panellist').id);
  assert.equal(slots.get('sidebar.panellist').order, 20);
  assert.equal(slots.get('sidebar.panellist').label(), 'channels.title');
});

test('channel detail exposes a left-aligned parent button and a single channel heading', () => {
  assert.match(source, /h\('button', \{\s*type: 'button', className: 'wxb-crumb', 'aria-label': t\('channels.back'\),[\s\S]*?t\('channels.title'\)\)/);
  assert.match(source, /h\(ChannelDetailHeader, \{ id: 'weixin', title: t\('title'\), headingRef,/);
  assert.match(source, /h\(ChannelDetailHeader, \{ id: channel.id, title: channel.name, headingRef,/);
  assert.match(source, /h\('h1', \{ id: 'wxb-main-title', className: 'wxb-channel-heading', ref: headingRef, tabIndex: -1 \},/);
});

test('channel navigation focuses the detail heading and restores the selected row and list scroll', () => {
  assert.match(source, /page\.current\.scrollTop = 0;\s*detailHeading\.current\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /page\.current\.scrollTop = listScrollTop\.current;\s*rows\.current\.get\(lastSelected\.current\)\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /listScrollTop\.current = page\.current\?\.scrollTop \?\? 0;[\s\S]*?setSelectedId\(channel\.id\)/);
});

test('channel controller aborts its owner request and cancels every timer on unmount', async () => {
  const clock = fakeClock();
  const { api, requests } = queueApi();
  const store = core.createController(api, { clock });
  const start = store.start();
  store.stop();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(await start, false);
  assert.deepEqual(clock.jobs, []);
  requests[0].resolve({ channels: [] });
  await flush();
  assert.equal(store.getSnapshot().snapshot, null);
});

test('channel request sends write-only configuration and validates the status envelope', async () => {
  const channel = {
    id: 'telegram', name: 'Telegram', status: 'paused', configured: true, enabled: false,
    allowedSenders: ['123'], accountVerification: 'pending',
  };
  const api = core.createChannelApi(async (url, init) => {
    assert.equal(url, '/plugins/channel-bridge/api');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.headers['X-DSH-Channel-Bridge'], '1');
    assert.deepEqual(JSON.parse(init.body), { action: 'configure', id: 'telegram', config: { token: 'fake' } });
    return { ok: true, status: 200, json: async () => ({ ok: true, value: { channels: [channel] } }) };
  });
  const value = await api('configure', { id: 'telegram', config: { token: 'fake' } }, new AbortController().signal);
  assert.deepEqual(value.channels, [channel]);
  const malformed = core.createChannelApi(async () => ({
    ok: true, status: 200, json: async () => ({ ok: true, value: { channels: [{ ...channel, status: 'unknown' }] } }),
  }));
  await assert.rejects(malformed('status', {}, new AbortController().signal), error => error.bridgeKind === 'response');
});

test('catalog fields produce typed nested configuration and omit untouched defaults', () => {
  const fields = [
    { field: 'credentials.token', kind: 'secret', required: true },
    { field: 'replyInThread', kind: 'bool' },
    { field: 'options.tags', kind: 'list' },
    { field: 'port', kind: 'int' },
    { field: 'host', kind: 'string' },
  ];
  const config = core.parseChannelConfig(fields, {
    'credentials.token': 'fake', replyInThread: 'false', 'options.tags': 'alpha\nbeta', port: '1234',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(config)), {
    credentials: { token: 'fake' }, replyInThread: false, options: { tags: ['alpha', 'beta'] }, port: 1234,
  });
  assert.throws(() => core.parseChannelConfig(fields, { port: '1234' }), /required/);
  assert.throws(() => core.parseChannelConfig([{ field: '__proto__.polluted', kind: 'string' }], { '__proto__.polluted': 'x' }), /field/);
  assert.throws(() => core.parseChannelConfig(fields, { 'credentials.token': 'fake', port: '3.5' }), /number/);
});

test('locale resources and embedded runtime dictionaries remain identical', async () => {
  const en = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8'));
  const zh = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8'));
  const zhCN = JSON.parse(await readFile(new URL('../locale/zh-CN.json', import.meta.url), 'utf8'));
  const embedded = JSON.parse(source.match(/const MESSAGES = ([\s\S]+?);\n    \/\/ END LOCALE DATA/)[1]);
  assert.deepEqual(embedded.en, en.weixinBridge);
  assert.deepEqual(embedded.zh, zh.weixinBridge);
  assert.deepEqual(zhCN, zh);
  assert.deepEqual(Object.keys(en.weixinBridge).sort(), Object.keys(zh.weixinBridge).sort());
  assert.equal(en.meta.title, 'Channel bridge');
  assert.equal(zh.meta.title, '消息通道桥接');
  for (const dict of [en.weixinBridge, zh.weixinBridge]) {
    for (const match of source.matchAll(/\bt\('([^']+)'/g)) assert.equal(typeof dict[match[1]], 'string', match[1]);
    for (const prefix of ['steps.scan', 'steps.pair', 'steps.approve', 'steps.chat',
      ...['disconnected', 'connecting', 'connected', 'paused', 'auth-required', 'error'].map(value => `status.${value}`),
      ...['waiting', 'scanned', 'verify-code', 'expired', 'failed', 'succeeded'].map(value => `login.${value}`),
      ...['pending', 'approved', 'revoked'].map(value => `users.${value}`)]) assert.equal(typeof dict[prefix], 'string', prefix);
    for (const value of Object.values(dict)) assert.doesNotMatch(value, /[\u200b\ufeff]/);
  }
  for (const key of Object.keys(en.weixinBridge)) {
    const placeholders = value => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
    assert.deepEqual(placeholders(en.weixinBridge[key]), placeholders(zh.weixinBridge[key]), key);
  }
});

test('interface styling uses only inspected alias theme variables', () => {
  const css = source.match(/const CSS = `([\s\S]*?)`;/)[1];
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/i);
  const tokens = [...css.matchAll(/var\((--[^), ]+)/g)].map(match => match[1]);
  const inspected = new Set([
    '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary', '--dsw-alias-border-l2',
    '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
    '--dsw-alias-brand-primary', '--dsw-alias-state-error-primary', '--dsw-alias-state-idle-primary',
    '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary',
  ]);
  assert.ok(tokens.length > 20);
  for (const token of tokens) assert.ok(inspected.has(token), token);
  assert.match(css, /:focus-visible/);
  assert.match(css, /overflow-wrap:anywhere/);
  assert.match(css, /@media\(max-width:520px\)/);
  assert.match(css, /@media\(pointer:coarse\)/);
});

test('the plugin icon uses a bounded DSH-style tile and shares its glyph with the sidebar', async () => {
  const icon = await readFile(new URL('../icon.svg', import.meta.url), 'utf8');
  assert.match(icon, /width="36" height="36" viewBox="0 0 36 36"/);
  assert.match(icon, /<rect x="6" y="6" width="24" height="24" rx="6" fill="url\(#channel-tile\)"\/>/);
  assert.match(icon, /<linearGradient id="channel-tile"/);
  assert.doesNotMatch(icon, /<(?:script|style|image|foreignObject|text|animate)\b|\bon\w+=|href=/i);
  const stack = [];
  for (const tag of icon.matchAll(/<(\/?)([\w:-]+)\b[^>]*?(\/?)>/g)) {
    assert.ok(['svg', 'defs', 'linearGradient', 'stop', 'rect', 'g', 'path', 'circle'].includes(tag[2]));
    if (tag[1]) assert.equal(stack.pop(), tag[2]);
    else if (!tag[3]) stack.push(tag[2]);
  }
  assert.equal(stack.length, 0);
  const nav = source.slice(source.indexOf('function BridgeNavIcon'), source.indexOf('function LoginPanel'));
  assert.match(nav, /viewBox: '0 0 24 24'/);
  for (const [, glyph] of icon.matchAll(/<path d="([^"]*)"/g)) assert.ok(nav.includes(glyph));
});

test('every registered channel has a bundled icon used in both its list row and detail heading', async () => {
  const catalog = JSON.parse(await readFile(new URL('../transport/channels.json', import.meta.url), 'utf8'));
  const glyphs = source.match(/\/\/ BEGIN CHANNEL GLYPHS\n([\s\S]*?)\/\/ END CHANNEL GLYPHS/);
  assert.ok(glyphs);
  const definitions = vm.runInNewContext(`${glyphs[1]}\nCHANNEL_GLYPHS;`);
  assert.deepEqual(Object.keys(definitions).sort(), catalog.channels.map(({ id }) => id).sort());
  for (const { paths } of Object.values(definitions)) {
    assert.ok(paths.length > 0);
    for (const path of paths) {
      assert.match(path.d, /^[mM][mdzlhvcsqtae0-9\s.,+\-]+$/i);
      assert.ok(Object.keys(path).every(key => ['d', 'fill', 'stroke', 'strokeWidth', 'strokeLinecap', 'strokeLinejoin'].includes(key)));
    }
  }
  assert.match(source, /className: 'wxb-channel-label'[^\n]*h\(ChannelIcon, \{ id: channel\.id \}\)/);
  assert.match(source, /h\(ChannelIcon, \{ id, size: 24 \}\).*title/);
});

test('QR safety accepts only local raster data, and expiry is an exact boundary', () => {
  assert.equal(core.safeQrSource('data:image/png;base64,iVBORw0KGgo='), true);
  for (const value of ['https://secret.example/qr?token=x', 'data:image/svg+xml;base64,PHN2Zy8+',
    'javascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', '', null]) assert.equal(core.safeQrSource(value), false);
  const connected = snapshot({ login: { status: 'waiting', expiresAt: 5_000 } });
  assert.equal(core.liveLogin(connected, 4_999), true);
  assert.equal(core.liveLogin(connected, 5_000), false);
  assert.equal(core.liveLogin(snapshot({ login: { status: 'expired', expiresAt: 9_000 } }), 1_000), false);
  assert.equal(core.pairingBlock({ pairingStatus: 'sent', pairingExpiresAt: 5_000 }, 4_999), null);
  assert.equal(core.pairingBlock({ pairingStatus: 'sent', pairingExpiresAt: 5_000 }, 5_000), 'users.pairingExpired');
  assert.equal(core.pairingBlock({ pairingStatus: 'failed' }, 0), 'users.pairingFailed');
});

test('a new sign-in takes precedence over a retained account without hiding QR, verification, or cancel', () => {
  const account = { botId: 'previous-bot', userId: 'previous-owner' };
  for (const connectionStatus of ['connecting', 'auth-required', 'error']) {
    for (const status of ['waiting', 'scanned', 'verify-code']) {
      const value = snapshot({ account, connectionStatus, login: {
        id: 'new-attempt', status, expiresAt: 5_000, verificationFailed: false,
        qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      } });
      const view = core.deriveLoginView(value, 1_000, null);
      assert.equal(view.signedIn, false, `${connectionStatus}/${status} must not claim the old account completed sign-in`);
      assert.equal(view.showLogin, true);
      assert.equal(view.showQr, true);
      assert.equal(view.showCancel, true);
      assert.equal(view.showStart, true, 'rescan stays available');
      assert.equal(view.needsVerification, status === 'verify-code');
      const expired = core.deriveLoginView(value, 5_000, null);
      assert.equal(expired.expired, true);
      assert.equal(expired.signedIn, false, 'local expiry cannot make the previous account look newly signed in');
      assert.equal(expired.showQr, false);
      assert.equal(expired.showCancel, false);
      assert.equal(expired.showStart, true);
      assert.equal(expired.showLogin, true, 'expiry instructions remain visible');
    }
  }
  const succeeded = core.deriveLoginView(snapshot({ account, connectionStatus: 'connected', login: {
    id: 'completed', status: 'succeeded', expiresAt: 5_000, verificationFailed: false,
    qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  } }), 1_000, null);
  assert.equal(succeeded.signedIn, true);
  assert.equal(succeeded.showLogin, false);
  assert.equal(succeeded.showQr, false);
  assert.equal(succeeded.needsVerification, false);
  assert.equal(succeeded.showCancel, false);
  assert.equal(succeeded.showStart, false);
  assert.match(source, /deriveLoginView\(snapshot, now, brokenQr\)/, 'the actual panel consumes the tested derivation');
  assert.match(source, /showLogin \? h\('div', \{ className: 'wxb-qrrow' \}/);
  assert.match(source, /showCancel \? h\(ActionButton/);
});

test('transient login notices follow phase and expiry without changing retained error state', () => {
  const login = { id: 'attempt', status: 'waiting', expiresAt: 5_000, verificationFailed: false,
    qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
  for (const status of ['waiting', 'scanned', 'verify-code', 'expired', 'failed', 'succeeded']) {
    const value = snapshot({ login: { ...login, status } });
    assert.equal(core.deriveFeedback(value, 'notice.loginStarted', 1_000).notice,
      status === 'waiting' ? 'notice.loginStarted' : null, status);
    assert.equal(core.deriveFeedback(value, 'notice.loginVerified', 1_000).notice,
      ['waiting', 'scanned', 'verify-code'].includes(status) ? 'notice.loginVerified' : null, status);
  }
  const retainedError = Object.freeze({ key: 'errors.network', action: 'status' });
  const state = Object.freeze({ snapshot: Object.freeze(snapshot({ login })),
    notice: 'notice.loginStarted', actionError: retainedError, transportError: retainedError });
  assert.equal(core.deriveFeedback(state.snapshot, state.notice, 5_000).notice, null);
  assert.equal(state.notice, 'notice.loginStarted', 'the filter does not rewrite stored state');
  assert.equal(state.actionError, retainedError);
  assert.equal(state.transportError, retainedError);
  assert.equal(core.deriveFeedback(snapshot(), 'notice.loginStarted', 1_000).notice, null);
  assert.equal(core.deriveFeedback(snapshot(), 'notice.loginVerified', 1_000).notice, null);
  assert.equal(core.deriveFeedback(snapshot({ login: { ...login, verificationFailed: true } }), 'notice.loginVerified', 1_000).notice, null);
  assert.equal(core.deriveFeedback(snapshot(), 'notice.approved', 1_000).notice, 'notice.approved');
  assert.match(source, /const feedback = deriveFeedback\(snapshot, state\.notice, now\)/);
  assert.match(source, /feedback\.notice \? h\('div'/);
  assert.doesNotMatch(source, /state\.notice \? h\('div'/);
});

test('failed or unconfirmed replies have a prominent localized warning with no retry action', async () => {
  assert.equal(core.deriveFeedback(null, null, 0).failedReplies, 0);
  for (const count of [0, -1, '2', null]) {
    assert.equal(core.deriveFeedback(snapshot({ failedReplies: count }), null, 0).failedReplies, 0);
  }
  assert.equal(core.deriveFeedback(snapshot({ failedReplies: 3 }), null, 0).failedReplies, 3);
  const begin = source.indexOf("feedback.failedReplies > 0 ? h('div'");
  const end = source.indexOf('snapshot && snapshot.lastError ?', begin);
  assert.ok(begin >= 0 && end > begin);
  const warning = source.slice(begin, end);
  assert.match(warning, /role: 'alert'/);
  assert.match(warning, /'data-tone': 'warning'/);
  assert.match(warning, /replies\.failureTitle/);
  assert.match(warning, /replies\.failureNotice/);
  assert.doesNotMatch(warning, /ActionButton|onClick|store\.run|retry/i);
  const en = JSON.parse(await readFile(new URL('../locale/en.json', import.meta.url), 'utf8')).weixinBridge;
  const zh = JSON.parse(await readFile(new URL('../locale/zh.json', import.meta.url), 'utf8')).weixinBridge;
  assert.match(en['replies.failureNotice'], /unconfirmed[\s\S]*not automatically resent[\s\S]*history in DSH/);
  assert.match(zh['replies.failureNotice'], /未确认[\s\S]*未自动重发[\s\S]*DSH 查看会话历史/);
});

test('successful destructive actions route focus to a stable parent heading while cancellation restores the trigger', () => {
  const begin = source.indexOf('function ConfirmControl(');
  const end = source.indexOf('function SessionCopy(', begin);
  const confirm = source.slice(begin, end);
  assert.match(confirm, /function dismiss\(\) \{ restoreTriggerOnCancel\.current = true; setConfirming\(false\); \}/);
  assert.match(confirm, /else if \(restoreTriggerOnCancel\.current\) \{[\s\S]*trigger\.current\?\.focus\(\)/);
  assert.match(confirm, /if \(await store\.run\(action, payload, busyKey\)\) \{[\s\S]*restoreTriggerOnCancel\.current = false;[\s\S]*onConfirmed\?\.\(\);/);
  assert.doesNotMatch(confirm, /setTimeout|document\./);
  assert.match(source, /setConfirmationFocusRequest\(request => request \+ 1\)/);
  assert.match(source, /if \(confirmationFocusRequest > 0\) usersHeadingRef\.current\?\.focus\(\);[\s\S]*\}, \[confirmationFocusRequest\]\)/);
  assert.match(source, /id: 'wxb-users-title', ref: usersHeadingRef, tabIndex: -1/);
  assert.equal([...source.matchAll(/onConfirmed: focusUsersAfterConfirmation/g)].length, 2, 'disconnect and user revoke share the stable parent callback');
  assert.match(source, /user\.status === 'approved' \? h\(ConfirmControl, \{ t, state, store, reason, onConfirmed,/);
  assert.match(source, /\.wxb-focus-target:focus-visible/);
});

test('API sends the same-origin JSON contract and validates successful snapshots', async () => {
  let request;
  const expected = snapshot();
  const api = core.createApi(async (url, init) => {
    request = { url, init }; return { ok: true, status: 200, json: async () => ({ ok: true, value: expected }) };
  });
  const signal = new AbortController().signal;
  assert.equal(await api('user.approve', { userId: 'person', code: '12345678' }, signal), expected);
  assert.equal(request.url, '/plugins/weixin-bridge/api');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.credentials, 'same-origin');
  assert.equal(request.init.headers['Content-Type'], 'application/json');
  assert.equal(request.init.headers['X-DSH-Weixin-Bridge'], '1');
  assert.equal(request.init.signal, signal);
  assert.deepEqual(JSON.parse(request.init.body), { action: 'user.approve', userId: 'person', code: '12345678' });
  assert.equal(core.validSnapshot(expected), true);
  assert.equal(core.validSnapshot({ ...expected, version: 'other' }), false);
  assert.equal(core.validSnapshot({ ...expected, users: [null] }), false);
  assert.equal(core.validSnapshot({ ...expected, pendingReplies: -1 }), false);
});

test('API parses errors even on non-2xx responses and never exposes raw messages', async () => {
  for (const [status, code, expected] of [
    [401, 'UNAUTHORIZED', 'errors.unauthorized'], [403, 'FORBIDDEN', 'errors.forbidden'],
    [400, 'PAIRING_CODE_INVALID', 'errors.invalidPairing'], [400, 'PAIRING_CODE_EXPIRED', 'errors.pairingExpired'],
    [409, 'ALREADY_APPROVED', 'errors.approvalConflict'], [400, 'LOGIN_EXPIRED', 'errors.loginExpired'],
    [400, 'MODEL_UNAVAILABLE', 'errors.model'], [429, '', 'errors.rateLimited'], [503, 'INTERNAL_ERROR', 'errors.server'],
  ]) {
    let parsed = false;
    const api = core.createApi(async () => ({ ok: false, status, json: async () => {
      parsed = true; return { ok: false, error: { code, message: 'token=SECRET https://secret.example/qr?secret=PRIVATE' } };
    } }));
    await assert.rejects(api('status', {}, new AbortController().signal), error => {
      assert.equal(core.errorKey(error), expected);
      assert.doesNotMatch(error.message, /SECRET|PRIVATE|https/);
      return true;
    });
    assert.equal(parsed, true);
  }
  const malformed = core.createApi(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }));
  await assert.rejects(malformed('status', {}, new AbortController().signal), error => core.errorKey(error) === 'errors.invalidResponse');
  const html403 = core.createApi(async () => ({ ok: false, status: 403, json: async () => { throw new Error('html'); } }));
  await assert.rejects(html403('status', {}, new AbortController().signal), error => core.errorKey(error) === 'errors.forbidden');
  const offline = core.createApi(async () => { throw new TypeError('secret network detail'); });
  await assert.rejects(offline('status', {}, new AbortController().signal), error => core.errorKey(error) === 'errors.network');
});

test('polling is sequential, actions abort older polls, and late snapshots cannot overwrite actions', async () => {
  const clock = fakeClock();
  const { api, requests } = queueApi();
  const controller = core.createController(api, { clock });
  try {
    controller.start();
    assert.equal(requests.length, 1);
    assert.equal(await controller.refresh(), false);
    requests[0].resolve(snapshot()); await flush();
    assert.equal(clock.jobs.length, 1);
    assert.equal(clock.jobs[0].delay, 3_000);
    clock.next();
    assert.equal(requests.length, 2);
    const action = controller.run('login.start', {});
    assert.equal(requests[1].signal.aborted, true);
    assert.equal(requests.length, 3);
    assert.equal(await controller.run('connection.resume', {}), false);
    const newest = snapshot({ connectionStatus: 'connecting', login: {
      id: 'fresh-login', status: 'waiting', expiresAt: clock.now() + 10_000,
      qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=', verificationFailed: false,
    } });
    requests[2].resolve(newest);
    assert.equal(await action, true);
    requests[1].resolve(snapshot({ workspaceDir: '/stale' })); await flush();
    assert.equal(controller.getSnapshot().snapshot, newest);
    assert.equal(controller.getSnapshot().notice, 'notice.loginStarted');
    assert.equal(clock.jobs.length, 1);
    assert.equal(clock.jobs[0].delay, 2_000);
  } finally { controller.stop(); }
  assert.equal(clock.jobs.length, 0);
});

test('uncertain operations require a fresh status before another mutation', async () => {
  const clock = fakeClock(); const { api, requests } = queueApi();
  const controller = core.createController(api, { clock });
  try {
    controller.start(); requests[0].resolve(snapshot()); await flush();
    const operation = controller.run('login.start', {});
    requests[1].reject(core.bridgeError('network')); assert.equal(await operation, false);
    assert.equal(controller.getSnapshot().uncertain, true);
    assert.equal(await controller.run('login.start', {}), false);
    assert.equal(requests.length, 2);
    const refresh = controller.refresh(); requests[2].resolve(snapshot()); await refresh;
    assert.equal(controller.getSnapshot().uncertain, false);
    assert.equal(controller.getSnapshot().actionError.key, 'errors.network', 'action failure remains readable through polling');
  } finally { controller.stop(); }
});

test('an offline-aborted mutation stays uncertain even after an immediate reconnect', async () => {
  const clock = fakeClock(); const { api, requests } = queueApi();
  const controller = core.createController(api, { clock });
  try {
    controller.start(); requests[0].resolve(snapshot()); await flush();
    const operation = controller.run('login.start', {});
    controller.setOnline(false);
    assert.equal(requests[1].signal.aborted, true);
    controller.setOnline(true);
    requests[1].reject(new Error('AbortError'));
    assert.equal(await operation, false);
    assert.equal(controller.getSnapshot().uncertain, true);
    assert.equal(controller.getSnapshot().actionError.key, 'errors.network');
    assert.equal(await controller.run('login.start', {}), false);
    const refresh = controller.refresh(); requests[2].resolve(snapshot()); await refresh;
    assert.equal(controller.getSnapshot().uncertain, false);
  } finally { controller.stop(); }
});

test('permission errors disable mutations but allow status recovery', async () => {
  const clock = fakeClock(); const { api, requests } = queueApi();
  const controller = core.createController(api, { clock });
  try {
    controller.start(); requests[0].reject(core.bridgeError('host', 403, 'FORBIDDEN')); await flush();
    assert.equal(controller.getSnapshot().permission, 'errors.forbidden');
    assert.equal(controller.getSnapshot().initialLoading, false);
    assert.equal(await controller.run('login.start', {}), false);
    const refresh = controller.refresh(); requests[1].resolve(snapshot()); await refresh;
    assert.equal(controller.getSnapshot().permission, null);
    assert.equal(controller.getSnapshot().transportError, null);
  } finally { controller.stop(); }
});

test('offline recovery, unmount aborts, and stopped requests leave no timers or late updates', async () => {
  const clock = fakeClock(); const { api, requests } = queueApi();
  const controller = core.createController(api, { clock, online: false });
  controller.start(); assert.equal(requests.length, 0);
  controller.setOnline(true); assert.equal(requests.length, 1);
  controller.stop();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(clock.jobs.length, 0);
  requests[0].resolve(snapshot()); await flush();
  assert.equal(controller.getSnapshot().snapshot, null);
  assert.equal(clock.jobs.length, 0);
  controller.start(); assert.equal(requests.length, 2, 'effect restart is safe under React Strict Mode');
  controller.stop(); requests[1].resolve(snapshot()); await flush();
  assert.equal(controller.getSnapshot().snapshot, null);
});

test('a transport ignoring abort cannot leave status loading forever or hold settings cleanup open', async () => {
  const clock = fakeClock();
  const store = core.createController(() => new Promise(() => {}), { clock });
  const loading = store.start();
  assert.equal(store.getSnapshot().refreshing, true);
  clock.next();
  assert.equal(await loading, false);
  assert.equal(store.getSnapshot().initialLoading, false);
  assert.equal(store.getSnapshot().refreshing, false);
  assert.equal(store.getSnapshot().transportError.key, 'errors.timeout');
  assert.equal(clock.jobs.length, 1);
  assert.doesNotThrow(() => store.stop());
  assert.equal(clock.jobs.length, 0);
});

test('request timeouts report a recoverable error and clean up on disposal', async () => {
  const clock = fakeClock();
  const api = (_action, _payload, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const controller = core.createController(api, { clock });
  try {
    controller.start(); assert.equal(clock.jobs[0].delay, 15_000);
    clock.next(); await flush();
    assert.equal(controller.getSnapshot().transportError.key, 'errors.timeout');
    assert.equal(controller.getSnapshot().refreshing, false);
    assert.equal(clock.jobs.length, 1, 'only the next status check remains');
  } finally { controller.stop(); }
  assert.equal(clock.jobs.length, 0);
});
