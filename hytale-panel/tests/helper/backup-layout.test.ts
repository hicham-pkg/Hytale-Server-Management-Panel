import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HelperConfig } from '../../packages/helper/src/config';

const serverControlMock = vi.hoisted(() => ({
  getServerStatus: vi.fn(),
}));

vi.mock('../../packages/helper/src/handlers/server-control', () => ({
  getServerStatus: serverControlMock.getServerStatus,
}));

function listArchive(archivePath: string): string[] {
  return execFileSync('/usr/bin/tar', ['-tzf', archivePath], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

function createArchive(archivePath: string, cwd: string, rootEntry: string): void {
  execFileSync('/usr/bin/tar', ['-czf', archivePath, '-C', cwd, rootEntry]);
}

describe('helper backup save-layout support', () => {
  let root: string;
  let config: HelperConfig;

  beforeEach(async () => {
    vi.resetModules();
    serverControlMock.getServerStatus.mockReset();
    serverControlMock.getServerStatus.mockResolvedValue({ running: false });

    root = await realpath(await mkdtemp(path.join(tmpdir(), 'hytale-backup-layout-')));
    const hytaleRoot = path.join(root, 'hytale');
    config = {
      socketPath: path.join(root, 'helper.sock'),
      hmacSecret: 'x'.repeat(32),
      hytaleRoot,
      backupPath: path.join(root, 'backups'),
      modsPath: path.join(hytaleRoot, 'mods'),
      disabledModsPath: path.join(hytaleRoot, 'mods-disabled'),
      modUploadStagingPath: path.join(root, 'panel-data', 'mod-upload-staging'),
      modBackupPath: path.join(hytaleRoot, 'mod-backups'),
      modBackupRetention: 10,
      serviceName: 'hytale-tmux.service',
      tmuxSession: 'hytale',
      tmuxSocketPath: path.join(hytaleRoot, 'run', 'hytale.tmux.sock'),
      whitelistPath: path.join(hytaleRoot, 'Server', 'whitelist.json'),
      bansPath: path.join(hytaleRoot, 'Server', 'bans.json'),
      worldsPath: path.join(hytaleRoot, 'Server', 'worlds'),
      panelUpdateJobsDir: path.join(root, 'panel-data', 'update-jobs'),
      panelUpdateBackupRoot: path.join(root, 'panel-backups'),
      panelUpdateRepo: 'hicham-pkg/Hytale-Server-Management-Panel',
      panelUpdateInstallEnabled: true,
      panelUpdateMaxDownloadMb: 300,
      panelUpdateBackupRetention: 5,
      hytaleUpdateEnabled: true,
      hytaleUpdateJobsDir: path.join(root, 'panel-data', 'hytale-update-jobs'),
      hytaleUpdatePlayerWarningSeconds: 30,
      hytaleUpdateCheckTimeoutSeconds: 60,
      hytaleUpdateDownloadTimeoutSeconds: 900,
      hytaleUpdateApplyTimeoutSeconds: 900,
    };
    await mkdir(config.hytaleRoot, { recursive: true });
    await mkdir(config.backupPath, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('backs up the modern Server/universe layout, including worlds, players, and sibling save metadata', async () => {
    const universe = path.join(config.hytaleRoot, 'Server', 'universe');
    await mkdir(path.join(universe, 'worlds'), { recursive: true });
    await mkdir(path.join(universe, 'players'), { recursive: true });
    await writeFile(path.join(universe, 'worlds', 'level.dat'), 'world-data');
    await writeFile(path.join(universe, 'players', 'player.dat'), 'player-data');
    await writeFile(path.join(universe, 'metadata.json'), '{"seed":1}');

    const { createBackup } = await import('../../packages/helper/src/handlers/backup');
    const result = await createBackup(config, 'modern', randomUUID());

    expect(result.success).toBe(true);
    const entries = listArchive(path.join(config.backupPath, result.backup!.filename));
    expect(entries).toContain('universe/worlds/level.dat');
    expect(entries).toContain('universe/players/player.dat');
    expect(entries).toContain('universe/metadata.json');
  });

  it('falls back to legacy Server/worlds when the modern universe layout is absent', async () => {
    const legacyWorlds = path.join(config.hytaleRoot, 'Server', 'worlds');
    await mkdir(legacyWorlds, { recursive: true });
    await writeFile(path.join(legacyWorlds, 'level.dat'), 'legacy-world-data');

    const { createBackup } = await import('../../packages/helper/src/handlers/backup');
    const result = await createBackup(config, 'legacy', randomUUID());

    expect(result.success).toBe(true);
    const entries = listArchive(path.join(config.backupPath, result.backup!.filename));
    expect(entries).toContain('worlds/level.dat');
    expect(entries.some((entry) => entry.startsWith('universe/'))).toBe(false);
  });

  it('fails clearly when neither modern nor legacy save layout exists', async () => {
    const { createBackup } = await import('../../packages/helper/src/handlers/backup');
    const result = await createBackup(config, 'missing', randomUUID());

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      `Save data directory not found. Checked: ${path.join(config.hytaleRoot, 'Server', 'universe', 'worlds')}, ${config.worldsPath}`,
    );
  });

  it('restores a modern universe archive under Server/universe', async () => {
    const currentUniverse = path.join(config.hytaleRoot, 'Server', 'universe');
    await mkdir(path.join(currentUniverse, 'worlds'), { recursive: true });
    await writeFile(path.join(currentUniverse, 'worlds', 'level.dat'), 'old-world');

    const sourceServer = path.join(root, 'source-modern', 'Server');
    const sourceUniverse = path.join(sourceServer, 'universe');
    await mkdir(path.join(sourceUniverse, 'worlds'), { recursive: true });
    await mkdir(path.join(sourceUniverse, 'players'), { recursive: true });
    await writeFile(path.join(sourceUniverse, 'worlds', 'level.dat'), 'new-world');
    await writeFile(path.join(sourceUniverse, 'players', 'player.dat'), 'new-player');
    const archive = path.join(config.backupPath, 'modern-restore.tar.gz');
    createArchive(archive, sourceServer, 'universe');

    const { restoreBackup } = await import('../../packages/helper/src/handlers/backup');
    const result = await restoreBackup(config, 'modern-restore.tar.gz', randomUUID());

    expect(result.success).toBe(true);
    await expect(readFile(path.join(currentUniverse, 'worlds', 'level.dat'), 'utf8'))
      .resolves.toBe('new-world');
    await expect(readFile(path.join(currentUniverse, 'players', 'player.dat'), 'utf8'))
      .resolves.toBe('new-player');
  });

  it('restores a legacy worlds archive under Server/worlds', async () => {
    const currentWorlds = path.join(config.hytaleRoot, 'Server', 'worlds');
    await mkdir(currentWorlds, { recursive: true });
    await writeFile(path.join(currentWorlds, 'level.dat'), 'old-legacy-world');

    const sourceServer = path.join(root, 'source-legacy', 'Server');
    await mkdir(path.join(sourceServer, 'worlds'), { recursive: true });
    await writeFile(path.join(sourceServer, 'worlds', 'level.dat'), 'new-legacy-world');
    const archive = path.join(config.backupPath, 'legacy-restore.tar.gz');
    createArchive(archive, sourceServer, 'worlds');

    const { restoreBackup } = await import('../../packages/helper/src/handlers/backup');
    const result = await restoreBackup(config, 'legacy-restore.tar.gz', randomUUID());

    expect(result.success).toBe(true);
    await expect(readFile(path.join(currentWorlds, 'level.dat'), 'utf8'))
      .resolves.toBe('new-legacy-world');
  });

  it('rejects configured save roots that escape HYTALE_ROOT', async () => {
    const outside = path.join(root, 'outside-universe');
    await mkdir(path.join(outside, 'worlds'), { recursive: true });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const { createBackup } = await import('../../packages/helper/src/handlers/backup');
      const result = await createBackup({ ...config, hytaleSaveRoot: outside }, 'escape', randomUUID());

      expect(result.success).toBe(false);
      expect(result.error).toBe('Backup operation failed');
    } finally {
      consoleError.mockRestore();
    }
  });
});
