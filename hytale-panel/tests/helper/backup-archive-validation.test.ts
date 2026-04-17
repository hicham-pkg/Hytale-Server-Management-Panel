import { describe, it, expect } from 'vitest';
import {
  validateBackupEntries,
  validateBackupEntryTypes,
} from '../../packages/helper/src/handlers/backup';

describe('Backup Archive Validation', () => {
  it('accepts safe worlds-only archive entries', () => {
    expect(
      validateBackupEntries(
        ['worlds', 'worlds/world1', 'worlds/world1/level.dat', 'worlds/world1/region/r.0.0.mca'],
        'worlds'
      )
    ).toEqual({ valid: true });
  });

  it('rejects archives with unexpected top-level paths', () => {
    expect(validateBackupEntries(['worlds', 'plugins/config.yml'], 'worlds')).toEqual({
      valid: false,
      error: 'Backup contains unexpected top-level path: plugins/config.yml',
    });
  });

  it('rejects symlink and hardlink entries', () => {
    expect(
      validateBackupEntryTypes([
        'lrwxrwxrwx root/root         0 2026-03-27 10:00 worlds/latest -> ../../etc/passwd',
      ])
    ).toEqual({
      valid: false,
      error: 'Backup contains unsupported entry types (only regular files and directories are allowed)',
    });

    expect(
      validateBackupEntryTypes([
        'hrw-r--r-- root/root         0 2026-03-27 10:00 worlds/link target',
      ])
    ).toEqual({
      valid: false,
      error: 'Backup contains unsupported entry types (only regular files and directories are allowed)',
    });
  });

  it('accepts regular files and directories in verbose tar output', () => {
    expect(
      validateBackupEntryTypes([
        'drwxr-xr-x root/root         0 2026-03-27 10:00 worlds/',
        '-rw-r--r-- root/root       512 2026-03-27 10:00 worlds/world1/level.dat',
      ])
    ).toEqual({ valid: true });
  });
});
