import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupStaleStagedUploads,
  sanitizeUploadedModFilename,
  stageModUpload,
} from '../../packages/api/src/services/mod.service';

const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

function streamFrom(buffer: Buffer): Readable {
  return Readable.from([buffer]);
}

describe('mod upload staging service', () => {
  let stagingDir: string;

  beforeEach(async () => {
    stagingDir = await mkdtemp(path.join(tmpdir(), 'hytale-mod-staging-'));
  });

  afterEach(async () => {
    await rm(stagingDir, { recursive: true, force: true });
  });

  it('stages a valid jar upload with a generated id filename', async () => {
    const staged = await stageModUpload({
      stream: streamFrom(Buffer.concat([ZIP_BYTES, Buffer.from('jar-body')])),
      rawFilename: 'Cool Mod.jar',
      stagingPath: stagingDir,
      maxBytes: 1024 * 1024,
    });

    expect(staged.sanitizedName).toBe('Cool_Mod.jar');
    expect(staged.extension).toBe('jar');
    expect(staged.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(staged.stagedId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await stat(path.join(stagingDir, `${staged.stagedId}.upload`))).toBeTruthy();
    expect(await stat(path.join(stagingDir, `${staged.stagedId}.json`))).toBeTruthy();
    expect(path.basename(path.join(stagingDir, `${staged.stagedId}.upload`))).not.toContain(staged.sanitizedName);
  });

  it('stages a valid zip upload', async () => {
    const staged = await stageModUpload({
      stream: streamFrom(Buffer.concat([ZIP_BYTES, Buffer.from('zip-body')])),
      rawFilename: 'map-tools.zip',
      stagingPath: stagingDir,
      maxBytes: 1024 * 1024,
    });

    expect(staged.sanitizedName).toBe('map-tools.zip');
    expect(staged.extension).toBe('zip');
  });

  it('rejects disallowed extensions before writing staged files', async () => {
    for (const name of ['script.sh', 'notes.txt', 'malware.exe']) {
      await expect(stageModUpload({
        stream: streamFrom(Buffer.concat([ZIP_BYTES, Buffer.from(name)])),
        rawFilename: name,
        stagingPath: stagingDir,
        maxBytes: 1024 * 1024,
      })).rejects.toThrow('Only .jar and .zip');
    }
  });

  it('rejects traversal filenames even when URL-encoded in the header', () => {
    expect(() => sanitizeUploadedModFilename('../../bad.jar')).toThrow('Invalid uploaded filename');
    expect(() => sanitizeUploadedModFilename('..%2Fbad.jar')).toThrow('Invalid uploaded filename');
    expect(() => sanitizeUploadedModFilename('folder%5Cbad.jar')).toThrow('Invalid uploaded filename');
  });

  it('rejects empty files, oversize bodies, and non-ZIP signatures', async () => {
    await expect(stageModUpload({
      stream: streamFrom(Buffer.alloc(0)),
      rawFilename: 'empty.jar',
      stagingPath: stagingDir,
      maxBytes: 1024,
    })).rejects.toThrow('Empty mod uploads');

    await expect(stageModUpload({
      stream: streamFrom(Buffer.concat([ZIP_BYTES, Buffer.alloc(20)])),
      rawFilename: 'big.jar',
      stagingPath: stagingDir,
      maxBytes: 8,
    })).rejects.toThrow('exceeds');

    await expect(stageModUpload({
      stream: streamFrom(Buffer.from('not-a-zip')),
      rawFilename: 'bad.jar',
      stagingPath: stagingDir,
      maxBytes: 1024,
    })).rejects.toThrow('not a valid ZIP/JAR');
  });

  it('does not derive staging paths from uploaded filenames', async () => {
    const staged = await stageModUpload({
      stream: streamFrom(Buffer.concat([ZIP_BYTES, Buffer.from('body')])),
      rawFilename: 'nested..safe.jar',
      stagingPath: stagingDir,
      maxBytes: 1024 * 1024,
    });

    const stagedPath = path.join(stagingDir, `${staged.stagedId}.upload`);
    expect(path.dirname(stagedPath)).toBe(stagingDir);
    expect(createReadStream(stagedPath).path).toBe(stagedPath);
  });

  it('cleans stale staged upload artifacts without removing fresh uploads', async () => {
    const oldId = '00000000-0000-4000-8000-000000000001';
    const freshId = '00000000-0000-4000-8000-000000000002';
    const oldUpload = path.join(stagingDir, `${oldId}.upload`);
    const oldMeta = path.join(stagingDir, `${oldId}.json`);
    const oldTmp = path.join(stagingDir, `${oldId}.upload.tmp`);
    const freshUpload = path.join(stagingDir, `${freshId}.upload`);

    await writeFile(oldUpload, ZIP_BYTES);
    await writeFile(oldMeta, '{}');
    await writeFile(oldTmp, ZIP_BYTES);
    await writeFile(freshUpload, ZIP_BYTES);

    const now = Date.now();
    const twoDaysAgo = new Date(now - 48 * 60 * 60 * 1000);
    await utimes(oldUpload, twoDaysAgo, twoDaysAgo);
    await utimes(oldMeta, twoDaysAgo, twoDaysAgo);
    await utimes(oldTmp, twoDaysAgo, twoDaysAgo);

    const result = await cleanupStaleStagedUploads(stagingDir, now);

    expect(result.removed).toBe(3);
    expect(await readdir(stagingDir)).toEqual([`${freshId}.upload`]);
  });

  it('refuses new uploads when the staging area has too many pending files', async () => {
    for (let i = 0; i < 50; i += 1) {
      await writeFile(path.join(stagingDir, `${randomUUID()}.upload`), ZIP_BYTES);
    }

    await expect(stageModUpload({
      stream: streamFrom(Buffer.concat([ZIP_BYTES, Buffer.from('quota')])),
      rawFilename: 'quota.jar',
      stagingPath: stagingDir,
      maxBytes: 1024 * 1024,
    })).rejects.toThrow('staging area is full');
  });
});
