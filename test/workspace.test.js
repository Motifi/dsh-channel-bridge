import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, lstat, writeFile, symlink } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveWeixinWorkspace, resolveWorkspaceDir } from '../lib/workspace.js';

async function ownedDirectory(t) {
  const parent = await realpath(tmpdir());
  const prefix = 'dsh-weixin-workspace-test-';
  const root = await mkdtemp(join(parent, prefix));
  t.after(async () => {
    // Delete only the checked, uniquely owned test directory, never user paths.
    assert.equal(dirname(root), parent);
    assert.ok(basename(root).startsWith(prefix));
    assert.equal(await realpath(root), root);
    assert.equal((await lstat(root)).isSymbolicLink(), false);
    await rm(root, { recursive: true });
  });
  return root;
}

test('portable default creates and reuses a private directory inside the DSH default directory', async t => {
  const root = await ownedDirectory(t);
  const expected = join(root, 'weixin-workspace');
  assert.equal(await resolveWorkspaceDir(undefined, root), expected);
  assert.equal(await resolveWorkspaceDir(undefined, root), expected);
  assert.equal((await lstat(expected)).isDirectory(), true);
  if (process.platform !== 'win32') assert.equal((await lstat(expected)).mode & 0o777, 0o700);
});

test('an explicitly configured existing directory preserves the original path contract', async t => {
  const root = await ownedDirectory(t);
  const explicit = join(root, 'existing');
  await mkdir(explicit);
  assert.equal(await resolveWorkspaceDir(explicit, undefined), explicit);
});

test('invalid explicit configuration fails before any directory is created', async () => {
  for (const value of [null, 42, '', ' ', 'relative/workspace', '/bad\0path']) {
    await assert.rejects(resolveWorkspaceDir(value, undefined), /absolute directory/);
  }
});

test('an explicit missing path is not created automatically', async t => {
  const root = await ownedDirectory(t);
  const missing = join(root, 'missing');
  await assert.rejects(resolveWorkspaceDir(missing, root), { code: 'ENOENT' });
  await assert.rejects(lstat(missing), { code: 'ENOENT' });
});

test('a file cannot masquerade as the default conversation directory', async t => {
  const root = await ownedDirectory(t);
  await writeFile(join(root, 'weixin-workspace'), 'not a directory');
  await assert.rejects(resolveWorkspaceDir(undefined, root), /must be a directory/);
});

test('an existing symlink cannot redirect automatic workspace creation', { skip: process.platform === 'win32' }, async t => {
  const root = await ownedDirectory(t);
  const redirected = join(root, 'redirected');
  await mkdir(redirected);
  await symlink(redirected, join(root, 'weixin-workspace'));
  await assert.rejects(resolveWorkspaceDir(undefined, root), /symbolic link/);
});

test('an invalid DSH fallback is rejected without using the process working directory', async () => {
  for (const fallback of [undefined, null, 42, '', 'relative/path', '/bad\0path']) {
    await assert.rejects(resolveWorkspaceDir(undefined, fallback), /absolute default directory/);
  }
});

test('uses the persisted workspace of an approved legacy WeChat session when the desktop default changed', async t => {
  const root = await ownedDirectory(t);
  const previous = join(root, 'original-weixin-workspace');
  await mkdir(previous);
  const id = `wxbridge-${'a'.repeat(32)}`;
  assert.equal(await resolveWeixinWorkspace(undefined, root, {
    state: { users: [{ status: 'approved', sessionId: id }] },
    sessionPersistence: { async stat(sessionId) {
      assert.equal(sessionId, id);
      return { header: { id, cwd: previous, agentPreset: 'weixin-bridge-chat' } };
    } },
  }), previous);
  await assert.rejects(lstat(join(root, 'weixin-workspace')), { code: 'ENOENT' });
});

test('legacy workspace inference ignores revoked identities and sessions outside the bridge preset', async t => {
  const root = await ownedDirectory(t);
  const id = `wxbridge-${'b'.repeat(32)}`;
  let lookups = 0;
  assert.equal(await resolveWeixinWorkspace(undefined, root, {
    state: { users: [{ status: 'revoked', sessionId: id }, { status: 'approved', sessionId: id }] },
    sessionPersistence: { async stat() { lookups++; return { header: { id, cwd: root, agentPreset: 'standard' } }; } },
  }), join(root, 'weixin-workspace'));
  assert.equal(lookups, 1);
});
