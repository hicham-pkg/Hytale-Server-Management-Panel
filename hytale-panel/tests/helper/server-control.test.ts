import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getServerStatus, startServer, stopServer } from '../../packages/helper/src/handlers/server-control';

const commandMock = vi.hoisted(() => ({
  safeExec: vi.fn(),
  runAllowlistedCommand: vi.fn(),
}));

vi.mock('../../packages/helper/src/utils/command', () => commandMock);

const helperConfig = {
  socketPath: '/opt/hytale-panel/run/hytale-helper.sock',
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

function fail(stderr = 'error', stdout = '', exitCode = 1) {
  return { stdout, stderr, exitCode };
}

describe('helper server runtime detection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-26T12:00:00.000Z'));
    commandMock.safeExec.mockReset();
    commandMock.runAllowlistedCommand.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports ONLINE when a tmux session exists and a Hytale Java process is running', async () => {
    commandMock.runAllowlistedCommand.mockResolvedValueOnce(
      fail('Unit hytale-tmux.service could not be found.', '', 3)
    );
    commandMock.safeExec
      .mockResolvedValueOnce(ok()) // tmux has-session
      .mockResolvedValueOnce(ok('120\n')) // tmux list-panes
      .mockResolvedValueOnce(ok([
        '120 1 60 bash -bash',
        '121 120 55 bash /bin/bash /opt/hytale/start.sh',
        '222 121 400 java java -Xmx4G -Xms2G -jar /opt/hytale/HytaleServer.jar',
      ].join('\n')));

    const status = await getServerStatus(helperConfig);

    expect(status).toEqual({
      running: true,
      pid: 222,
      uptime: '6m',
      lastRestart: '2026-03-26T11:53:20.000Z',
    });
  });

  it('treats Start as an idempotent no-op when the tmux-backed runtime already exists', async () => {
    commandMock.runAllowlistedCommand.mockResolvedValueOnce(
      fail('Unit hytale-tmux.service could not be found.', '', 3)
    );
    commandMock.safeExec
      .mockResolvedValueOnce(ok()) // tmux has-session
      .mockResolvedValueOnce(ok('120\n')) // tmux list-panes
      .mockResolvedValueOnce(ok([
        '120 1 60 bash -bash',
        '121 120 55 bash /bin/bash /opt/hytale/start.sh',
        '222 121 400 java java -Xmx4G -Xms2G -jar /opt/hytale/HytaleServer.jar',
      ].join('\n')))
      .mockResolvedValueOnce(ok()) // tmux has-session confirm pass
      .mockResolvedValueOnce(ok('120\n')) // tmux list-panes confirm pass
      .mockResolvedValueOnce(ok([
        '120 1 60 bash -bash',
        '121 120 55 bash /bin/bash /opt/hytale/start.sh',
        '222 121 400 java java -Xmx4G -Xms2G -jar /opt/hytale/HytaleServer.jar',
      ].join('\n')))
      .mockResolvedValueOnce(ok()) // tmux has-session confirm pass 2
      .mockResolvedValueOnce(ok('120\n')) // tmux list-panes confirm pass 2
      .mockResolvedValueOnce(ok([
        '120 1 60 bash -bash',
        '121 120 55 bash /bin/bash /opt/hytale/start.sh',
        '222 121 400 java java -Xmx4G -Xms2G -jar /opt/hytale/HytaleServer.jar',
      ].join('\n')));

    const startPromise = startServer(helperConfig);
    await vi.runAllTimersAsync();
    const result = await startPromise;

    expect(result).toEqual({
      success: true,
      message: 'Server is already running (tmux session and Hytale JVM were both confirmed on repeated checks)',
    });
    expect(commandMock.runAllowlistedCommand).toHaveBeenCalledTimes(1);
  });

  it('reconciles stale active/exited unit state before starting when no tmux runtime exists', async () => {
    commandMock.runAllowlistedCommand
      .mockResolvedValueOnce(ok('Active: active (exited) since Thu 2026-03-26 11:50:00 UTC; 10min ago')) // status
      .mockResolvedValueOnce(ok()) // stop
      .mockResolvedValueOnce(ok()) // reset-failed
      .mockResolvedValueOnce(ok()); // restart

    commandMock.safeExec
      .mockResolvedValueOnce(fail('no session', '', 1)) // tmux has-session before start
      .mockResolvedValueOnce(ok()) // tmux has-session after start
      .mockResolvedValueOnce(ok('120\n')) // tmux list-panes after start
      .mockResolvedValueOnce(ok([
        '120 1 60 bash -bash',
        '121 120 55 bash /bin/bash /opt/hytale/start.sh',
        '222 121 400 java java -Xmx4G -Xms2G -jar /opt/hytale/HytaleServer.jar',
      ].join('\n'))) // ps after start
      .mockResolvedValueOnce(ok()) // tmux has-session during stability check
      .mockResolvedValueOnce(ok('120\n')) // tmux list-panes during stability check
      .mockResolvedValueOnce(ok([
        '120 1 60 bash -bash',
        '121 120 55 bash /bin/bash /opt/hytale/start.sh',
        '222 121 405 java java -Xmx4G -Xms2G -jar /opt/hytale/HytaleServer.jar',
      ].join('\n'))); // ps after start

    const startPromise = startServer(helperConfig);
    await vi.runAllTimersAsync();
    const result = await startPromise;

    expect(result).toEqual({
      success: true,
      message: 'Stale runtime state was reconciled and the server started successfully',
    });
    expect(commandMock.runAllowlistedCommand).toHaveBeenCalledWith('/usr/bin/systemctl', ['stop', 'hytale-tmux.service']);
    expect(commandMock.runAllowlistedCommand).toHaveBeenCalledWith('/usr/bin/systemctl', ['reset-failed', 'hytale-tmux.service']);
    expect(commandMock.runAllowlistedCommand).toHaveBeenCalledWith('/usr/bin/systemctl', ['restart', 'hytale-tmux.service']);
  });

  it('reports OFFLINE when the tmux runtime is absent even if systemd says active (exited)', async () => {
    commandMock.runAllowlistedCommand.mockResolvedValueOnce(
      ok('Active: active (exited) since Thu 2026-03-26 11:50:00 UTC; 10min ago')
    );
    commandMock.safeExec.mockResolvedValueOnce(fail('no session', '', 1));

    const status = await getServerStatus(helperConfig);

    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(status.uptime).toBeNull();
  });

  it('falls back to tmux stop when systemd stop does not stop the live runtime', async () => {
    commandMock.runAllowlistedCommand
      .mockResolvedValueOnce(ok('Active: active (running) since Thu 2026-03-26 11:50:00 UTC; 10min ago')) // status
      .mockResolvedValueOnce(fail('Job for hytale-tmux.service failed.', '', 1)) // initial stop
      .mockResolvedValueOnce(ok()) // reconcile stop
      .mockResolvedValueOnce(ok()); // reset-failed

    commandMock.safeExec
      .mockResolvedValueOnce(ok()) // tmux has-session for status
      .mockResolvedValueOnce(ok('120\n')) // tmux list-panes for status
      .mockResolvedValueOnce(ok([
        '120 1 60 bash -bash',
        '121 120 55 bash /bin/bash /opt/hytale/start.sh',
        '222 121 400 java java -Xmx4G -Xms2G -jar /opt/hytale/HytaleServer.jar',
      ].join('\n')))
      .mockResolvedValueOnce(ok()) // tmux has-session for fallback stop
      .mockResolvedValueOnce(ok()) // tmux send-keys save
      .mockResolvedValueOnce(ok()) // tmux has-session before kill
      .mockResolvedValueOnce(ok()) // tmux kill-session
      .mockResolvedValueOnce(fail('no session', '', 1)); // tmux has-session after stop

    const stopPromise = stopServer(helperConfig);
    await vi.runAllTimersAsync();
    const result = await stopPromise;

    expect(result).toEqual({
      success: true,
      message: 'Server stop completed and stale systemd state was reconciled',
    });
    expect(commandMock.safeExec).toHaveBeenCalledWith(
      '/usr/bin/tmux',
      ['-S', '/opt/hytale/run/hytale.tmux.sock', 'send-keys', '-t', 'hytale', 'save', 'Enter']
    );
    expect(commandMock.safeExec).toHaveBeenCalledWith(
      '/usr/bin/tmux',
      ['-S', '/opt/hytale/run/hytale.tmux.sock', 'kill-session', '-t', 'hytale']
    );
    expect(commandMock.runAllowlistedCommand).toHaveBeenCalledWith('/usr/bin/systemctl', ['reset-failed', 'hytale-tmux.service']);
  });

  it('supports a stop then start recovery sequence without leaving systemd and tmux out of sync', async () => {
    commandMock.runAllowlistedCommand
      .mockResolvedValueOnce(ok('Active: active (running) since Thu 2026-03-26 11:50:00 UTC; 10min ago')) // stop status
      .mockResolvedValueOnce(fail('Job for hytale-tmux.service failed.', '', 1)) // stop
      .mockResolvedValueOnce(ok()) // reconcile stop
      .mockResolvedValueOnce(ok()) // reset-failed after stop
      .mockResolvedValueOnce(ok('Active: active (exited) since Thu 2026-03-26 11:55:00 UTC; 5min ago')) // start status
      .mockResolvedValueOnce(ok()) // pre-start stop
      .mockResolvedValueOnce(ok()) // pre-start reset-failed
      .mockResolvedValueOnce(ok()); // restart

    commandMock.safeExec
      .mockResolvedValueOnce(ok()) // stop: tmux has-session for status
      .mockResolvedValueOnce(ok('120\n')) // stop: list-panes
      .mockResolvedValueOnce(ok([
        '120 1 60 bash -bash',
        '121 120 55 bash /bin/bash /opt/hytale/start.sh',
        '222 121 400 java java -Xmx4G -Xms2G -jar /opt/hytale/HytaleServer.jar',
      ].join('\n')))
      .mockResolvedValueOnce(ok()) // stop: tmux has-session for fallback stop
      .mockResolvedValueOnce(ok()) // stop: send-keys
      .mockResolvedValueOnce(ok()) // stop: has-session before kill
      .mockResolvedValueOnce(ok()) // stop: kill-session
      .mockResolvedValueOnce(fail('no session', '', 1)) // stop: waitForRuntimeState stopped
      .mockResolvedValueOnce(fail('no session', '', 1)) // start: has-session before start
      .mockResolvedValueOnce(ok()) // start: has-session after start
      .mockResolvedValueOnce(ok('120\n')) // start: list-panes after start
      .mockResolvedValueOnce(ok([
        '120 1 60 bash -bash',
        '121 120 55 bash /bin/bash /opt/hytale/start.sh',
        '333 121 30 java java -Xmx4G -Xms2G -jar /opt/hytale/HytaleServer.jar',
      ].join('\n'))) // start: ps after start
      .mockResolvedValueOnce(ok()) // start: has-session during stability check
      .mockResolvedValueOnce(ok('120\n')) // start: list-panes during stability check
      .mockResolvedValueOnce(ok([
        '120 1 60 bash -bash',
        '121 120 55 bash /bin/bash /opt/hytale/start.sh',
        '333 121 35 java java -Xmx4G -Xms2G -jar /opt/hytale/HytaleServer.jar',
      ].join('\n'))); // start: ps after start

    const stopPromise = stopServer(helperConfig);
    await vi.runAllTimersAsync();
    const stopResult = await stopPromise;

    const startPromise = startServer(helperConfig);
    await vi.runAllTimersAsync();
    const startResult = await startPromise;

    expect(stopResult).toEqual({
      success: true,
      message: 'Server stop completed and stale systemd state was reconciled',
    });
    expect(startResult).toEqual({
      success: true,
      message: 'Stale runtime state was reconciled and the server started successfully',
    });
  });

  it('does not treat a shell wrapper that mentions java as a running Hytale runtime', async () => {
    commandMock.runAllowlistedCommand.mockResolvedValueOnce(
      ok('Active: active (exited) since Thu 2026-03-26 11:50:00 UTC; 10min ago')
    );
    commandMock.safeExec
      .mockResolvedValueOnce(ok()) // tmux has-session
      .mockResolvedValueOnce(ok('120\n')) // tmux list-panes
      .mockResolvedValueOnce(ok([
        '120 1 60 bash -bash',
        '121 120 55 sh sh -c exec java -Xmx4G -Xms2G -jar /opt/hytale/HytaleServer.jar',
      ].join('\n')));

    const status = await getServerStatus(helperConfig);

    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(status.uptime).toBeNull();
  });

  it('does not treat a zombie java process as a running Hytale runtime', async () => {
    commandMock.runAllowlistedCommand.mockResolvedValueOnce(
      ok('Active: active (exited) since Thu 2026-03-26 11:50:00 UTC; 10min ago')
    );
    commandMock.safeExec
      .mockResolvedValueOnce(ok()) // tmux has-session
      .mockResolvedValueOnce(ok('120\n')) // tmux list-panes
      .mockResolvedValueOnce(ok([
        '120 1 S 60 bash -bash',
        '121 120 S 55 bash /bin/bash /opt/hytale/start.sh',
        '222 121 Z 400 java java -Xmx4G -Xms2G -jar /opt/hytale/HytaleServer.jar',
      ].join('\n')));

    const status = await getServerStatus(helperConfig);

    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    expect(status.uptime).toBeNull();
  });

  it('fails Start when systemd returns but no real Hytale Java runtime appears on the shared socket', async () => {
    commandMock.runAllowlistedCommand
      .mockResolvedValueOnce(ok('Active: active (exited) since Thu 2026-03-26 11:50:00 UTC; 10min ago')) // status
      .mockResolvedValueOnce(ok()) // pre-start stop
      .mockResolvedValueOnce(ok()) // pre-start reset-failed
      .mockResolvedValueOnce(ok()) // restart
      .mockResolvedValueOnce(ok('java.nio.file.FileSystemException: /tmp/libnetty_quiche42_linux_x86_64.so: Read-only file system')); // journalctl

    let hasSessionCalls = 0;
    commandMock.safeExec.mockImplementation(async (command: string, args: string[]) => {
      if (command === '/usr/bin/tmux' && args[2] === 'has-session') {
        hasSessionCalls += 1;
        return hasSessionCalls === 1 ? fail('no session', '', 1) : ok();
      }

      if (command === '/usr/bin/tmux' && args[2] === 'list-panes') {
        return ok('120\n');
      }

      if (command === '/usr/bin/ps') {
        return ok([
          '120 1 60 bash -bash',
          '121 120 55 sh sh -c exec java -Xmx4G -Xms2G -jar /opt/hytale/HytaleServer.jar',
        ].join('\n'));
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const startPromise = startServer(helperConfig);
    await vi.runAllTimersAsync();
    const result = await startPromise;

    expect(result).toEqual({
      success: false,
      message: 'Start command returned, but no managed Hytale Java runtime appeared on the shared tmux socket. Recent launcher error: java.nio.file.FileSystemException: /tmp/libnetty_quiche42_linux_x86_64.so: Read-only file system',
    });
  });

  it('does not take the already-running path on a transient stale runtime reading', async () => {
    commandMock.runAllowlistedCommand
      .mockResolvedValueOnce(ok('Active: active (exited) since Thu 2026-03-26 11:50:00 UTC; 10min ago')) // status
      .mockResolvedValueOnce(ok()) // pre-start stop
      .mockResolvedValueOnce(ok()) // pre-start reset-failed
      .mockResolvedValueOnce(ok()); // restart

    let hasSessionCalls = 0;
    commandMock.safeExec.mockImplementation(async (command: string, args: string[]) => {
      if (command === '/usr/bin/tmux' && args[2] === 'has-session') {
        hasSessionCalls += 1;
        if (hasSessionCalls === 1) {
          return ok();
        }
        if (hasSessionCalls === 2) {
          return fail('no session', '', 1);
        }
        return ok();
      }

      if (command === '/usr/bin/tmux' && args[2] === 'list-panes') {
        return ok('120\n');
      }

      if (command === '/usr/bin/ps') {
        if (hasSessionCalls === 1) {
          return ok([
            '120 1 60 bash -bash',
            '121 120 55 bash /bin/bash /opt/hytale/start.sh',
            '222 121 400 java java -Xmx4G -Xms2G -jar /opt/hytale/HytaleServer.jar',
          ].join('\n'));
        }

        return ok([
          '120 1 60 bash -bash',
          '121 120 20 bash /bin/bash /opt/hytale/start.sh',
          '333 121 15 java java -Xmx4G -Xms2G -jar /opt/hytale/HytaleServer.jar',
        ].join('\n'));
      }

      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    });

    const startPromise = startServer(helperConfig);
    await vi.runAllTimersAsync();
    const result = await startPromise;

    expect(result).toEqual({
      success: true,
      message: 'Stale runtime state was reconciled and the server started successfully',
    });
    expect(commandMock.runAllowlistedCommand).toHaveBeenCalledWith('/usr/bin/systemctl', ['restart', 'hytale-tmux.service']);
  });

  it('fails Start when the runtime appears briefly and then dies during the stability window', async () => {
    commandMock.runAllowlistedCommand
      .mockResolvedValueOnce(ok('Active: active (exited) since Thu 2026-03-26 11:50:00 UTC; 10min ago')) // status
      .mockResolvedValueOnce(ok()) // pre-start stop
      .mockResolvedValueOnce(ok()) // pre-start reset-failed
      .mockResolvedValueOnce(ok()) // restart
      .mockResolvedValueOnce(ok('FileSystemException: /tmp/libnetty_quiche42_linux_x86_64.so: Read-only file system')); // journalctl

    commandMock.safeExec
      .mockResolvedValueOnce(fail('no session', '', 1)) // before start
      .mockResolvedValueOnce(ok()) // runtime appears
      .mockResolvedValueOnce(ok('120\n'))
      .mockResolvedValueOnce(ok([
        '120 1 S 20 bash -bash',
        '121 120 S 15 bash /bin/bash /opt/hytale/start.sh',
        '333 121 S 5 java java -Xmx4G -Xms2G -jar /opt/hytale/HytaleServer.jar',
      ].join('\n')))
      .mockResolvedValueOnce(fail('no session', '', 1)); // runtime dies before stability re-check

    const startPromise = startServer(helperConfig);
    await vi.runAllTimersAsync();
    const result = await startPromise;

    expect(result).toEqual({
      success: false,
      message: 'The managed Hytale runtime appeared but died during startup. Recent launcher error: FileSystemException: /tmp/libnetty_quiche42_linux_x86_64.so: Read-only file system',
    });
  });
});
