import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['index.js', 'client.js', 'session-policy.js', 'scripts/check.mjs'];
for (const directory of ['lib', 'test']) {
  for (const name of await readdir(join(root, directory))) {
    if (/\.(?:js|mjs)$/.test(name)) files.push(`${directory}/${name}`);
  }
}
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Syntax checks passed: ${files.length} JavaScript files.`);
