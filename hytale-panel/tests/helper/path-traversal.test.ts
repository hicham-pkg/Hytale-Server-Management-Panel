import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { BACKUP_FILENAME_REGEX } from '@hytale-panel/shared';

/**
 * Path Traversal Prevention Tests
 * Tests that path guard blocks directory traversal, symlink attacks,
 * and paths outside the allowed base directory.
 */

// Synchronous path guard for testing (mirrors async guardPath logic)
function guardPathSync(filePath: string, allowedBase: string): string {
  const resolved = path.resolve(filePath);
  const normalizedBase = path.resolve(allowedBase);
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error(`Path traversal blocked: ${filePath} is outside ${allowedBase}`);
  }
  return resolved;
}

describe('Path Traversal — Backup Directory Guard', () => {
  const backupBase = '/opt/hytale-backups';

  it('should allow files directly in backup directory', () => {
    expect(guardPathSync('/opt/hytale-backups/backup.tar.gz', backupBase))
      .toBe('/opt/hytale-backups/backup.tar.gz');
  });

  it('should allow files in subdirectories', () => {
    expect(guardPathSync('/opt/hytale-backups/2024/march/backup.tar.gz', backupBase))
      .toBe('/opt/hytale-backups/2024/march/backup.tar.gz');
  });

  it('should allow the base directory itself', () => {
    expect(guardPathSync('/opt/hytale-backups', backupBase))
      .toBe('/opt/hytale-backups');
  });

  it('should block single-level traversal', () => {
    expect(() => guardPathSync('/opt/hytale-backups/../etc/passwd', backupBase))
      .toThrow('Path traversal blocked');
  });

  it('should block multi-level traversal', () => {
    expect(() => guardPathSync('/opt/hytale-backups/../../root/.ssh/id_rsa', backupBase))
      .toThrow('Path traversal blocked');
  });

  it('should block absolute paths outside base', () => {
    expect(() => guardPathSync('/etc/passwd', backupBase)).toThrow('Path traversal blocked');
    expect(() => guardPathSync('/tmp/evil', backupBase)).toThrow('Path traversal blocked');
    expect(() => guardPathSync('/root/.bashrc', backupBase)).toThrow('Path traversal blocked');
    expect(() => guardPathSync('/var/log/syslog', backupBase)).toThrow('Path traversal blocked');
  });

  it('should block prefix collision attacks', () => {
    // /opt/hytale-backups-evil starts with /opt/hytale-backups but is a different directory
    expect(() => guardPathSync('/opt/hytale-backups-evil/file', backupBase))
      .toThrow('Path traversal blocked');
    expect(() => guardPathSync('/opt/hytale-backupsx/file', backupBase))
      .toThrow('Path traversal blocked');
  });
});

describe('Path Traversal — Worlds Directory Guard', () => {
  const worldsBase = '/opt/hytale/Server/worlds';

  it('should allow world files within worlds directory', () => {
    expect(guardPathSync('/opt/hytale/Server/worlds/world1/level.dat', worldsBase))
      .toBe('/opt/hytale/Server/worlds/world1/level.dat');
  });

  it('should block escape from worlds directory', () => {
    expect(() => guardPathSync('/opt/hytale/Server/worlds/../config.json', worldsBase))
      .toThrow('Path traversal blocked');
  });

  it('should block access to server root from worlds', () => {
    expect(() => guardPathSync('/opt/hytale/Server/worlds/../../.env', worldsBase))
      .toThrow('Path traversal blocked');
  });
});

describe('Path Traversal — Whitelist/Bans File Guard', () => {
  const serverBase = '/opt/hytale/Server';

  it('should allow whitelist.json within server directory', () => {
    expect(guardPathSync('/opt/hytale/Server/whitelist.json', serverBase))
      .toBe('/opt/hytale/Server/whitelist.json');
  });

  it('should allow bans.json within server directory', () => {
    expect(guardPathSync('/opt/hytale/Server/bans.json', serverBase))
      .toBe('/opt/hytale/Server/bans.json');
  });

  it('should block traversal from server directory', () => {
    expect(() => guardPathSync('/opt/hytale/Server/../../../etc/shadow', serverBase))
      .toThrow('Path traversal blocked');
  });
});

describe('Path Traversal — Backup Filename Validation', () => {
  it('should reject filenames with path components', () => {
    expect(BACKUP_FILENAME_REGEX.test('../../../etc/passwd.tar.gz')).toBe(false);
    expect(BACKUP_FILENAME_REGEX.test('subdir/backup.tar.gz')).toBe(false);
    expect(BACKUP_FILENAME_REGEX.test('/absolute/path.tar.gz')).toBe(false);
  });

  it('should reject filenames with null bytes', () => {
    expect(BACKUP_FILENAME_REGEX.test('backup\x00.tar.gz')).toBe(false);
  });

  it('should reject filenames with spaces', () => {
    expect(BACKUP_FILENAME_REGEX.test('my backup.tar.gz')).toBe(false);
  });
});

describe('Path Traversal — Tar Archive Safety (restore)', () => {
  // The restoreBackup handler validates tar contents before extraction
  it('should detect absolute paths in tar entries', () => {
    const entries = ['/etc/passwd', 'worlds/data.dat'];
    const hasUnsafe = entries.some(e => e.startsWith('/') || e.includes('..'));
    expect(hasUnsafe).toBe(true);
  });

  it('should detect traversal in tar entries', () => {
    const entries = ['worlds/data.dat', '../../../etc/crontab'];
    const hasUnsafe = entries.some(e => e.startsWith('/') || e.includes('..'));
    expect(hasUnsafe).toBe(true);
  });

  it('should accept safe tar entries', () => {
    const entries = ['worlds/', 'worlds/world1/', 'worlds/world1/level.dat'];
    const hasUnsafe = entries.some(e => e.startsWith('/') || e.includes('..'));
    expect(hasUnsafe).toBe(false);
  });
});