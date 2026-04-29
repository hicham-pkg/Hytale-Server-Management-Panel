import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DOCTOR_PATH = path.resolve(__dirname, '../../scripts/doctor.sh');

describe('doctor.sh Hytale save-layout checks', () => {
  const src = fs.readFileSync(DOCTOR_PATH, 'utf8');

  it('prefers the modern Server/universe/worlds layout before legacy Server/worlds', () => {
    expect(src).toContain('HYTALE_SAVE_ROOT="$(resolve_config_value HYTALE_SAVE_ROOT "$HYTALE_ROOT/Server/universe" "$HELPER_ENV_FILE")"');
    const modernIdx = src.indexOf('modern_worlds_path="$HYTALE_SAVE_ROOT/worlds"');
    const legacyIdx = src.indexOf('elif sudo -n test -d "$WORLDS_PATH"');
    expect(modernIdx).toBeGreaterThan(-1);
    expect(legacyIdx).toBeGreaterThan(modernIdx);
  });

  it('does not warn about missing legacy Server/worlds when modern worlds exists', () => {
    expect(src).toContain('ok "modern worlds/ directory exists ($modern_worlds_path)"');
    expect(src).toContain('ok "legacy worlds/ directory exists ($WORLDS_PATH)"');
    expect(src).toContain('save worlds directory missing (checked $modern_worlds_path and $WORLDS_PATH)');
    expect(src).not.toContain('"worlds:$WORLDS_PATH:dir"');
  });

  it('surfaces modern players directory status separately', () => {
    expect(src).toContain('modern_players_path="$HYTALE_SAVE_ROOT/players"');
    expect(src).toContain('ok "modern players/ directory exists ($modern_players_path)"');
  });

  it('checks Hytale update jobs from the Hytale update job directory', () => {
    expect(src).toContain('latest_job="$(find "$HYTALE_UPDATE_JOB_DIR"');
    expect(src).not.toContain('latest_job="$(find "$PANEL_UPDATE_JOBS_DIR"');
  });

  it('checks jq because detached updater runners parse JSON specs/status files', () => {
    expect(src).toContain('command -v jq >/dev/null 2>&1');
    expect(src).toContain('jq is missing; panel and Hytale update runners parse job JSON with jq');
  });
});
