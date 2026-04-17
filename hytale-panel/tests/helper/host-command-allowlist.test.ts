import { describe, it, expect } from 'vitest';
import { runAllowlistedCommand } from '../../packages/helper/src/utils/command';

describe('Helper Host Command Allowlist', () => {
  it('rejects commands that are not explicitly allowlisted', async () => {
    const result = await runAllowlistedCommand('/bin/sh', ['-c', 'id']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Command is not in the helper allowlist');
  });

  it('rejects systemctl argument patterns outside the allowlist', async () => {
    const result = await runAllowlistedCommand('/usr/bin/systemctl', ['start', 'hytale-tmux.service']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Command arguments are not in the helper allowlist');
  });

  it('rejects invalid systemd unit names', async () => {
    const result = await runAllowlistedCommand('/usr/bin/systemctl', ['status', '../../etc/passwd']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Command arguments are not in the helper allowlist');
  });

  it('rejects journalctl flags outside the allowlist', async () => {
    const result = await runAllowlistedCommand('/usr/bin/journalctl', [
      '-u',
      'hytale-tmux.service',
      '--no-pager',
      '-o',
      'short-iso',
      '-n',
      '50',
      '--output-fields',
      'MESSAGE',
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Command arguments are not in the helper allowlist');
  });
});
