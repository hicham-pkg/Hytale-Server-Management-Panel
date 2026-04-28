import * as path from 'path';
import * as fs from 'fs/promises';

/**
 * Resolve a path and verify it stays within the allowed base directory.
 * Rejects symlinks to prevent symlink-based traversal.
 */
export async function guardPath(filePath: string, allowedBase: string): Promise<string> {
  const resolved = path.resolve(filePath);
  const normalizedBase = path.resolve(allowedBase);

  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error(`Path traversal blocked: ${filePath} is outside ${allowedBase}`);
  }

  const baseStat = await fs.lstat(normalizedBase).catch((err: unknown) => {
    const e = err as { code?: string };
    if (e.code === 'ENOENT') {
      return null;
    }
    throw err;
  });
  if (baseStat?.isSymbolicLink()) {
    throw new Error(`Base symlink traversal blocked: ${allowedBase}`);
  }

  const realBase = baseStat ? await fs.realpath(normalizedBase) : normalizedBase;

  try {
    const real = await fs.realpath(resolved);
    if (!real.startsWith(realBase + path.sep) && real !== realBase) {
      throw new Error(`Symlink traversal blocked: ${filePath} resolves outside ${allowedBase}`);
    }
    return real;
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === 'ENOENT') {
      // File doesn't exist yet — check parent directory
      const parentDir = path.dirname(resolved);
      try {
        const realParent = await fs.realpath(parentDir);
        if (!realParent.startsWith(realBase + path.sep) && realParent !== realBase) {
          throw new Error(`Parent symlink traversal blocked: ${filePath}`);
        }
      } catch (parentErr: unknown) {
        const parentNodeErr = parentErr as { code?: string };
        if (parentNodeErr.code !== 'ENOENT') {
          throw parentErr;
        }
        // Parent doesn't exist either — only allow if resolved path is within base.
      }
      return resolved;
    }
    throw err;
  }
}

/**
 * Verify a path is a regular file (not a symlink, directory, etc.)
 */
export async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
