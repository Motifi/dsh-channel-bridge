import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the new bundle leaves the legacy WeChat bundle removable and retains its session preset', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  // DSH 0.2.2-rc.3 tests the loader ID and module name of each bundle row during uninstall.
  assert.doesNotMatch(patch, /^    - id: preset-weixin-bridge-chat\n      name: '@deepseek-ai\/dsh-agent-preset'$/m);
  assert.match(patch, /^    - id: preset-dsh-channel-bridge-weixin-chat\n      name: '@deepseek-ai\/dsh-agent-preset'\n      config:\n        id: weixin-bridge-chat$/m);
});
