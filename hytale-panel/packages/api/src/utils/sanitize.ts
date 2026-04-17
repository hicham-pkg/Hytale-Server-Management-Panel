/**
 * HTML-escape a string to prevent XSS when rendering log output.
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
 * Strip ANSI escape codes from log output.
 */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Sanitize log lines for safe transmission to the frontend.
 * Strips ANSI codes — React's default escaping handles XSS.
 */
export function sanitizeLogLine(line: string): string {
  return stripAnsi(line);
}

/**
 * Sanitize an array of log lines.
 */
export function sanitizeLogLines(lines: string[]): string[] {
  return lines.map(sanitizeLogLine);
}