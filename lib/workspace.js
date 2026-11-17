import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises';
import { BridgeError, PRESET_ID, SESSION_PATTERN } from './state.js';

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

export async function readChannelFile(directory, path, bytesLimit) {
  const invalid = () => new BridgeError('INVALID_REQUEST', '只能发送此隔离会话工作区中的文件，附件合计最多 1 MiB。');
  if (typeof path !== 'string' || !path || path.includes('\0')) throw invalid();
  const root = await realpath(directory);
  let target;
  try { target = await realpath(resolve(root, path)); } catch { throw invalid(); }
  const inside = relative(root, target);
  const name = basename(path);
  if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)
    || !name || name.length > 160 || /[\\/\u0000-\u001f\u007f]/.test(name)) throw invalid();
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const entry = await file.stat();
    if (!entry.isFile() || !entry.size || entry.size > bytesLimit || entry.nlink !== 1) throw invalid();
    const buffer = Buffer.alloc(entry.size + 1);
    const { bytesRead } = await file.read(buffer, { offset: 0, length: buffer.length, position: 0 });
    if (bytesRead !== entry.size) throw invalid();
    const mime = new Map([['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'],
      ['webp', 'image/webp'], ['mp4', 'video/mp4'], ['mp3', 'audio/mpeg'], ['wav', 'audio/wav'], ['txt', 'text/plain'],
      ['ogg', 'audio/ogg'], ['pdf', 'application/pdf'], ['json', 'application/json']]).get(name.split('.').at(-1).toLowerCase())
      ?? 'application/octet-stream';
    return { name, mime, data: buffer.subarray(0, bytesRead).toString('base64') };
  } finally { await file.close(); }
}

function insideWorkspace(root, path) {
  const segment = relative(root, path);
  return !isAbsolute(segment) && segment !== '..' && !segment.startsWith(`..${sep}`);
}

export async function channelToolPaths(root, cwd, { name, arguments: args }) {
  if (args?.sandbox_permissions === 'danger-full-access' || args?.run_in_background === true) return false;
  let paths;
  if (['read', 'write', 'edit', 'read_image'].includes(name)) {
    paths = [args?.file_path];
  } else if (name === 'str_replace_editor') {
    paths = [args?.path];
  } else if (name === 'apply_patch') {
    paths = [...String(args?.input ?? '').matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)]
      .map(match => match[1].trim());
    if (!paths.length) return false;
  } else if (['glob', 'grep'].includes(name)) {
    paths = [args?.path ?? cwd];
  } else if (name === 'subagent') {
    if (args?.agent_preset !== undefined) return false;
    paths = [args?.cwd ?? cwd];
  } else return true;
  for (const path of paths) {
    if (typeof path !== 'string' || !path || path !== path.trim() || path.startsWith('~') || path.includes('\0')) return false;
    let target = resolve(cwd, path);
    if (!insideWorkspace(root, target)) return false;
    while (true) {
      try {
        if (!insideWorkspace(root, await realpath(target))) return false;
        break;
      } catch (error) {
        if (error.code !== 'ENOENT' || target === root) return false;
        // A rejected dangling symlink must not become a writable ancestor.
        try { if ((await lstat(target)).isSymbolicLink()) return false; }
        catch (missing) { if (missing.code !== 'ENOENT') return false; }
        target = resolve(target, '..');
      }
    }
  }
  return true;
}
