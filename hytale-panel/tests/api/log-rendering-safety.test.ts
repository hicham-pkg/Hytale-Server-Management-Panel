import { describe, it, expect } from 'vitest';

/**
 * Log Rendering Safety Tests
 * Tests XSS prevention in log output, ANSI stripping,
 * and HTML escaping for safe rendering.
 */

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function sanitizeLogLine(line: string): string {
  return stripAnsi(line);
}

describe('Log Rendering Safety — HTML Escaping', () => {
  it('should escape < and > to prevent tag injection', () => {
    const malicious = '<script>alert("XSS")</script>';
    const escaped = escapeHtml(malicious);
    expect(escaped).toBe('&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;');
    expect(escaped).not.toContain('<script>');
  });

  it('should escape double quotes', () => {
    const input = 'Player said "hello"';
    const escaped = escapeHtml(input);
    expect(escaped).toBe('Player said &quot;hello&quot;');
  });

  it('should escape single quotes', () => {
    const input = "Player's world";
    const escaped = escapeHtml(input);
    expect(escaped).toBe('Player&#x27;s world');
  });

  it('should escape ampersands', () => {
    const input = 'A & B';
    const escaped = escapeHtml(input);
    expect(escaped).toBe('A &amp; B');
  });

  it('should handle nested XSS attempts', () => {
    const input = '<img src=x onerror=alert(1)>';
    const escaped = escapeHtml(input);
    // Tags are neutralized — no actual HTML element is created
    expect(escaped).not.toContain('<img');
    expect(escaped).toContain('&lt;img');
    expect(escaped).toContain('&gt;');
    // The escaped string is safe to render — browser won't parse it as a tag
  });

  it('should handle event handler injection', () => {
    const input = '<div onmouseover="alert(document.cookie)">';
    const escaped = escapeHtml(input);
    // Tags are neutralized — no actual HTML element is created
    expect(escaped).not.toContain('<div');
    expect(escaped).toContain('&lt;div');
    expect(escaped).toContain('&gt;');
    // Event handlers are harmless as plain text outside of HTML tags
  });

  it('should handle SVG-based XSS', () => {
    const input = '<svg onload=alert(1)>';
    const escaped = escapeHtml(input);
    expect(escaped).not.toContain('<svg');
  });

  it('should handle iframe injection', () => {
    const input = '<iframe src="javascript:alert(1)">';
    const escaped = escapeHtml(input);
    expect(escaped).not.toContain('<iframe');
  });
});

describe('Log Rendering Safety — ANSI Stripping', () => {
  it('should strip color codes', () => {
    const ansiRed = '\x1b[31mERROR\x1b[0m: Something failed';
    expect(stripAnsi(ansiRed)).toBe('ERROR: Something failed');
  });

  it('should strip bold/underline codes', () => {
    const ansiBold = '\x1b[1mBold text\x1b[0m';
    expect(stripAnsi(ansiBold)).toBe('Bold text');
  });

  it('should strip complex ANSI sequences', () => {
    const complex = '\x1b[38;5;196mRed 256-color\x1b[0m';
    expect(stripAnsi(complex)).toBe('Red 256-color');
  });

  it('should handle text without ANSI codes', () => {
    const plain = 'Normal log line without colors';
    expect(stripAnsi(plain)).toBe(plain);
  });

  it('should handle empty string', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('should strip multiple ANSI codes in one line', () => {
    const multi = '\x1b[32m[INFO]\x1b[0m \x1b[33mPlayer\x1b[0m joined the game';
    expect(stripAnsi(multi)).toBe('[INFO] Player joined the game');
  });
});

describe('Log Rendering Safety — Sanitize Log Line', () => {
  it('should strip ANSI and return clean text', () => {
    const line = '\x1b[31m[ERROR]\x1b[0m World crashed';
    expect(sanitizeLogLine(line)).toBe('[ERROR] World crashed');
  });

  it('should preserve normal log content', () => {
    const line = '[2024-03-15 10:30:00] Player1 joined the game';
    expect(sanitizeLogLine(line)).toBe(line);
  });

  it('should handle log lines with HTML-like content from game', () => {
    // Game might output angle brackets in chat or errors
    const line = 'Player said: <hello>';
    const sanitized = sanitizeLogLine(line);
    // sanitizeLogLine only strips ANSI — React's default escaping handles XSS
    expect(sanitized).toBe('Player said: <hello>');
    // But escapeHtml would make it safe for raw HTML contexts
    expect(escapeHtml(sanitized)).toBe('Player said: &lt;hello&gt;');
  });
});

describe('Log Rendering Safety — Batch Sanitization', () => {
  it('should sanitize multiple log lines', () => {
    const lines = [
      '\x1b[32m[INFO]\x1b[0m Server started',
      '\x1b[33m[WARN]\x1b[0m Low memory',
      '\x1b[31m[ERROR]\x1b[0m Crash detected',
    ];
    const sanitized = lines.map(sanitizeLogLine);
    expect(sanitized).toEqual([
      '[INFO] Server started',
      '[WARN] Low memory',
      '[ERROR] Crash detected',
    ]);
  });

  it('should handle empty array', () => {
    const sanitized = ([] as string[]).map(sanitizeLogLine);
    expect(sanitized).toEqual([]);
  });
});