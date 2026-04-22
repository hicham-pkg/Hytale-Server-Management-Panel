import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  PLAYER_NAME_REGEX,
  MAX_COMMAND_LENGTH,
  COMMAND_CHAR_ALLOWLIST,
  BACKUP_LABEL_REGEX,
  BACKUP_FILENAME_REGEX,
  UUID_REGEX,
  MAX_LOG_LINES,
  MAX_CAPTURE_LINES,
  AddBanSchema,
} from '@hytale-panel/shared';

/**
 * Extended Input Validation Tests
 * Comprehensive Zod schema tests covering all shared schemas,
 * edge cases, and malformed input rejection.
 */

// Re-create schemas for isolated testing
const SendCommandSchema = z.object({
  command: z.string().min(1).max(MAX_COMMAND_LENGTH)
    .refine((val) => COMMAND_CHAR_ALLOWLIST.test(val), { message: 'Command contains disallowed characters' }),
});

const AddPlayerSchema = z.object({
  name: z.string().min(1).max(32).regex(PLAYER_NAME_REGEX, 'Invalid player name'),
});

const CreateBackupSchema = z.object({
  label: z.string().regex(BACKUP_LABEL_REGEX).max(50).optional(),
});

const BackupIdentifierSchema = z.string().refine(
  (value) => UUID_REGEX.test(value) || BACKUP_FILENAME_REGEX.test(value)
);

const RestoreBackupSchema = z.object({
  id: BackupIdentifierSchema,
});

const ClientWsMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe') }),
  z.object({
    type: z.literal('command'),
    data: z.string().min(1).max(MAX_COMMAND_LENGTH)
      .refine((val) => COMMAND_CHAR_ALLOWLIST.test(val), { message: 'Command contains disallowed characters' }),
  }),
  z.object({ type: z.literal('pong') }),
]);

describe('Input Validation — Player Name Edge Cases', () => {
  it('should accept single character names', () => {
    expect(AddPlayerSchema.parse({ name: 'A' })).toBeDefined();
  });

  it('should accept max length names (32 chars)', () => {
    expect(AddPlayerSchema.parse({ name: 'a'.repeat(32) })).toBeDefined();
  });

  it('should reject names with unicode characters', () => {
    expect(() => AddPlayerSchema.parse({ name: 'Plàyér' })).toThrow();
    expect(() => AddPlayerSchema.parse({ name: '日本語' })).toThrow();
    expect(() => AddPlayerSchema.parse({ name: 'user🎮' })).toThrow();
  });

  it('should reject names with null bytes', () => {
    expect(() => AddPlayerSchema.parse({ name: 'user\x00evil' })).toThrow();
  });

  it('should reject names with newlines', () => {
    expect(() => AddPlayerSchema.parse({ name: 'user\nevil' })).toThrow();
    expect(() => AddPlayerSchema.parse({ name: 'user\revil' })).toThrow();
  });

  it('should reject names with tabs', () => {
    expect(() => AddPlayerSchema.parse({ name: 'user\tevil' })).toThrow();
  });
});

describe('Input Validation — Ban Schema', () => {
  it('should accept ban with valid name and reason', () => {
    const result = AddBanSchema.parse({ name: 'griefer', reason: 'Griefing spawn' });
    expect(result.name).toBe('griefer');
    expect(result.reason).toBe('Griefing spawn');
  });

  it('should accept ban without reason (defaults to empty)', () => {
    const result = AddBanSchema.parse({ name: 'griefer' });
    expect(result.reason).toBe('');
  });

  it('should reject reason exceeding 200 characters', () => {
    expect(() => AddBanSchema.parse({ name: 'griefer', reason: 'x'.repeat(201) })).toThrow();
  });

  it('should reject reason with characters outside the helper command allowlist', () => {
    // Characters NOT in COMMAND_CHAR_ALLOWLIST would cause the helper to
    // reject the online `ban <name> <reason>` command at runtime.
    expect(() => AddBanSchema.parse({ name: 'griefer', reason: "don't" })).toThrow();
    expect(() => AddBanSchema.parse({ name: 'griefer', reason: 'spam; rm -rf /' })).toThrow();
    expect(() => AddBanSchema.parse({ name: 'griefer', reason: 'bad|pipe' })).toThrow();
    expect(() => AddBanSchema.parse({ name: 'griefer', reason: 'newline\ninjection' })).toThrow();
  });

  it('should reject ban with invalid player name', () => {
    expect(() => AddBanSchema.parse({ name: 'invalid name!', reason: 'test' })).toThrow();
  });
});

