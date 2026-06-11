import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function nonEmptyEnv(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function realpathIfPossible(targetPath) {
  try {
    return realpathSync.native(targetPath);
  } catch {
    return targetPath;
  }
}

function isInsidePath(targetPath, parentPath) {
  const relative = path.relative(parentPath, targetPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function viteCacheDirForRepo(repoRoot, env = process.env) {
  const resolvedRepoRoot = path.resolve(repoRoot);

  const override = nonEmptyEnv(env.CT_VITE_CACHE_DIR);
  if (override) {
    return path.resolve(resolvedRepoRoot, override);
  }

  const repoRootKey = realpathIfPossible(resolvedRepoRoot);
  const repoHash = createHash('sha256').update(repoRootKey).digest('hex').slice(0, 16);
  const xdgCacheHome = nonEmptyEnv(env.XDG_CACHE_HOME);
  const defaultBase = xdgCacheHome
    ? path.join(path.resolve(xdgCacheHome), 'clawkie-talkie', 'vite')
    : path.join(tmpdir(), 'clawkie-talkie-vite');
  const defaultCacheDir = path.join(defaultBase, repoHash);

  if (isInsidePath(defaultCacheDir, resolvedRepoRoot)) {
    return path.join(tmpdir(), 'clawkie-talkie-vite', repoHash);
  }

  return defaultCacheDir;
}
