/**
 * Strip ANSI escape codes from a string.
 *
 * Shared between the API (for sanitizing log lines before transmission)
 * and the helper (for cleaning command/journalctl output before returning
 * it to the API). Keep both ends identical so the API can rely on the
 * helper's output already being ANSI-free without re-stripping.
 */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}
