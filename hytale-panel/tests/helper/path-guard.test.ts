import { afterEach, describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'path';
import { guardPath } from '../../packages/helper/src/utils/path-guard';

// Simplified path guard for testing
function guardPathSync(filePath: string, allowedBase: string): string {
  const resolved = path.resolve(filePath);
  const normalizedBase = path.resolve(allowedBase);
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error(`Path traversal blocked: ${filePath} is outside ${allowedBase}`);
  }
  return resolved;
}

describe('Path Guard', () => {
  const base = '/opt/hytale-backups';

  it('should allow paths within the base directory', () => {
    expect(guardPathSync('/opt/hytale-backups/backup.tar.gz', base)).toBe('/opt/hytale-backups/backup.tar.gz');
    expect(guardPathSync('/opt/hytale-backups/subdir/file.tar.gz', base)).toBe('/opt/hytale-backups/subdir/file.tar.gz');
  });

  it('should allow the base directory itself', () => {
    expect(guardPathSync('/opt/hytale-backups', base)).toBe('/opt/hytale-backups');
  });

  it('should block path traversal with ..', () => {
    expect(() => guardPathSync('/opt/hytale-backups/../etc/passwd', base)).toThrow('Path traversal blocked');
    expect(() => guardPathSync('/opt/hytale-backups/../../root/.ssh/id_rsa', base)).toThrow('Path traversal blocked');
  });

  it('should block absolute paths outside base', () => {
    expect(() => guardPathSync('/etc/passwd', base)).toThrow('Path traversal blocked');
    expect(() => guardPathSync('/tmp/evil', base)).toThrow('Path traversal blocked');
    expect(() => guardPathSync('/opt/hytale/Server/config.json', base)).toThrow('Path traversal blocked');
  });

  it('should block paths that start with base but are different directories', () => {
    expect(() => guardPathSync('/opt/hytale-backups-evil/file', base)).toThrow('Path traversal blocked');
  });
});

describe('Async Path Guard', () => {
  let root = '';

  afterEach(async () => {
    if (root) {
      await rm(root, { recursive: true, force: true });
      root = '';
    }
  });

  it('blocks writes through a symlinked parent directory', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hytale-path-guard-'));
    const allowedBase = path.join(root, 'base');
    const outside = path.join(root, 'outside');
    await mkdir(allowedBase, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(allowedBase, 'link'));

    await expect(guardPath(path.join(allowedBase, 'link', 'new.jar'), allowedBase))
      .rejects.toThrow('Parent symlink traversal blocked');
  });

  it('blocks a managed base directory that has been replaced by a symlink', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hytale-path-guard-'));
    const allowedBase = path.join(root, 'base');
    const outside = path.join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await symlink(outside, allowedBase);

    await expect(guardPath(path.join(allowedBase, 'new.jar'), allowedBase))
      .rejects.toThrow('Base symlink traversal blocked');
  });
});
