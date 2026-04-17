import { stripAnsi } from '@hytale-panel/shared';

/**
 * HTML-escape a string. Defense-in-depth utility for any future code path
 * that needs to render log/server output into raw HTML rather than through
 * React's default text escaping. Currently unused in production but kept
 * available — see docs/architecture.md threat R7.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Sanitize an array of log lines for safe transmission to the frontend.
 * Strips ANSI codes — React's default escaping handles XSS at render time.
 */
export function sanitizeLogLines(lines: string[]): string[] {
  return lines.map(stripAnsi);
}
