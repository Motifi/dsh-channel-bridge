import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the bundle keeps its bridge loader identity and relies on the host presets', async () => {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  // DSH uses the loader ID and module name to match bundle ownership during uninstall.
  assert.match(patch, /^    - id: weixin-bridge\n      name: '@local\/dsh-channel-bridge'$/m);
  assert.doesNotMatch(patch, /dsh-agent-preset|session-policy/);
});
