import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PAGE_PATH = path.resolve(__dirname, '../../packages/web/src/app/hytale-updates/page.tsx');

describe('Hytale update page safety copy', () => {
  const src = fs.readFileSync(PAGE_PATH, 'utf8');

  it('warns operators about restart, player disconnects, mod updates, and no automatic rollback', () => {
    expect(src).toContain('This restarts the Hytale server. Connected players may be disconnected.');
    expect(src).toContain('Mods may need updates after a Hytale update.');
    expect(src).toContain('No automatic rollback is performed in v1');
    expect(src).toContain('Automatic rollback is not performed in v1');
  });
});
