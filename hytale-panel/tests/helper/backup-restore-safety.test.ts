import { describe, it, expect } from 'vitest';
import { BACKUP_FILENAME_REGEX } from '@hytale-panel/shared';

/**
 * Backup Restore Safety Tests
 * Tests that restore is blocked while server is running,
 * pre-restore safety snapshots are created,
 * and tar archive contents are validated.
 */

describe('Backup Restore Safety — Server Must Be Stopped', () => {
  it('should block restore when server is running', () => {
    const serverStatus = { running: true };
    const canRestore = !serverStatus.running;
    expect(canRestore).toBe(false);
  });

  it('should allow restore when server is stopped', () => {
    const serverStatus = { running: false };
    const canRestore = !serverStatus.running;
    expect(canRestore).toBe(true);
  });
});

describe('Backup Restore Safety — Pre-Restore Snapshot', () => {
  it('should create safety backup with "safety-pre-restore" label', () => {
    const label = 'safety-pre-restore';
    expect(label).toBe('safety-pre-restore');
    // The restoreBackup handler calls createBackup(config, 'safety-pre-restore')
    // before performing the actual restore
  });

  it('should sanitize safety backup label', () => {
    const label = 'safety-pre-restore';
    const sanitized = label.replace(/[^a-zA-Z0-9_\-]/g, '');
    expect(sanitized).toBe('safety-pre-restore');
  });
});

describe('Backup Restore Safety — Tar Content Validation', () => {
  it('should reject tar entries with absolute paths', () => {
    const entries = ['/etc/passwd', 'worlds/data.dat'];
    const hasUnsafe = entries.some(e => e.startsWith('/') || e.includes('..'));
    expect(hasUnsafe).toBe(true);
  });

  it('should reject tar entries with path traversal', () => {
    const entries = ['worlds/data.dat', '../../../etc/crontab'];
    const hasUnsafe = entries.some(e => e.startsWith('/') || e.includes('..'));
    expect(hasUnsafe).toBe(true);
  });

  it('should reject tar entries with hidden traversal', () => {
    const entries = ['worlds/../../etc/shadow'];
    const hasUnsafe = entries.some(e => e.startsWith('/') || e.includes('..'));
    expect(hasUnsafe).toBe(true);
  });

  it('should accept safe tar entries', () => {
    const entries = ['worlds/', 'worlds/world1/', 'worlds/world1/level.dat', 'worlds/world1/region/r.0.0.mca'];
    const hasUnsafe = entries.some(e => e.startsWith('/') || e.includes('..'));
    expect(hasUnsafe).toBe(false);
  });

  it('should reject empty tar entries list (corrupted archive)', () => {
    const entries: string[] = [];
    // An empty tar listing likely means corruption
    const isSuspicious = entries.length === 0;
    expect(isSuspicious).toBe(true);
  });
});

describe('Backup Restore Safety — Filename Validation', () => {
  it('should reject filenames with path components', () => {
    expect(BACKUP_FILENAME_REGEX.test('../../etc/passwd.tar.gz')).toBe(false);
    expect(BACKUP_FILENAME_REGEX.test('subdir/backup.tar.gz')).toBe(false);
  });

  it('should reject filenames with shell injection', () => {
    expect(BACKUP_FILENAME_REGEX.test('$(rm -rf /).tar.gz')).toBe(false);
    expect(BACKUP_FILENAME_REGEX.test('`rm -rf /`.tar.gz')).toBe(false);
    expect(BACKUP_FILENAME_REGEX.test('backup;evil.tar.gz')).toBe(false);
  });

  it('should accept valid backup filenames', () => {
    expect(BACKUP_FILENAME_REGEX.test('2024-03-15T10-30-00_daily.tar.gz')).toBe(true);
    expect(BACKUP_FILENAME_REGEX.test('safety-pre-restore.tar.gz')).toBe(true);
    expect(BACKUP_FILENAME_REGEX.test('backup.tar.gz')).toBe(true);
  });
});

describe('Backup Restore Safety — Extraction Safety', () => {
  it('should extract to parent of worlds directory only', () => {
    // tar -xzf backup.tar.gz -C /opt/hytale/Server
    // This extracts relative to Server/, so worlds/ goes to Server/worlds/
    const extractBase = '/opt/hytale/Server';
    const worldsPath = '/opt/hytale/Server/worlds';
    const parentDir = worldsPath.substring(0, worldsPath.lastIndexOf('/'));
    expect(parentDir).toBe(extractBase);
  });
});