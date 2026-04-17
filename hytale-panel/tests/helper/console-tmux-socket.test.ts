import { beforeEach, describe, expect, it, vi } from 'vitest';
import { capturePane, sendCommand } from '../../packages/helper/src/handlers/console';

const commandMock = vi.hoisted(() => ({
  safeExec: vi.fn(),
}));

vi.mock('../../packages/helper/src/utils/command', () => commandMock);

const helperConfig = {
  socketPath: '/run/hytale-helper/hytale-helper.sock',
  hmacSecret: 'x'.repeat(32),
  hytaleRoot: '/opt/hytale',
  backupPath: '/opt/hytale-backups',
  serviceName: 'hytale-tmux.service',
  tmuxSession: 'hytale',
  tmuxSocketPath: '/opt/hytale/run/hytale.tmux.sock',
  whitelistPath: '/opt/hytale/Server/whitelist.json',
  bansPath: '/opt/hytale/Server/bans.json',
  worldsPath: '/opt/hytale/Server/worlds',
};

function ok(stdout = '', stderr = '') {
  return { stdout, stderr, exitCode: 0 };
}

describe('helper console tmux socket integration', () => {
  beforeEach(() => {
    commandMock.safeExec.mockReset();
  });

  it('sends commands through the configured tmux socket', async () => {
    commandMock.safeExec
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());

    const result = await sendCommand(helperConfig, 'save');

    expect(result).toEqual({ success: true, message: 'Command sent: save' });
    expect(commandMock.safeExec).toHaveBeenNthCalledWith(
      1,
      '/usr/bin/tmux',
      ['-S', '/opt/hytale/run/hytale.tmux.sock', 'has-session', '-t', 'hytale']
    );
    expect(commandMock.safeExec).toHaveBeenNthCalledWith(
      2,
      '/usr/bin/tmux',
      ['-S', '/opt/hytale/run/hytale.tmux.sock', 'send-keys', '-t', 'hytale', 'save', 'Enter']
    );
  });

  it('captures pane output through the configured tmux socket', async () => {
    commandMock.safeExec
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok('line 1\nline 2\n'));

    const result = await capturePane(helperConfig, 50);

    expect(result).toEqual({ success: true, lines: ['line 1', 'line 2'] });
    expect(commandMock.safeExec).toHaveBeenNthCalledWith(
      2,
      '/usr/bin/tmux',
      ['-S', '/opt/hytale/run/hytale.tmux.sock', 'capture-pane', '-t', 'hytale', '-p', '-S', '-50']
    );
  });
});
