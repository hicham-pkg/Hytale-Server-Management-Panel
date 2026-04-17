import { describe, it, expect } from 'vitest';
import * as path from 'path';

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