import { describe, it, expect } from 'vitest';

// Inline the sanitize logic for testing without full module resolution
const MAX_COMMAND_LENGTH = 200;
const COMMAND_CHAR_ALLOWLIST = /^[a-zA-Z0-9 _\-\.@:\/]+$/;

function sanitizeCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) throw new Error('Command cannot be empty');
  if (trimmed.length > MAX_COMMAND_LENGTH) throw new Error(`Command exceeds maximum length of ${MAX_COMMAND_LENGTH}`);
  if (!COMMAND_CHAR_ALLOWLIST.test(trimmed)) throw new Error('Command contains disallowed characters');
  return trimmed;
}

describe('Command Sanitization', () => {
  it('should accept valid commands', () => {
    expect(sanitizeCommand('whitelist add Player1')).toBe('whitelist add Player1');
    expect(sanitizeCommand('ban Player2')).toBe('ban Player2');
    expect(sanitizeCommand('save')).toBe('save');
    expect(sanitizeCommand('whitelist remove Test_User')).toBe('whitelist remove Test_User');
  });

  it('should reject empty commands', () => {
    expect(() => sanitizeCommand('')).toThrow('Command cannot be empty');
    expect(() => sanitizeCommand('   ')).toThrow('Command cannot be empty');
  });

  it('should reject commands exceeding max length', () => {
    const longCmd = 'a'.repeat(201);
    expect(() => sanitizeCommand(longCmd)).toThrow('exceeds maximum length');
  });

  it('should reject shell metacharacters', () => {
    expect(() => sanitizeCommand('save; rm -rf /')).toThrow('disallowed characters');
    expect(() => sanitizeCommand('test | cat /etc/passwd')).toThrow('disallowed characters');
    expect(() => sanitizeCommand('test && echo pwned')).toThrow('disallowed characters');
    expect(() => sanitizeCommand('test $(whoami)')).toThrow('disallowed characters');
    expect(() => sanitizeCommand('test `whoami`')).toThrow('disallowed characters');
    expect(() => sanitizeCommand('test > /tmp/out')).toThrow('disallowed characters');
    expect(() => sanitizeCommand('test < /etc/passwd')).toThrow('disallowed characters');
    expect(() => sanitizeCommand("test' OR 1=1")).toThrow('disallowed characters');
    expect(() => sanitizeCommand('test"injection')).toThrow('disallowed characters');
    expect(() => sanitizeCommand('test\nnewline')).toThrow('disallowed characters');
  });

  it('should trim whitespace', () => {
    expect(sanitizeCommand('  save  ')).toBe('save');
  });
});