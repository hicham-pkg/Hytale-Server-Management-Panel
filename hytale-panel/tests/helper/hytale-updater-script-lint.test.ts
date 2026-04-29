import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RUNNER_PATH = path.resolve(__dirname, '../../scripts/hytale-server-updater.sh');
const TRIGGER_PATH = path.resolve(__dirname, '../../systemd/hytale-server-updater-trigger');
const UNIT_PATH = path.resolve(__dirname, '../../systemd/hytale-server-updater@.service');
const SUDOERS_PATH = path.resolve(__dirname, '../../systemd/hytale-helper.sudoers');
const COMPOSE_PATH = path.resolve(__dirname, '../../docker-compose.yml');
const INSTALL_PATH = path.resolve(__dirname, '../../install.sh');

describe('hytale-server-updater runner', () => {
  const src = fs.readFileSync(RUNNER_PATH, 'utf8');

  it('uses fixed built-in Hytale update commands only', () => {
    expect(src).toContain('send_console "/update status"');
    expect(src).toContain('send_console "/update check"');
    expect(src).toContain('send_console "/update download"');
    expect(src).toContain('send_console "/update apply --confirm"');
    expect(src).toContain('send_console "/update cancel"');
    expect(src).toContain('send_console "/update patchline"');
    expect(src).not.toMatch(/downloadUrl|curl|wget|objects\.githubusercontent|refs\/heads|archive\/main/);
  });

  it('does not use eval, shell tracing, or shell true', () => {
    expect(src).not.toMatch(/\beval\b/);
    expect(src).not.toMatch(/^set\s+-x/m);
    expect(src).not.toMatch(/shell:\s*true/);
  });

  it('requires preflight and backup before apply command', () => {
    const doApply = src.slice(src.indexOf('do_apply()'));
    const preflightIndex = doApply.indexOf('set_step 1 "preflight" "applying"');
    const backupIndex = doApply.indexOf('set_step 2 "backup" "applying"');
    const applyIndex = doApply.indexOf('send_console "/update apply --confirm"');
    expect(preflightIndex).toBeGreaterThan(-1);
    expect(backupIndex).toBeGreaterThan(preflightIndex);
    expect(applyIndex).toBeGreaterThan(backupIndex);
  });

  it('serializes execution with a flock-backed global lock', () => {
    expect(src).toMatch(/flock -n 9/);
    expect(src).toContain('another Hytale update job already holds the lock');
  });

  it('validates job ids as UUID v4 before reading job files', () => {
    expect(src).toMatch(/\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-4\[0-9a-f\]\{3\}-\[89ab\]\[0-9a-f\]\{3\}-\[0-9a-f\]\{12\}/);
  });
});

describe('hytale-server-updater trigger and unit', () => {
  const trigger = fs.readFileSync(TRIGGER_PATH, 'utf8');
  const unit = fs.readFileSync(UNIT_PATH, 'utf8');
  const sudoers = fs.readFileSync(SUDOERS_PATH, 'utf8');

  it('validates UUID before invoking systemctl', () => {
    const uuidIndex = trigger.indexOf('UUID_REGEX');
    const systemctlIndex = trigger.indexOf('exec /usr/bin/systemctl');
    expect(uuidIndex).toBeGreaterThan(-1);
    expect(systemctlIndex).toBeGreaterThan(uuidIndex);
  });

  it('uses a detached templated unit and does not auto-restart failed jobs', () => {
    expect(unit).toMatch(/^ExecStart=\/usr\/local\/lib\/hytale-panel\/hytale-server-updater run %i$/m);
    expect(unit).toMatch(/^Restart=no$/m);
  });

  it('sudoers grants only the validating wrapper, not raw systemctl on update units', () => {
    expect(sudoers).toMatch(/hytale-server-updater-trigger start \*/);
    expect(sudoers).toMatch(/hytale-server-updater-trigger stop \*/);
    expect(sudoers).toMatch(/hytale-server-updater-trigger is-active \*/);
    expect(sudoers).not.toMatch(/\/usr\/bin\/systemctl[^\n]*hytale-server-updater@/);
  });
});

describe('docker-compose Hytale update job mount', () => {
  const compose = fs.readFileSync(COMPOSE_PATH, 'utf8');

  it('mounts hytale-update-jobs read-only into the API container', () => {
    expect(compose).toMatch(
      /-\s*\/opt\/hytale-panel-data\/hytale-update-jobs:\/opt\/hytale-panel-data\/hytale-update-jobs:ro/,
    );
    expect(compose).not.toMatch(
      /-\s*\/opt\/hytale-panel-data\/hytale-update-jobs:\/opt\/hytale-panel-data\/hytale-update-jobs:rw/,
    );
  });

  it('does not mount /opt/hytale into the API container', () => {
    const lines = compose.split('\n');
    const apiStart = lines.findIndex((line) => line.trim().startsWith('api:'));
    const webStart = lines.findIndex((line) => line.trim().startsWith('web:'));
    const apiBlock = lines.slice(apiStart, webStart).join('\n');
    expect(apiBlock).not.toMatch(/^\s*-\s*\/opt\/hytale:/m);
  });
});

describe('hytale-server-updater install dependencies', () => {
  const install = fs.readFileSync(INSTALL_PATH, 'utf8');

  it('installs jq because detached updater runners parse job specs/status JSON', () => {
    expect(install).toMatch(/apt-get install -y -qq[^\n]*\bjq\b/);
  });
});
