import { BACKUP_FILENAME_REGEX } from '../constants';

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

/**
 * Strict validator for backup filenames used at trust boundaries.
 *
 * BACKUP_FILENAME_REGEX (`^[a-zA-Z0-9_\-\.]+\.tar\.gz$`) was permissive
 * enough to let `..tar.gz`, `.hidden.tar.gz`, and `foo..bar.tar.gz` through.
 * Those would still be safe inside the helper (path-join + guardPath blocks
 * the traversal) but they confuse audit logs, surprise the operator, and
 * make the API service accept inputs that semantically shouldn't be valid
 * backup filenames.
 *
 * Use this at:
 *   - the helper-side delete/hash entry points (defense in depth);
 *   - the API-side deleteBackup service before crossing the helper boundary.
 *
 * Rejects anything that:
 *   - is not a string,
 *   - fails the existing BACKUP_FILENAME_REGEX (slashes, control chars,
 *     non-`.tar.gz` extensions, etc.),
 *   - starts with a dot (hidden files),
 *   - contains `..` anywhere (path-traversal sentinel).
 */
export function isSafeBackupFilename(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  if (!BACKUP_FILENAME_REGEX.test(name)) return false;
  if (name.startsWith('.')) return false;
  if (name.includes('..')) return false;
  return true;
}
