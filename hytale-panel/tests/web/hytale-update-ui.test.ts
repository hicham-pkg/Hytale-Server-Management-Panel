import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isAdminOnlyPath } from '../../packages/web/src/lib/auth-session';
import {
  DEFAULT_ADVANCED_EXPANDED,
  DEFAULT_LOGS_EXPANDED,
  APPLY_CONFIRM_DESCRIPTION,
  UPDATE_CONFIRM_DESCRIPTION,
  getHytaleUpdateUiModel,
  type HytaleUpdateJob,
  type HytaleUpdateOverview,
  type UpdateStatus,
} from '../../packages/web/src/lib/hytale-update-ui';

const PAGE_PATH = path.resolve(__dirname, '../../packages/web/src/app/hytale-updates/page.tsx');

function overview(status: UpdateStatus): HytaleUpdateOverview {
  return {
    enabled: true,
    status,
    latestJob: null,
    lastChecked: status === 'unknown' ? null : '2026-04-30T00:00:00.000Z',
    currentVersion: null,
    latestVersion: null,
    patchline: null,
  };
}

function job(status: UpdateStatus, jobStatus: HytaleUpdateJob['status'] = 'success'): HytaleUpdateJob {
  return {
    jobId: '11111111-1111-4111-8111-111111111111',
    kind: 'hytale-update',
    action: status === 'staged' ? 'download' : 'check',
    step: 1,
    stepName: 'done',
    totalSteps: 1,
    status: jobStatus,
    updateStatus: status,
    startedAt: '2026-04-30T00:00:00.000Z',
    endedAt: jobStatus === 'running' ? null : '2026-04-30T00:01:00.000Z',
    error: jobStatus === 'failed' ? 'boom' : null,
  };
}

describe('Hytale update page flow model', () => {
  it('unknown state shows only Check for update as the primary action', () => {
    const model = getHytaleUpdateUiModel(overview('unknown'), null);
    expect(model.statusLabel).toBe('Status unknown');
    expect(model.primaryAction).toMatchObject({ action: 'check', label: 'Check for update' });
    expect(model.showAdvancedDownload).toBe(false);
    expect(model.showAdvancedApply).toBe(false);
    expect(model.showAdvancedCancel).toBe(false);
  });

  it('up-to-date state shows only Check again and does not imply update actions', () => {
    const model = getHytaleUpdateUiModel(overview('up_to_date'), null);
    expect(model.statusLabel).toBe('No update found');
    expect(model.primaryAction).toMatchObject({ action: 'check', label: 'Check again' });
    expect(model.showAdvancedDownload).toBe(false);
    expect(model.showAdvancedApply).toBe(false);
    expect(model.showAdvancedCancel).toBe(false);
  });

  it('update-available state shows Update Hytale Server as the primary action', () => {
    const model = getHytaleUpdateUiModel(overview('update_available'), null);
    expect(model.statusLabel).toBe('Update available');
    expect(model.primaryAction).toMatchObject({
      action: 'update-now',
      label: 'Update Hytale Server',
      confirmLabel: 'Back up and update',
    });
    expect(model.showAdvancedDownload).toBe(true);
    expect(model.showAdvancedApply).toBe(false);
    expect(model.showAdvancedCancel).toBe(false);
  });

  it('staged state shows Apply staged update as the primary action', () => {
    const model = getHytaleUpdateUiModel(overview('unknown'), job('staged'));
    expect(model.statusLabel).toBe('Update staged');
    expect(model.primaryAction).toMatchObject({
      action: 'apply',
      label: 'Apply staged update',
      confirmLabel: 'Back up and apply',
    });
    expect(model.showAdvancedDownload).toBe(false);
    expect(model.showAdvancedApply).toBe(true);
    expect(model.showAdvancedCancel).toBe(true);
  });

  it('keeps advanced actions and logs collapsed by default', () => {
    expect(DEFAULT_ADVANCED_EXPANDED).toBe(false);
    expect(DEFAULT_LOGS_EXPANDED).toBe(false);
  });

  it('auto-expands technical logs when the latest job fails', () => {
    const model = getHytaleUpdateUiModel(overview('unknown'), job('failed', 'failed'));
    expect(model.statusLabel).toBe('Update failed — check logs');
    expect(model.autoExpandLogs).toBe(true);
  });

  it('does not expose Apply or Cancel actions unless an update is staged', () => {
    for (const status of ['unknown', 'up_to_date', 'update_available', 'succeeded'] as const) {
      const model = getHytaleUpdateUiModel(overview(status), null);
      expect(model.primaryAction.action).not.toBe('apply');
      expect(model.primaryAction.action).not.toBe('cancel');
      expect(model.showAdvancedApply).toBe(false);
      expect(model.showAdvancedCancel).toBe(false);
    }
  });

  it('keeps the page admin-only so readonly users cannot reach mutation controls', () => {
    expect(isAdminOnlyPath('/hytale-updates')).toBe(true);
  });
});

describe('Hytale update page safety copy', () => {
  const src = fs.readFileSync(PAGE_PATH, 'utf8');

  it('warns operators about restart, player disconnects, mod updates, and no automatic rollback', () => {
    expect(UPDATE_CONFIRM_DESCRIPTION).toContain('restart the Hytale server');
    expect(UPDATE_CONFIRM_DESCRIPTION).toContain('Connected players may be disconnected');
    expect(UPDATE_CONFIRM_DESCRIPTION).toContain('Mods may need updates after the update');
    expect(UPDATE_CONFIRM_DESCRIPTION).toContain('No automatic rollback is performed in v1');
    expect(APPLY_CONFIRM_DESCRIPTION).toContain('apply the staged Hytale update');
  });

  it('keeps technical sections collapsed behind explicit controls', () => {
    expect(src).toContain('Advanced actions');
    expect(src).toContain('Show technical logs');
    expect(src).toContain('Raw update status');
  });
});