describe('Input Validation — Backup Filename Regex', () => {
  it('should accept valid backup filenames', () => {
    expect(BACKUP_FILENAME_REGEX.test('2024-03-15T10-30-00.tar.gz')).toBe(true);
    expect(BACKUP_FILENAME_REGEX.test('backup_daily.tar.gz')).toBe(true);
    expect(BACKUP_FILENAME_REGEX.test('pre-update.tar.gz')).toBe(true);
  });

  it('should reject filenames without .tar.gz extension', () => {
    expect(BACKUP_FILENAME_REGEX.test('backup.zip')).toBe(false);
    expect(BACKUP_FILENAME_REGEX.test('backup.tar')).toBe(false);
    expect(BACKUP_FILENAME_REGEX.test('backup')).toBe(false);
  });

  it('should reject filenames with path traversal', () => {
    expect(BACKUP_FILENAME_REGEX.test('../etc/passwd.tar.gz')).toBe(false);
    expect(BACKUP_FILENAME_REGEX.test('/etc/shadow.tar.gz')).toBe(false);
  });

  it('should reject filenames with spaces', () => {
    expect(BACKUP_FILENAME_REGEX.test('my backup.tar.gz')).toBe(false);
  });

  it('should reject filenames with shell metacharacters', () => {
    expect(BACKUP_FILENAME_REGEX.test('backup;rm -rf.tar.gz')).toBe(false);
    expect(BACKUP_FILENAME_REGEX.test('backup$(cmd).tar.gz')).toBe(false);
    expect(BACKUP_FILENAME_REGEX.test('backup`cmd`.tar.gz')).toBe(false);
  });
});

describe('Input Validation — Restore Backup Schema', () => {
  it('should accept valid UUID for backup ID', () => {
    expect(RestoreBackupSchema.parse({ id: '550e8400-e29b-41d4-a716-446655440000' })).toBeDefined();
  });

  it('should accept a safe disk-only backup filename', () => {
    expect(RestoreBackupSchema.parse({ id: '2026-03-25T10-00-00-000Z_world.tar.gz' })).toBeDefined();
  });

  it('should reject unsafe backup IDs', () => {
    expect(() => RestoreBackupSchema.parse({ id: 'not-a-backup-id' })).toThrow();
    expect(() => RestoreBackupSchema.parse({ id: '../../../etc/passwd' })).toThrow();
    expect(() => RestoreBackupSchema.parse({ id: '' })).toThrow();
  });
});

describe('Input Validation — WebSocket Message Schema', () => {
  it('should accept valid subscribe message', () => {
    const result = ClientWsMessageSchema.parse({ type: 'subscribe' });
    expect(result.type).toBe('subscribe');
  });

  it('should accept valid command message', () => {
    const result = ClientWsMessageSchema.parse({ type: 'command', data: 'save' });
    expect(result.type).toBe('command');
  });

  it('should accept valid pong message', () => {
    const result = ClientWsMessageSchema.parse({ type: 'pong' });
    expect(result.type).toBe('pong');
  });

  it('should reject unknown message types', () => {
    expect(() => ClientWsMessageSchema.parse({ type: 'unknown' })).toThrow();
    expect(() => ClientWsMessageSchema.parse({ type: 'exec' })).toThrow();
  });

  it('should reject command messages with shell metacharacters', () => {
    expect(() => ClientWsMessageSchema.parse({ type: 'command', data: 'save; rm -rf /' })).toThrow();
    expect(() => ClientWsMessageSchema.parse({ type: 'command', data: 'test | cat /etc/passwd' })).toThrow();
  });

  it('should reject command messages with empty data', () => {
    expect(() => ClientWsMessageSchema.parse({ type: 'command', data: '' })).toThrow();
  });

  it('should reject malformed JSON-like payloads', () => {
    expect(() => ClientWsMessageSchema.parse(null)).toThrow();
    expect(() => ClientWsMessageSchema.parse(undefined)).toThrow();
    expect(() => ClientWsMessageSchema.parse('string')).toThrow();
    expect(() => ClientWsMessageSchema.parse(42)).toThrow();
  });
});

describe('Input Validation — Log Limits', () => {
  it('should cap log lines at 1000', () => {
    expect(MAX_LOG_LINES).toBe(1000);
    const logLinesSchema = z.number().int().min(1).max(MAX_LOG_LINES);
    expect(logLinesSchema.parse(1)).toBe(1);
    expect(logLinesSchema.parse(1000)).toBe(1000);
    expect(() => logLinesSchema.parse(1001)).toThrow();
    expect(() => logLinesSchema.parse(0)).toThrow();
    expect(() => logLinesSchema.parse(-1)).toThrow();
  });

  it('should cap capture-pane lines at 500', () => {
    expect(MAX_CAPTURE_LINES).toBe(500);
    const captureLinesSchema = z.number().int().min(1).max(MAX_CAPTURE_LINES);
    expect(captureLinesSchema.parse(500)).toBe(500);
    expect(() => captureLinesSchema.parse(501)).toThrow();
  });
});
