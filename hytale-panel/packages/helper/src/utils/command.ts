import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const SAFE_SYSTEMD_UNIT_REGEX = /^[A-Za-z0-9_.@-]+\.service$/;
const ALLOWED_SERVICE_NAME = 'hytale-tmux.service';
const ALLOWED_SYSTEMCTL_ACTIONS = new Set(['status', 'stop', 'reset-failed', 'restart']);
const ALLOWED_JOURNAL_OUTPUTS = new Set(['short-iso', 'cat']);
const JOURNALCTL_WRAPPER = '/usr/local/lib/hytale-panel/hytale-helper-journalctl';
const ISO_UTC_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

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
 * The helper normally runs as non-root and uses sudoers for this tiny set of
 * host-control commands. Root execution is kept for tests/manual runs.
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
      isAllowedServiceUnit(args[1])
    ) {
      return safeExecWithOptionalSudo(command, args, options);
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
      isAllowedServiceUnit(args[1]) &&
      args[2] === '--no-pager' &&
      args[3] === '-o' &&
      ALLOWED_JOURNAL_OUTPUTS.has(args[4]) &&
      args[5] === '-n' &&
      /^\d+$/.test(args[6] ?? '')
    ) {
      const hasSince = args.length === 9 && args[7] === '--since' && isAllowedSinceValue(args[8]);
      const exact = args.length === 7;
      if (exact || hasSince) {
        return safeExecWithOptionalSudo(command, args, options);
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

function isAllowedServiceUnit(unit: string | undefined): boolean {
  return unit === ALLOWED_SERVICE_NAME && SAFE_SYSTEMD_UNIT_REGEX.test(unit);
}

function isAllowedSinceValue(value: string | undefined): boolean {
  return typeof value === 'string' && ISO_UTC_TIMESTAMP_REGEX.test(value) && !Number.isNaN(Date.parse(value));
}

function needsSudo(): boolean {
  return typeof process.getuid === 'function' && process.getuid() !== 0;
}

function safeExecWithOptionalSudo(
  command: string,
  args: string[],
  options: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<CommandResult> {
  if (!needsSudo()) {
    return safeExec(command, args, options);
  }

  const sudoCommand = command === '/usr/bin/journalctl' ? JOURNALCTL_WRAPPER : command;
  return safeExec('/usr/bin/sudo', ['-n', sudoCommand, ...args], options);
}
