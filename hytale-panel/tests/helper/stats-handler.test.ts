import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  readFile: vi.fn(),
}));

const commandMock = vi.hoisted(() => ({
  safeExec: vi.fn(),
}));

const serverControlMock = vi.hoisted(() => ({
  getManagedRuntimeProcess: vi.fn(),
}));

vi.mock('fs/promises', () => fsMock);
vi.mock('../../packages/helper/src/utils/command', () => commandMock);
vi.mock('../../packages/helper/src/handlers/server-control', () => serverControlMock);

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

describe('helper stats handler', () => {
  beforeEach(() => {
    vi.useRealTimers();
    fsMock.readFile.mockReset();
    commandMock.safeExec.mockReset();
    serverControlMock.getManagedRuntimeProcess.mockReset();
  });

  it('computes system CPU usage from interval deltas instead of a single lifetime snapshot', async () => {
    vi.useFakeTimers();

    fsMock.readFile
      .mockResolvedValueOnce('cpu  100 0 100 800 0 0 0 0 0 0\n')
      .mockResolvedValueOnce('cpu  150 0 150 850 0 0 0 0 0 0\n')
      .mockResolvedValueOnce('MemTotal:       1024000 kB\nMemAvailable:    512000 kB\n')
      .mockResolvedValueOnce('cpu  200 0 200 900 0 0 0 0 0 0\n')
      .mockResolvedValueOnce('MemTotal:       1024000 kB\nMemAvailable:    512000 kB\n');

    commandMock.safeExec
      .mockResolvedValueOnce(ok('Size Used Use%\n100G 20G 20%\n'))
      .mockResolvedValueOnce(ok('Size Used Use%\n100G 20G 20%\n'));

    const { getSystemStats } = await import('../../packages/helper/src/handlers/stats');

    const firstStatsPromise = getSystemStats();
    await vi.advanceTimersByTimeAsync(250);
    const firstStats = await firstStatsPromise;

    const secondStats = await getSystemStats();

    expect(firstStats.success).toBe(true);
    expect(firstStats.stats?.cpuUsagePercent).toBe(67);
    expect(secondStats.success).toBe(true);
    expect(secondStats.stats?.cpuUsagePercent).toBe(67);
  });

  it('uses managed runtime PID detection for process stats instead of pgrep', async () => {
    serverControlMock.getManagedRuntimeProcess.mockResolvedValue({ pid: 4242, elapsedSeconds: 123 });
    commandMock.safeExec.mockResolvedValue(ok('12.5 4096 01:23:45\n'));

    const { getProcessStats } = await import('../../packages/helper/src/handlers/stats');
    const result = await getProcessStats(helperConfig as any);

    expect(serverControlMock.getManagedRuntimeProcess).toHaveBeenCalledWith(helperConfig);
    expect(commandMock.safeExec).toHaveBeenCalledWith('/usr/bin/ps', ['-p', '4242', '-o', 'pcpu=,rss=,etime=']);
    expect(result).toEqual({
      success: true,
      stats: {
        pid: 4242,
        cpuPercent: 12.5,
        memoryMb: 4,
        uptime: '01:23:45',
      },
    });
  });

  it('returns null process stats when no managed runtime PID is detected', async () => {
    serverControlMock.getManagedRuntimeProcess.mockResolvedValue(null);

    const { getProcessStats } = await import('../../packages/helper/src/handlers/stats');
    const result = await getProcessStats(helperConfig as any);

    expect(result).toEqual({
      success: true,
      stats: {
        pid: null,
        cpuPercent: null,
        memoryMb: null,
        uptime: null,
      },
    });
    expect(commandMock.safeExec).not.toHaveBeenCalled();
  });
});
