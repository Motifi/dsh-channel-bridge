import assert from 'node:assert/strict';
import test from 'node:test';
import { ChannelTurns } from '../lib/channel-tools.js';
import { channelAccounts, channelPreferences } from '../lib/channel-storage.js';

const sessionId = `dshbridge-${'1'.repeat(32)}`;
const agent = { id: sessionId, session: { header: {} } };

test('saved grants are ignored while saved reply options can still be updated', async () => {
  const key = 'dsh-channel-bridge/preferences-weixin';
  let saved = { kind: 'grant', payload: { allowedTools: ['web_search'], streaming: true } };
  const preferences = channelPreferences({
    async readRecord(address) { assert.equal(address, key); return saved; },
    async modifyRecord(address, update) { assert.equal(address, key); saved = await update(saved); return saved; },
  });
  assert.deepEqual(await preferences.get('weixin'), { streaming: true });
  assert.deepEqual(await preferences.update('weixin', { sendProgress: true }), { streaming: true, sendProgress: true });
  assert.deepEqual(saved.payload, { streaming: true, sendProgress: true });
  await assert.rejects(preferences.update('weixin', { allowedTools: ['web_search'] }), { code: 'INVALID_REQUEST' });
});

test('channel IDs with underscores use valid DSH credential keys for accounts and reply settings', async () => {
  const records = new Map();
  const credentials = {
    async readRecord(key) { return records.get(key); },
    async modifyRecord(key, update) {
      const record = await update(records.get(key));
      records.set(key, record);
      return record;
    },
    async deleteRecord(key) { records.delete(key); },
  };
  const accounts = channelAccounts(credentials);
  const preferences = channelPreferences(credentials);
  const account = { generation: 'd0269e2f-9f03-43a7-baf4-5084cfec4fb2', enabled: false, config: {}, allowedSenders: [] };
  await accounts.set('whatsapp_agent', account);
  await preferences.update('whatsapp_agent', { streaming: false });
  assert.deepEqual([...records.keys()], ['dsh-channel-bridge/whatsapp-agent', 'dsh-channel-bridge/preferences-whatsapp-agent']);
  assert.deepEqual(await accounts.get('whatsapp_agent'), account);
  assert.deepEqual(await preferences.get('whatsapp_agent'), { streaming: false });
  await accounts.delete('whatsapp_agent');
  assert.deepEqual([...records.keys()], ['dsh-channel-bridge/preferences-whatsapp-agent']);
});

test('channel sending is scoped to the Agent, active inbound message and cancellation', () => {
  const controller = new AbortController();
  let current = { active: [], contaminated: false };
  const turns = new ChannelTurns({ stateOf: () => current });
  const inbound = { messageId: 'inbound', signal: controller.signal };
  const release = turns.bind(agent, inbound);
  assert.equal(turns.bound(agent), inbound);
  assert.equal(turns.active(agent), undefined);
  current = { ...current, active: ['inbound'] };
  assert.equal(turns.active(agent), inbound);
  assert.equal(turns.active({ ...agent }), undefined);
  current = { ...current, active: ['inbound', 'local input'] };
  assert.equal(turns.active(agent), undefined);
  current = { active: ['inbound'], contaminated: false };
  controller.abort();
  assert.equal(turns.bound(agent), undefined);
  assert.equal(turns.active(agent), undefined);
  release();
  assert.equal(turns.active(agent), undefined);
});

test('only local agents and subagents with verified local ancestry can manage the bridge', () => {
  const child = { id: 'child', session: { header: { origin: 'subagent', parentSession: sessionId } } };
  const grandchild = { id: 'grandchild', session: { header: { origin: 'subagent', parentSession: child.id } } };
  const turns = new ChannelTurns({ findAgent: id => id === child.id ? child : undefined });
  assert.equal(turns.canManageBridge(agent), false);
  assert.equal(turns.canManageBridge(child), false);
  assert.equal(turns.canManageBridge(grandchild), false);
  assert.equal(turns.canManageBridge({ id: 'local', session: { header: {} } }), true);
  assert.equal(new ChannelTurns({ findAgent: () => undefined }).canManageBridge(grandchild), false);
});
