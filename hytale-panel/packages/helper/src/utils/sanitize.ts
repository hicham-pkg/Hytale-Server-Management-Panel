import { COMMAND_CHAR_ALLOWLIST, MAX_COMMAND_LENGTH } from '@hytale-panel/shared';

/**
 * Validate and sanitize a console command.
 * Returns the sanitized command or throws if invalid.
 */
export function sanitizeCommand(command: string): string {
  const trimmed = command.trim();

  if (trimmed.length === 0) {
    throw new Error('Command cannot be empty');
  }

  if (trimmed.length > MAX_COMMAND_LENGTH) {
    throw new Error(`Command exceeds maximum length of ${MAX_COMMAND_LENGTH}`);
  }

  if (!COMMAND_CHAR_ALLOWLIST.test(trimmed)) {
    throw new Error('Command contains disallowed characters');
  }

  return trimmed;
}

/**
 * Strip ANSI escape codes from a string.
 */
export function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}