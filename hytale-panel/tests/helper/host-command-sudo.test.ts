import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFile: execFileMock,
}));

describe('Helper host command sudo execution', () => {
  beforeEach(() => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, { stdout: 'ok', stderr: '' });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    execFileMock.mockReset();
  });

  it('runs allowlisted systemctl commands through non-interactive sudo when helper is non-root', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    const { runAllowlistedCommand } = await import('../../packages/helper/src/utils/command');

    const result = await runAllowlistedCommand('/usr/bin/systemctl', ['status', 'hytale-tmux.service']);

    expect(result).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
    expect(execFileMock).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      ['-n', '/usr/bin/systemctl', 'status', 'hytale-tmux.service'],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function)
    );
  });

  it('keeps direct execution when running as root for tests/manual root runs', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    const { runAllowlistedCommand } = await import('../../packages/helper/src/utils/command');

    const result = await runAllowlistedCommand('/usr/bin/systemctl', ['status', 'hytale-tmux.service']);

    expect(result).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
    expect(execFileMock).toHaveBeenCalledWith(
      '/usr/bin/systemctl',
      ['status', 'hytale-tmux.service'],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function)
    );
  });

  it('runs allowlisted journalctl commands through the validating wrapper when helper is non-root', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    const { runAllowlistedCommand } = await import('../../packages/helper/src/utils/command');
    const args = ['-u', 'hytale-tmux.service', '--no-pager', '-o', 'short-iso', '-n', '50'];

    const result = await runAllowlistedCommand('/usr/bin/journalctl', args);

    expect(result).toEqual({ stdout: 'ok', stderr: '', exitCode: 0 });
    expect(execFileMock).toHaveBeenCalledWith(
      '/usr/bin/sudo',
      ['-n', '/usr/local/lib/hytale-panel/hytale-helper-journalctl', ...args],
      expect.objectContaining({ timeout: 30_000 }),
      expect.any(Function)
    );
  });

  it('rejects disallowed systemctl actions before invoking sudo', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    const { runAllowlistedCommand } = await import('../../packages/helper/src/utils/command');

    const result = await runAllowlistedCommand('/usr/bin/systemctl', ['start', 'hytale-tmux.service']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Command arguments are not in the helper allowlist');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('rejects journalctl file/directory option injection before invoking sudo', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(1000);
    const { runAllowlistedCommand } = await import('../../packages/helper/src/utils/command');

    const result = await runAllowlistedCommand('/usr/bin/journalctl', [
      '-u',
      'hytale-tmux.service',
      '--no-pager',
      '-o',
      'short-iso',
      '-n',
      '50',
      '--file',
      '/var/log/journal/system.journal',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Command arguments are not in the helper allowlist');
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
