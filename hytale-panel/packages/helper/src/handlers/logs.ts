import { runAllowlistedCommand } from '../utils/command';
import { stripAnsi } from '@hytale-panel/shared';
import type { HelperConfig } from '../config';

export interface LogReadResult {
  success: boolean;
  lines: string[];
  error?: string;
}

/**
 * Read recent log lines from journalctl for the Hytale service.
 */
export async function readLogs(
  config: HelperConfig,
  lineCount: number,
  since?: string
): Promise<LogReadResult> {
  const clampedLines = Math.min(Math.max(lineCount, 1), 1000);

  const args = ['-u', config.serviceName, '--no-pager', '-o', 'short-iso', '-n', String(clampedLines)];

  if (since) {
    // Validate ISO date format
    const date = new Date(since);
    if (isNaN(date.getTime())) {
      return { success: false, lines: [], error: 'Invalid since date' };
    }
    args.push('--since', date.toISOString());
  }

  const result = await runAllowlistedCommand('/usr/bin/journalctl', args);

  if (result.exitCode !== 0 && !result.stdout) {
    return { success: false, lines: [], error: `journalctl failed: ${result.stderr.slice(0, 200)}` };
  }

  const logLines = stripAnsi(result.stdout)
    .split('\n')
    .filter((line) => line.trim().length > 0);

  return { success: true, lines: logLines };
}
