import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isSafeBackupFilename } from '@hytale-panel/shared';

/**
 * Helper-side coverage for the backup delete bug fix.
 *
 *  1. The shared `isSafeBackupFilename` validator that the helper now uses
 *     at the trust boundary. Static lint over a representative reject list.
 *  2. The actual `deleteBackup` handler against a tmp directory: it must
 *     reject path-traversal targets, refuse to escape the configured
 *     backup root, and report ENOENT cleanly.
 */

describe('isSafeBackupFilename', () => {
  it.each([
    '2026-04-25T18-30-00-000Z.tar.gz',
    '2026-04-25T18-30-00-000Z-mylabel.tar.gz',
    'world_snapshot.tar.gz',
    'a.tar.gz',
  ])('accepts %s', (name) => {
    expect(isSafeBackupFilename(name)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['notabackup.zip', 'wrong extension'],
    ['no-extension', 'no extension'],
    ['../../etc/passwd', 'parent traversal'],
    ['/tmp/x.tar.gz', 'absolute path'],
    ['.hidden.tar.gz', 'leading dot'],
    ['..tar.gz', 'leading double-dot'],
    ['foo..bar.tar.gz', 'embedded ..'],
    ['backup/evil.tar.gz', 'forward slash'],
    ['backup\\evil.tar.gz', 'backslash'],
    ['x .tar.gz', 'null byte'],
    ['x\n.tar.gz', 'newline'],
    [123 as unknown as string, 'non-string'],
    [null as unknown as string, 'null'],
    [undefined as unknown as string, 'undefined'],
  ])('rejects %s (%s)', (input) => {
    expect(isSafeBackupFilename(input)).toBe(false);
  });
});

describe('helper deleteBackup handler — filesystem safety', () => {
  let tmpRoot: string;
  let backupDir: string;
  let outsideDir: string;
  let config: { backupPath: string };

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hytale-backup-delete-test-'));
    backupDir = path.join(tmpRoot, 'backups');
    outsideDir = path.join(tmpRoot, 'outside');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    // Build a minimal config the handler needs.
    config = { backupPath: backupDir };
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('deletes a real backup file inside the backup dir', async () => {
    const target = path.join(backupDir, '2026-04-25T18-30-00-000Z.tar.gz');
    fs.writeFileSync(target, 'fake');

    const { deleteBackup } = await import('../../packages/helper/src/handlers/backup');
    const result = await deleteBackup(config as never, '2026-04-25T18-30-00-000Z.tar.gz');

    expect(result).toEqual({ success: true });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('returns clean error (not throw) when the file is missing', async () => {
    const { deleteBackup } = await import('../../packages/helper/src/handlers/backup');
    const result = await deleteBackup(config as never, '2026-04-25T18-30-00-000Z.tar.gz');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/i);
  });

  it.each([
    '../outside-file.tar.gz',
    '/tmp/x.tar.gz',
    '.hidden.tar.gz',
    '..tar.gz',
    'foo..bar.tar.gz',
    'sub/dir.tar.gz',
    'sub\\dir.tar.gz',
    'notabackup.zip',
  ])('rejects unsafe filename %s WITHOUT touching disk', async (badName) => {
    // Drop a sentinel file that an attacker would want to delete via the
    // traversal — confirms post-condition that nothing was unlinked.
    const sentinel = path.join(outsideDir, 'sentinel.txt');
    fs.writeFileSync(sentinel, 'do-not-delete');

    const { deleteBackup } = await import('../../packages/helper/src/handlers/backup');
    const result = await deleteBackup(config as never, badName);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/invalid backup filename/i);
    expect(fs.existsSync(sentinel)).toBe(true);
  });
});
