import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const SAFE_SYSTEMD_UNIT_REGEX = /^[A-Za-z0-9_.@-]+\.service$/;
const ALLOWED_SYSTEMCTL_ACTIONS = new Set(['status', 'stop', 'reset-failed', 'restart']);
const ALLOWED_JOURNAL_OUTPUTS = new Set(['short-iso', 'cat']);

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute a command safely using execFile (no shell interpolation).
 * Never use exec() or shell: true.
 */
export async function safeExec(
  command: string,
  args: string[],
  options: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      timeout: options.timeout ?? 30_000,
      cwd: options.cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, PATH: '/usr/bin:/usr/sbin:/bin:/sbin', ...options.env },
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? String(err),
      exitCode: typeof e.code === 'number' ? e.code : 1,
    };
  }
}

/**
 * Execute an allowlisted host command with exact arguments (no shell).
 * The shipped helper model runs as local-only root, so the normal path is a
 * direct execFile call. The older sudo-based path is intentionally retired.
 */
export async function runAllowlistedCommand(
  command: string,
  args: string[],
  options: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<CommandResult> {
  if (command === '/usr/bin/systemctl') {
    if (
      args.length === 2 &&
      ALLOWED_SYSTEMCTL_ACTIONS.has(args[0]) &&
      SAFE_SYSTEMD_UNIT_REGEX.test(args[1])
    ) {
      return safeExec(command, args, options);
    }

    return {
      stdout: '',
      stderr: `Command arguments are not in the helper allowlist: ${command} ${args.join(' ')}`.slice(0, 300),
      exitCode: 1,
    };
  }

  if (command === '/usr/bin/journalctl') {
    if (
      args.length >= 6 &&
      args[0] === '-u' &&
      SAFE_SYSTEMD_UNIT_REGEX.test(args[1]) &&
      args[2] === '--no-pager' &&
      args[3] === '-o' &&
      ALLOWED_JOURNAL_OUTPUTS.has(args[4]) &&
      args[5] === '-n' &&
      /^\d+$/.test(args[6] ?? '')
    ) {
      const hasSince = args.length === 9 && args[7] === '--since' && !Number.isNaN(Date.parse(args[8] ?? ''));
      const exact = args.length === 7;
      if (exact || hasSince) {
        return safeExec(command, args, options);
      }
    }

    return {
      stdout: '',
      stderr: `Command arguments are not in the helper allowlist: ${command} ${args.join(' ')}`.slice(0, 300),
      exitCode: 1,
    };
  }

  return {
    stdout: '',
    stderr: `Command is not in the helper allowlist: ${command}`.slice(0, 300),
    exitCode: 1,
  };
}
