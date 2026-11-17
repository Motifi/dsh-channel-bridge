import { isAbsolute, join } from 'node:path';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { PRESET_ID, SESSION_PATTERN } from './state.js';

/** Keep an approved legacy session on its recorded DSH working directory. */
export async function resolveWeixinWorkspace(configured, defaultDirectory, { state, sessionPersistence }) {
  if (configured === undefined) {
    const user = state?.users.find(entry => entry.status === 'approved' && SESSION_PATTERN.test(entry.sessionId));
    if (user) {
      const stored = await sessionPersistence.stat(user.sessionId);
      const header = stored?.header;
      if (header?.id === user.sessionId && header.agentPreset === PRESET_ID) {
        try { return await resolveWorkspaceDir(header.cwd, defaultDirectory); }
        catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        }
      }
    }
  }
  return resolveWorkspaceDir(configured, defaultDirectory);
}

/** Use DSH's configured directory rather than a developer's hard-coded home path. */
export async function resolveWorkspaceDir(configured, defaultDirectory, directoryName = 'weixin-workspace') {
  if (configured !== undefined && (typeof configured !== 'string' || !configured.trim()
    || !isAbsolute(configured) || configured.includes('\0'))) {
    throw new Error('WeChat workspaceDir must be an absolute directory.');
  }
  if (configured !== undefined) {
    const canonical = await realpath(configured);
    if (!(await stat(canonical)).isDirectory()) throw new Error('WeChat workspaceDir must name an existing directory.');
    return canonical;
  }
  if (typeof defaultDirectory !== 'string' || !isAbsolute(defaultDirectory) || defaultDirectory.includes('\0')) {
    throw new Error('DSH must supply an absolute default directory for WeChat conversations.');
  }
  const base = await realpath(defaultDirectory);
  if (!(await stat(base)).isDirectory()) throw new Error('DSH default directory is not a directory.');
  const target = join(base, directoryName);
  try { await mkdir(target, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('The default WeChat workspace must be a directory, not a file or symbolic link.');
  }
  return realpath(target);
}
