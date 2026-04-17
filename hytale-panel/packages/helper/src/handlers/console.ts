import { sanitizeCommand, stripAnsi } from '../utils/sanitize';
import type { HelperConfig } from '../config';
import { tmuxExec } from '../utils/tmux';

/**
 * Send a command to the Hytale server via tmux send-keys.
 * The command is sanitized and validated before sending.
 */
export async function sendCommand(
  config: HelperConfig,
  command: string
): Promise<{ success: boolean; message: string }> {
  const sanitized = sanitizeCommand(command);

  // Check if tmux session exists
  const checkResult = await tmuxExec(config, ['has-session', '-t', config.tmuxSession]);
  if (checkResult.exitCode !== 0) {
    return { success: false, message: 'Server tmux session not found. Is the server running?' };
  }

  const result = await tmuxExec(config, [
    'send-keys',
    '-t',
    config.tmuxSession,
    sanitized,
    'Enter',
  ]);

  if (result.exitCode !== 0) {
    return { success: false, message: `Failed to send command: ${result.stderr.slice(0, 200)}` };
  }

  return { success: true, message: `Command sent: ${sanitized}` };
}

/**
 * Capture the current tmux pane output.
 * Returns the last N lines of the console output.
 */
export async function capturePane(
  config: HelperConfig,
  lines: number
): Promise<{ success: boolean; lines: string[]; error?: string }> {
  const clampedLines = Math.min(Math.max(lines, 1), 500);

  const checkResult = await tmuxExec(config, ['has-session', '-t', config.tmuxSession]);
  if (checkResult.exitCode !== 0) {
    return { success: false, lines: [], error: 'Server tmux session not found' };
  }

  const result = await tmuxExec(config, [
    'capture-pane',
    '-t',
    config.tmuxSession,
    '-p',
    '-S',
    `-${clampedLines}`,
  ]);

  if (result.exitCode !== 0) {
    return { success: false, lines: [], error: `Capture failed: ${result.stderr.slice(0, 200)}` };
  }

  const outputLines = stripAnsi(result.stdout)
    .split('\n')
    .filter((line) => line.trim().length > 0);

  return { success: true, lines: outputLines };
}
