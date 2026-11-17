import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelTools, parseChannelPreferences } from '../lib/channel-tools.js';

const sessionId = `dshbridge-${'1'.repeat(32)}`;
const agent = { id: sessionId, session: { header: {} } };
const call = name => ({ name, agent, signal: new AbortController().signal, token: {} });

test('requires a currently authorized turn, an exact tool grant, and DSH one-shot approval', async () => {
  let current = { active: ['inbound'], contaminated: false };
  let allowedTools = ['web_search'];
  const guard = new ChannelTools({ stateOf: () => current });
  const web = call('web_search');
  const manage = call('weixin_bridge');
  const approved = async request => {
    assert.equal(request.agent, agent);
    assert.equal(request.toolName, 'web_search');
    return 'allowed-once';
  };
  assert.ok(guard.denial(web));
  const release = guard.bind(agent, {
    messageId: 'inbound', signal: web.signal, getPolicy: () => ({ allowedTools }),
  });
  assert.ok(guard.denial(web));
  assert.equal((await guard.prepare(manage, approved, async () => ({ kind: 'allow' }))).kind, 'deny');
  assert.equal((await guard.prepare(web, approved, async () => ({ kind: 'allow' }))).kind, 'allow');
  assert.equal(guard.denial(web), undefined);
  assert.ok(guard.denial(call('web_search')));
  current = { ...current, active: ['inbound', 'local input'] };
  assert.ok(guard.denial(web));
  current = { active: ['inbound'], contaminated: false };
  allowedTools = [];
  assert.ok(guard.denial(web));
  release();
  allowedTools = ['web_search'];
  assert.ok(guard.denial(web));
});

test('a child Agent cannot escape its parent channel policy and a regular local Agent is unaffected', async () => {
  const guard = new ChannelTools({ stateOf: () => ({ active: ['inbound'] }) });
  const exec = call('write');
  exec.agent = { id: 'child', session: { header: { origin: 'subagent', parentSession: sessionId } } };
  assert.ok(guard.denial(exec));
  assert.equal(guard.denial({ ...exec, agent: { id: 'local', session: { header: {} } } }), undefined);
});

test('channel preferences support partial updates, strict tool names, and no wildcard', () => {
  const initial = parseChannelPreferences({ allowedTools: ['web_search', 'web_search'], streaming: true });
  assert.deepEqual(initial, { allowedTools: ['web_search'], streaming: true });
  assert.deepEqual(parseChannelPreferences({ sendProgress: true }, initial), { ...initial, sendProgress: true });
  assert.throws(() => parseChannelPreferences({ allowedTools: ['*'] }), { code: 'INVALID_REQUEST' });
  assert.throws(() => parseChannelPreferences({ allowedTools: ['weixin_bridge'] }), { code: 'INVALID_REQUEST' });
  assert.throws(() => parseChannelPreferences({ allowedTools: ['bash'] }), { code: 'INVALID_REQUEST' });
});
