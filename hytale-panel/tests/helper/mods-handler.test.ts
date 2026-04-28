import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HelperConfig } from '../../packages/helper/src/config';
import {
  backupMods,
  disableMod,
  enableMod,
  installStagedMod,
  listMods,
  removeMod,
  rollbackModsBackup,
} from '../../packages/helper/src/handlers/mods';

const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

describe('helper mods handler', () => {
  let root: string;
  let config: HelperConfig;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'hytale-helper-mods-'));
    config = {
      socketPath: path.join(root, 'helper.sock'),
      hmacSecret: 'x'.repeat(32),
      hytaleRoot: path.join(root, 'hytale'),
      backupPath: path.join(root, 'world-backups'),
      modsPath: path.join(root, 'hytale', 'mods'),
      disabledModsPath: path.join(root, 'hytale', 'mods-disabled'),
      modUploadStagingPath: path.join(root, 'panel-data', 'mod-upload-staging'),
      modBackupPath: path.join(root, 'hytale', 'mod-backups'),
      modBackupRetention: 10,
      serviceName: 'hytale-tmux.service',
      tmuxSession: 'hytale',
      tmuxSocketPath: path.join(root, 'hytale', 'run', 'hytale.tmux.sock'),
      whitelistPath: path.join(root, 'hytale', 'Server', 'whitelist.json'),
      bansPath: path.join(root, 'hytale', 'Server', 'bans.json'),
      worldsPath: path.join(root, 'hytale', 'Server', 'worlds'),
    };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeStagedMod(body = 'mod-body', sanitizedName = 'staged.jar') {
    const stagedId = randomUUID();
    const buffer = Buffer.concat([ZIP_BYTES, Buffer.from(body)]);
    const digest = sha256(buffer);
    await mkdir(config.modUploadStagingPath, { recursive: true });
    await writeFile(path.join(config.modUploadStagingPath, `${stagedId}.upload`), buffer, { flag: 'wx' });
    await writeFile(path.join(config.modUploadStagingPath, `${stagedId}.json`), JSON.stringify({
      stagedId,
      sanitizedName,
      sha256: digest,
    }));
    return { stagedId, sha256: digest, buffer };
  }

  it('lists active and disabled mods with size and sha256 metadata', async () => {
    await mkdir(config.modsPath, { recursive: true });
    await writeFile(path.join(config.modsPath, 'active.jar'), Buffer.concat([ZIP_BYTES, Buffer.from('active')]), { flag: 'wx' });
    await mkdir(config.disabledModsPath, { recursive: true });
    await writeFile(path.join(config.disabledModsPath, 'disabled.zip'), Buffer.concat([ZIP_BYTES, Buffer.from('disabled')]), { flag: 'wx' });

    const result = await listMods(config);

    expect(result.active).toHaveLength(1);
    expect(result.disabled).toHaveLength(1);
    expect(result.active[0]).toMatchObject({ name: 'active.jar', status: 'active' });
    expect(result.disabled[0]).toMatchObject({ name: 'disabled.zip', status: 'disabled' });
    expect(result.active[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('installs a staged mod and removes staged artifacts', async () => {
    const staged = await writeStagedMod('install', 'cool.jar');

    const result = await installStagedMod(config, staged.stagedId, 'cool.jar', staged.sha256, false);

    expect(result.mod).toMatchObject({ name: 'cool.jar', status: 'active', sha256: staged.sha256 });
    expect(await readFile(path.join(config.modsPath, 'cool.jar'))).toEqual(staged.buffer);
    await expect(stat(path.join(config.modUploadStagingPath, `${staged.stagedId}.upload`))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.backupName).toContain('install-cool_jar');
  });

  it('blocks duplicate installs unless replace=true', async () => {
    const first = await writeStagedMod('first', 'same.jar');
    await installStagedMod(config, first.stagedId, 'same.jar', first.sha256, false);

    const second = await writeStagedMod('second', 'same.jar');
    await expect(installStagedMod(config, second.stagedId, 'same.jar', second.sha256, false))
      .rejects.toThrow('already exists');

    const replaced = await installStagedMod(config, second.stagedId, 'same.jar', second.sha256, true);
    expect(replaced.mod.sha256).toBe(second.sha256);
    expect(await readFile(path.join(config.modsPath, 'same.jar'))).toEqual(second.buffer);
  });

  it('binds helper install to the staged metadata filename and checksum', async () => {
    const staged = await writeStagedMod('bound', 'bound.jar');

    await expect(installStagedMod(config, staged.stagedId, 'other.jar', staged.sha256, false))
      .rejects.toThrow('metadata mismatch');
    await expect(stat(path.join(config.modUploadStagingPath, `${staged.stagedId}.upload`))).rejects.toMatchObject({ code: 'ENOENT' });

    const checksumMismatch = await writeStagedMod('bound-again', 'bound.jar');
    await expect(installStagedMod(config, checksumMismatch.stagedId, 'bound.jar', 'a'.repeat(64), false))
      .rejects.toThrow('metadata mismatch');
    await expect(stat(path.join(config.modUploadStagingPath, `${checksumMismatch.stagedId}.upload`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans staged artifacts when checksum validation fails', async () => {
    const staged = await writeStagedMod('original', 'checksum.jar');
    await writeFile(path.join(config.modUploadStagingPath, `${staged.stagedId}.upload`), Buffer.concat([
      ZIP_BYTES,
      Buffer.from('tampered'),
    ]));

    await expect(installStagedMod(config, staged.stagedId, 'checksum.jar', staged.sha256, false))
      .rejects.toThrow('checksum mismatch');
    await expect(stat(path.join(config.modUploadStagingPath, `${staged.stagedId}.upload`))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(config.modUploadStagingPath, `${staged.stagedId}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('moves mods between active and disabled directories', async () => {
    const staged = await writeStagedMod('toggle', 'toggle.jar');
    await installStagedMod(config, staged.stagedId, 'toggle.jar', staged.sha256, false);

    await disableMod(config, 'toggle.jar');
    await expect(stat(path.join(config.modsPath, 'toggle.jar'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await stat(path.join(config.disabledModsPath, 'toggle.jar'))).toBeTruthy();

    await enableMod(config, 'toggle.jar');
    expect(await stat(path.join(config.modsPath, 'toggle.jar'))).toBeTruthy();
    await expect(stat(path.join(config.disabledModsPath, 'toggle.jar'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a mod only after creating a backup snapshot', async () => {
    const staged = await writeStagedMod('delete-me', 'delete-me.jar');
    await installStagedMod(config, staged.stagedId, 'delete-me.jar', staged.sha256, false);

    const result = await removeMod(config, 'delete-me.jar');

    expect(result.removedFrom).toBe('active');
    await expect(stat(path.join(config.modsPath, 'delete-me.jar'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await stat(path.join(config.modBackupPath, result.backupName, 'mods', 'delete-me.jar'))).toBeTruthy();
  });

  it('backs up disabled mods before removing them', async () => {
    const staged = await writeStagedMod('disabled-delete', 'disabled-delete.jar');
    await installStagedMod(config, staged.stagedId, 'disabled-delete.jar', staged.sha256, false);
    await disableMod(config, 'disabled-delete.jar');

    const result = await removeMod(config, 'disabled-delete.jar');

    expect(result.removedFrom).toBe('disabled');
    expect(await stat(path.join(config.modBackupPath, result.backupName, 'mods-disabled', 'disabled-delete.jar'))).toBeTruthy();
  });

  it('rolls back to a previous mods backup', async () => {
    await mkdir(config.modsPath, { recursive: true });
    await writeFile(path.join(config.modsPath, 'old.jar'), Buffer.concat([ZIP_BYTES, Buffer.from('old')]));
    const backup = await backupMods(config, 'manual');

    await rm(path.join(config.modsPath, 'old.jar'));
    await writeFile(path.join(config.modsPath, 'new.jar'), Buffer.concat([ZIP_BYTES, Buffer.from('new')]));

    await rollbackModsBackup(config, backup.backupName);

    expect(await stat(path.join(config.modsPath, 'old.jar'))).toBeTruthy();
    await expect(stat(path.join(config.modsPath, 'new.jar'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores disabled mods on rollback', async () => {
    await mkdir(config.modsPath, { recursive: true });
    await mkdir(config.disabledModsPath, { recursive: true });
    await writeFile(path.join(config.disabledModsPath, 'disabled-old.jar'), Buffer.concat([ZIP_BYTES, Buffer.from('disabled-old')]));
    const backup = await backupMods(config, 'manual');

    await rm(path.join(config.disabledModsPath, 'disabled-old.jar'));
    await writeFile(path.join(config.disabledModsPath, 'disabled-new.jar'), Buffer.concat([ZIP_BYTES, Buffer.from('disabled-new')]));

    await rollbackModsBackup(config, backup.backupName);

    expect(await stat(path.join(config.disabledModsPath, 'disabled-old.jar'))).toBeTruthy();
    await expect(stat(path.join(config.disabledModsPath, 'disabled-new.jar'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not restore symlinks from a mods backup snapshot', async () => {
    const backupName = `2026-04-28T00-00-00-000Z_manual_${randomUUID()}`;
    const backupModsPath = path.join(config.modBackupPath, backupName, 'mods');
    const outsidePath = path.join(root, 'outside.jar');
    await mkdir(backupModsPath, { recursive: true });
    await writeFile(outsidePath, Buffer.concat([ZIP_BYTES, Buffer.from('outside')]));
    await symlink(outsidePath, path.join(backupModsPath, 'evil.jar'));

    await rollbackModsBackup(config, backupName);

    await expect(stat(path.join(config.modsPath, 'evil.jar'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes concurrent installs so duplicate final names cannot both succeed', async () => {
    const first = await writeStagedMod('race-one', 'race.jar');
    const second = await writeStagedMod('race-two', 'race.jar');

    const results = await Promise.allSettled([
      installStagedMod(config, first.stagedId, 'race.jar', first.sha256, false),
      installStagedMod(config, second.stagedId, 'race.jar', second.sha256, false),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const mods = await listMods(config);
    expect(mods.active.map((mod) => mod.name)).toEqual(['race.jar']);
  });

  it('rejects unsafe staged ids and mod names before touching managed paths', async () => {
    await expect(installStagedMod(config, '../../bad', 'bad.jar', 'a'.repeat(64), false))
      .rejects.toThrow('Invalid staged mod id');
    await expect(installStagedMod(config, randomUUID(), '../bad.jar', 'a'.repeat(64), false))
      .rejects.toThrow('Invalid mod filename');
    await expect(disableMod(config, 'subdir/bad.jar')).rejects.toThrow('Invalid mod filename');
    await expect(enableMod(config, '.hidden.jar')).rejects.toThrow('Invalid mod filename');
  });

  it('rejects staged files that resolve outside the upload staging directory', async () => {
    const stagedId = randomUUID();
    const outsidePath = path.join(root, 'outside.jar');
    const buffer = Buffer.concat([ZIP_BYTES, Buffer.from('outside')]);
    await mkdir(config.modUploadStagingPath, { recursive: true });
    await writeFile(outsidePath, buffer);
    await symlink(outsidePath, path.join(config.modUploadStagingPath, `${stagedId}.upload`));
    await writeFile(path.join(config.modUploadStagingPath, `${stagedId}.json`), JSON.stringify({
      stagedId,
      sanitizedName: 'outside.jar',
      sha256: sha256(buffer),
    }));

    await expect(installStagedMod(config, stagedId, 'outside.jar', sha256(buffer), false))
      .rejects.toThrow('Symlink traversal blocked');
  });

  it('prunes old backups according to retention', async () => {
    config.modBackupRetention = 2;
    await mkdir(config.modsPath, { recursive: true });
    await writeFile(path.join(config.modsPath, 'keep.jar'), Buffer.concat([ZIP_BYTES, Buffer.from('keep')]));

    await backupMods(config, 'one');
    await backupMods(config, 'two');
    await backupMods(config, 'three');

    const backups = await readdir(config.modBackupPath);
    expect(backups).toHaveLength(2);
  });
});
