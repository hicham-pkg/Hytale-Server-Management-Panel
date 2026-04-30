export type HytaleUpdateAction = 'check' | 'download' | 'apply' | 'update-now' | 'cancel';
export type JobStatus = 'running' | 'success' | 'failed';
export type UpdateStatus =
  | 'unknown'
  | 'checking'
  | 'up_to_date'
  | 'update_available'
  | 'downloading'
  | 'staged'
  | 'applying'
  | 'succeeded'
  | 'failed';

export interface HytaleUpdateJob {
  jobId: string;
  kind: 'hytale-update';
  action: HytaleUpdateAction;
  step: number;
  stepName: string;
  totalSteps: number;
  status: JobStatus;
  updateStatus: UpdateStatus;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export interface HytaleUpdateOverview {
  enabled: boolean;
  status: UpdateStatus;
  latestJob: HytaleUpdateJob | null;
  lastChecked: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
  patchline: string | null;
}

export interface PrimaryUpdateAction {
  action: HytaleUpdateAction | null;
  label: string;
  confirmTitle?: string;
  confirmDescription?: string;
  confirmLabel?: string;
}

export interface HytaleUpdateUiModel {
  currentStatus: UpdateStatus;
  statusLabel: string;
  primaryAction: PrimaryUpdateAction;
  showUpdateWarning: boolean;
  showAdvancedDownload: boolean;
  showAdvancedApply: boolean;
  showAdvancedCancel: boolean;
  autoExpandLogs: boolean;
}

export const DEFAULT_ADVANCED_EXPANDED = false;
export const DEFAULT_LOGS_EXPANDED = false;

export const UPDATE_CONFIRM_DESCRIPTION =
  'This will back up your server, download/apply the Hytale update, and restart the Hytale server. Connected players may be disconnected. Mods may need updates after the update. No automatic rollback is performed in v1.';

export const APPLY_CONFIRM_DESCRIPTION =
  'This will back up your server, apply the staged Hytale update, and restart the Hytale server. Connected players may be disconnected. Mods may need updates after the update. No automatic rollback is performed in v1.';

function statusLabel(status: UpdateStatus, job: HytaleUpdateJob | null): string {
  if (job?.status === 'failed' || status === 'failed') return 'Update failed — check logs';
  if (job?.status === 'running') {
    if (status === 'downloading') return 'Downloading';
    if (status === 'applying') return 'Applying';
    return 'Checking';
  }

  switch (status) {
    case 'up_to_date':
      return 'No update found';
    case 'update_available':
      return 'Update available';
    case 'staged':
      return 'Update staged';
    case 'succeeded':
      return 'Server update completed';
    case 'checking':
      return 'Check completed';
    case 'downloading':
      return 'Download completed';
    case 'applying':
      return 'Apply completed';
    case 'unknown':
    default:
      return job?.status === 'success' ? 'Check completed' : 'Status unknown';
  }
}

function primaryActionForStatus(status: UpdateStatus, job: HytaleUpdateJob | null): PrimaryUpdateAction {
  if (job?.status === 'running') {
    return { action: null, label: 'Update job running' };
  }

  if (status === 'staged') {
    return {
      action: 'apply',
      label: 'Apply staged update',
      confirmTitle: 'Apply staged Hytale update',
      confirmDescription: APPLY_CONFIRM_DESCRIPTION,
      confirmLabel: 'Back up and apply',
    };
  }

  if (status === 'update_available') {
    return {
      action: 'update-now',
      label: 'Update Hytale Server',
      confirmTitle: 'Update Hytale Server',
      confirmDescription: UPDATE_CONFIRM_DESCRIPTION,
      confirmLabel: 'Back up and update',
    };
  }

  if (status === 'up_to_date' || status === 'succeeded' || job?.status === 'failed') {
    return { action: 'check', label: 'Check again' };
  }

  return { action: 'check', label: 'Check for update' };
}

export function getHytaleUpdateUiModel(
  overview: HytaleUpdateOverview | null,
  job: HytaleUpdateJob | null,
): HytaleUpdateUiModel {
  const currentStatus = job?.updateStatus ?? overview?.status ?? 'unknown';
  const running = job?.status === 'running';

  return {
    currentStatus,
    statusLabel: statusLabel(currentStatus, job),
    primaryAction: primaryActionForStatus(currentStatus, job),
    showUpdateWarning: currentStatus === 'update_available' || currentStatus === 'staged',
    showAdvancedDownload: currentStatus === 'update_available' && !running,
    showAdvancedApply: currentStatus === 'staged' && !running,
    showAdvancedCancel: currentStatus === 'staged' && !running,
    autoExpandLogs: job?.status === 'failed',
  };
}
