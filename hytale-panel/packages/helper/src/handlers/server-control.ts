import { runAllowlistedCommand, safeExec } from '../utils/command';
import type { HelperConfig } from '../config';
import { tmuxExec } from '../utils/tmux';
import { enqueueGlobalOperation } from '../utils/operation-lock';

function formatElapsedSeconds(elapsedSeconds: number | null): string | null {
  if (elapsedSeconds === null || Number.isNaN(elapsedSeconds) || elapsedSeconds < 0) {
    return null;
  }

  const days = Math.floor(elapsedSeconds / 86_400);
  const hours = Math.floor((elapsedSeconds % 86_400) / 3_600);
  const minutes = Math.floor((elapsedSeconds % 3_600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function truncateMessage(message: string): string {
  return message.trim().slice(0, 200) || 'Unknown error';
}

const START_RUNTIME_APPEAR_TIMEOUT_MS = 30_000;
const START_RUNTIME_STABILITY_WINDOW_MS = 5_000;

// Force the C locale so `extractSystemdStatus` sees English strings like
// "active (running)" and "since X; Y ago" regardless of the host LANG setting.
const SYSTEMCTL_STATUS_OPTS = { env: { LC_ALL: 'C', LANG: 'C' } } as const;

function extractRecentLauncherFailure(output: string): string | null {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const keywords = [
    'filesystemexception',
    'read-only file system',
    'could not',
    'unable to',
    'failed',
    'error',
    'exception',
    'permission denied',
    'no such file',
  ];

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const normalized = line.toLowerCase();

    if (
      normalized.includes('started hytale') ||
      normalized.includes('starting hytale') ||
      normalized.includes('stopped hytale')
    ) {
      continue;
    }

    if (keywords.some((keyword) => normalized.includes(keyword))) {
      return truncateMessage(line);
    }
  }

  return null;
}

async function getRecentLauncherFailure(config: HelperConfig): Promise<string | null> {
  const result = await runAllowlistedCommand('/usr/bin/journalctl', [
    '-u',
    config.serviceName,
    '--no-pager',
    '-o',
    'cat',
    '-n',
    '40',
  ]);

  if (result.exitCode !== 0) {
    return null;
  }

  return extractRecentLauncherFailure(`${result.stdout}\n${result.stderr}`);
}

function buildStartFailureMessage(baseMessage: string, launcherFailure: string | null): string {
  if (launcherFailure) {
    return `${baseMessage} Recent launcher error: ${launcherFailure}`;
  }

  return `${baseMessage} Run scripts/doctor.sh --repair on the VPS.`;
}

function extractSystemdStatus(output: string): {
  unitFound: boolean;
  active: boolean;
  failed: boolean;
  uptime: string | null;
  lastRestart: string | null;
} {
  const active = output.includes('active (running)') || output.includes('active (exited)');
  const failed = output.includes('Active: failed') || output.includes('Result: exit-code');
  const sinceMatch = output.match(/since\s+(.+?);\s+(.+?)\s+ago/);
  return {
    unitFound: !output.includes('could not be found') && !output.includes('not loaded'),
    active,
    failed,
    uptime: sinceMatch?.[2] ?? null,
    lastRestart: sinceMatch?.[1] ?? null,
  };
}

interface ProcessSnapshot {
  pid: number;
  ppid: number;
  state: string;
  elapsedSeconds: number | null;
  commandName: string;
  command: string;
}

interface RuntimeDetectionResult {
  sessionExists: boolean;
  process: ProcessSnapshot | null;
}

export interface ManagedRuntimeProcess {
  pid: number;
  elapsedSeconds: number | null;
}

function isRuntimeRunning(runtime: RuntimeDetectionResult): boolean {
  return runtime.sessionExists && runtime.process !== null && !runtime.process.state.toUpperCase().includes('Z');
}

function isRuntimeStopped(runtime: RuntimeDetectionResult): boolean {
  return !runtime.sessionExists && runtime.process === null;
}

function logStartBranch(message: string) {
  console.info(`[helper server.start] ${message}`);
}

function isZombieProcess(process: ProcessSnapshot): boolean {
  return process.state.toUpperCase().includes('Z');
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function hasTmuxSession(config: HelperConfig): Promise<boolean> {
  const result = await tmuxExec(config, ['has-session', '-t', config.tmuxSession]);
  return result.exitCode === 0;
}

async function listTmuxPanePids(config: HelperConfig): Promise<number[]> {
  const result = await tmuxExec(config, ['list-panes', '-t', config.tmuxSession, '-F', '#{pane_pid}']);
  if (result.exitCode !== 0) {
    return [];
  }

  return result.stdout
    .trim()
    .split('\n')
    .map((value) => parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function parseProcessSnapshot(stdout: string): ProcessSnapshot[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line): ProcessSnapshot[] => {
      const parts = line.split(/\s+/);
      if (parts.length < 4) {
        return [];
      }

      const pid = parseInt(parts[0], 10);
      const ppid = parseInt(parts[1], 10);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) {
        return [];
      }

      let offset = 2;
      let state = '';
      if (!/^\d+$/.test(parts[offset] ?? '')) {
        state = parts[offset] ?? '';
        offset += 1;
      }

      const elapsedSeconds = parseInt(parts[offset] ?? '', 10);
      const commandName = parts[offset + 1] ?? '';
      const command = parts.slice(offset + 2).join(' ');
      if (!Number.isFinite(elapsedSeconds) || !commandName) {
        return [];
      }

      return [{
        pid,
        ppid,
        state,
        elapsedSeconds,
        commandName,
        command,
      }];
    });
}

function collectDescendantProcessIds(
  processes: ProcessSnapshot[],
  rootPids: number[]
): Set<number> {
  const childrenByParent = new Map<number, number[]>();
  for (const process of processes) {
    const siblings = childrenByParent.get(process.ppid) ?? [];
    siblings.push(process.pid);
    childrenByParent.set(process.ppid, siblings);
  }

  const queue = [...rootPids];
  const descendants = new Set<number>(rootPids);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const children = childrenByParent.get(current) ?? [];
    for (const child of children) {
      if (!descendants.has(child)) {
        descendants.add(child);
        queue.push(child);
      }
    }
  }

  return descendants;
}

function isLikelyHytaleJavaProcess(process: ProcessSnapshot, config: HelperConfig): boolean {
  if (isZombieProcess(process)) {
    return false;
  }

  const commandName = process.commandName.toLowerCase();
  if (!commandName.startsWith('java')) {
    return false;
  }

  const normalized = process.command.toLowerCase();
  const root = config.hytaleRoot.toLowerCase();
  return (
    normalized.includes('-jar') &&
    (
      normalized.includes('hytaleserver.jar') ||
      (normalized.includes('server.jar') && normalized.includes(root))
    )
  );
}

async function detectTmuxRuntime(config: HelperConfig): Promise<RuntimeDetectionResult> {
  const sessionExists = await hasTmuxSession(config);
  if (!sessionExists) {
    return { sessionExists: false, process: null };
  }

  const panePids = await listTmuxPanePids(config);
  if (panePids.length === 0) {
    return { sessionExists: true, process: null };
  }

  const psResult = await safeExec('/usr/bin/ps', ['-eo', 'pid=,ppid=,state=,etimes=,comm=,args=']);
  if (psResult.exitCode !== 0) {
    return { sessionExists: true, process: null };
  }

  const processes = parseProcessSnapshot(psResult.stdout);
  const descendants = collectDescendantProcessIds(processes, panePids);

  const descendantProcesses = processes.filter((process) => descendants.has(process.pid));
  const javaProcess =
    descendantProcesses.find((process) => isLikelyHytaleJavaProcess(process, config)) ??
    null;

  if (javaProcess) {
    return { sessionExists: true, process: javaProcess };
  }
  return { sessionExists: true, process: null };
}

export async function getManagedRuntimeProcess(config: HelperConfig): Promise<ManagedRuntimeProcess | null> {
  const runtime = await detectTmuxRuntime(config);
  if (!isRuntimeRunning(runtime) || !runtime.process) {
    return null;
  }

  return {
    pid: runtime.process.pid,
    elapsedSeconds: runtime.process.elapsedSeconds,
  };
}

async function waitForRuntimeState(
  config: HelperConfig,
  desiredState: 'running' | 'stopped',
  timeoutMs: number
): Promise<RuntimeDetectionResult> {
  const deadline = Date.now() + timeoutMs;
  let latest = await detectTmuxRuntime(config);

  while (Date.now() <= deadline) {
    if (desiredState === 'running' && isRuntimeRunning(latest)) {
      return latest;
    }

    if (desiredState === 'stopped' && isRuntimeStopped(latest)) {
      return latest;
    }

    await sleep(1_000);
    latest = await detectTmuxRuntime(config);
  }

  return latest;
}

async function detectStableRuntime(
  config: HelperConfig,
  attempts = 3,
  delayMs = 1_000
): Promise<RuntimeDetectionResult> {
  let latest = await detectTmuxRuntime(config);
  if (!isRuntimeRunning(latest) || attempts <= 1) {
    return latest;
  }

  for (let attempt = 1; attempt < attempts; attempt += 1) {
    await sleep(delayMs);
    latest = await detectTmuxRuntime(config);
    if (!isRuntimeRunning(latest)) {
      return latest;
    }
  }

  return latest;
}

async function verifyRuntimeStability(
  config: HelperConfig,
  windowMs = START_RUNTIME_STABILITY_WINDOW_MS
): Promise<RuntimeDetectionResult> {
  await sleep(windowMs);
  return detectTmuxRuntime(config);
}

async function clearStaleTmuxSession(config: HelperConfig): Promise<{ success: boolean; message?: string }> {
  const sessionExists = await hasTmuxSession(config);
  if (!sessionExists) {
    return { success: true };
  }

  const killResult = await tmuxExec(config, ['kill-session', '-t', config.tmuxSession]);
  if (killResult.exitCode !== 0 && !killResult.stderr.includes('can\'t find session')) {
    return { success: false, message: `Failed to remove stale tmux session: ${truncateMessage(killResult.stderr)}` };
  }

  return { success: true };
}

async function reconcileSystemdStoppedState(
  config: HelperConfig,
  serviceStatus: ReturnType<typeof extractSystemdStatus>
): Promise<{ success: boolean; reconciled: boolean; message?: string }> {
  if (!serviceStatus.unitFound) {
    return { success: true, reconciled: false };
  }

  const stopResult = await runAllowlistedCommand('/usr/bin/systemctl', ['stop', config.serviceName]);
  if (stopResult.exitCode !== 0 && serviceStatus.active) {
    return {
      success: false,
      reconciled: false,
      message: `Failed to reconcile stopped service state: ${truncateMessage(stopResult.stderr)}`,
    };
  }

  const resetResult = await runAllowlistedCommand('/usr/bin/systemctl', ['reset-failed', config.serviceName]);
  if (resetResult.exitCode !== 0) {
    return {
      success: false,
      reconciled: false,
      message: `Failed to clear stale systemd state: ${truncateMessage(resetResult.stderr)}`,
    };
  }

  return { success: true, reconciled: serviceStatus.active || serviceStatus.failed };
}

async function stopTmuxRuntime(config: HelperConfig): Promise<{ success: boolean; message: string }> {
  const sessionExists = await hasTmuxSession(config);
  if (!sessionExists) {
    return { success: true, message: 'Server is already stopped' };
  }

  await tmuxExec(config, ['send-keys', '-t', config.tmuxSession, 'save', 'Enter']);
  await sleep(5_000);

  const cleared = await clearStaleTmuxSession(config);
  if (!cleared.success) {
    return { success: false, message: cleared.message ?? 'Failed to stop via tmux' };
  }

  return { success: true, message: 'Server stop command issued' };
}

async function _startServer(config: HelperConfig): Promise<{ success: boolean; message: string }> {
  const statusResult = await runAllowlistedCommand('/usr/bin/systemctl', ['status', config.serviceName], SYSTEMCTL_STATUS_OPTS);
  const serviceStatus = extractSystemdStatus(statusResult.stdout + statusResult.stderr);
  const runtime = await detectStableRuntime(config, 3, 1_000);

  if (isRuntimeRunning(runtime)) {
    const message = 'Server is already running (tmux session and Hytale JVM were both confirmed on repeated checks)';
    logStartBranch(`already-running shortcut taken: ${message}`);
    return { success: true, message };
  }

  logStartBranch(
    `runtime pre-check did not confirm a managed runtime (tmuxSession=${runtime.sessionExists}, javaPid=${runtime.process?.pid ?? 'none'}); continuing with launcher path`
  );

  let reconciled = false;

  if (runtime.sessionExists && runtime.process === null) {
    logStartBranch('stale tmux session detected without a managed JVM; clearing before restart');
    const cleared = await clearStaleTmuxSession(config);
    if (!cleared.success) {
      const message = cleared.message ?? 'Failed to clear stale tmux session';
      logStartBranch(`aborting before launcher restart: ${message}`);
      return { success: false, message };
    }
    reconciled = true;
  }

  if (serviceStatus.unitFound && (serviceStatus.active || serviceStatus.failed || reconciled)) {
    logStartBranch('reconciling launcher state before restart');
    const reconcileResult = await reconcileSystemdStoppedState(config, serviceStatus);
    if (!reconcileResult.success) {
      const message = reconcileResult.message ?? 'Failed to reconcile stale systemd state before start';
      logStartBranch(`aborting before launcher restart: ${message}`);
      return {
        success: false,
        message,
      };
    }
    reconciled = reconciled || reconcileResult.reconciled;
  }

  logStartBranch(`invoking launcher restart: systemctl restart ${config.serviceName}`);
  const result = await runAllowlistedCommand('/usr/bin/systemctl', ['restart', config.serviceName]);
  if (result.exitCode !== 0) {
    const message = `Failed to restart launcher service: ${truncateMessage(result.stderr)}`;
    logStartBranch(`launcher restart failed immediately: ${message}`);
    return { success: false, message };
  }

  const startedRuntime = await waitForRuntimeState(config, 'running', START_RUNTIME_APPEAR_TIMEOUT_MS);
  if (!isRuntimeRunning(startedRuntime)) {
    const launcherFailure = await getRecentLauncherFailure(config);
    const message = buildStartFailureMessage(
      'Start command returned, but no managed Hytale Java runtime appeared on the shared tmux socket.',
      launcherFailure
    );
    logStartBranch(
      `wait-for-runtime failure: tmux session and Hytale JVM did not appear before timeout${launcherFailure ? `; recent launcher error: ${launcherFailure}` : ''}`
    );
    return {
      success: false,
      message,
    };
  }

  logStartBranch(
    `runtime appeared with pid=${startedRuntime.process?.pid ?? 'unknown'}; waiting ${START_RUNTIME_STABILITY_WINDOW_MS}ms to confirm it survives startup`
  );
  const stableRuntime = await verifyRuntimeStability(config);
  if (!isRuntimeRunning(stableRuntime)) {
    const launcherFailure = await getRecentLauncherFailure(config);
    const message = buildStartFailureMessage(
      'The managed Hytale runtime appeared but died during startup.',
      launcherFailure
    );
    logStartBranch(
      `wait-for-runtime failure: runtime disappeared during the startup stability window${launcherFailure ? `; recent launcher error: ${launcherFailure}` : ''}`
    );
    return { success: false, message };
  }

  if (reconciled) {
    const message = 'Stale runtime state was reconciled and the server started successfully';
    logStartBranch(`wait-for-runtime success: ${message}`);
    return { success: true, message };
  }

  const message = 'Server started successfully';
  logStartBranch(`wait-for-runtime success: ${message}`);
  return { success: true, message };
}

async function _stopServer(config: HelperConfig): Promise<{ success: boolean; message: string }> {
  const statusResult = await runAllowlistedCommand('/usr/bin/systemctl', ['status', config.serviceName], SYSTEMCTL_STATUS_OPTS);
  const serviceStatus = extractSystemdStatus(statusResult.stdout + statusResult.stderr);
  const runtime = await detectTmuxRuntime(config);

  if (isRuntimeStopped(runtime)) {
    if (serviceStatus.unitFound && (serviceStatus.active || serviceStatus.failed)) {
      const reconcileResult = await reconcileSystemdStoppedState(config, serviceStatus);
      if (!reconcileResult.success) {
        return { success: false, message: reconcileResult.message ?? 'Failed to reconcile stopped service state' };
      }

      return {
        success: true,
        message: reconcileResult.reconciled
          ? 'Server was already stopped; stale systemd state was reconciled'
          : 'Server is already stopped',
      };
    }

    return { success: true, message: 'Server is already stopped' };
  }

  const result = await runAllowlistedCommand('/usr/bin/systemctl', ['stop', config.serviceName]);
  if (result.exitCode === 0) {
    const stoppedRuntime = await waitForRuntimeState(config, 'stopped', 10_000);
    if (isRuntimeStopped(stoppedRuntime)) {
      const reconcileResult = await reconcileSystemdStoppedState(config, serviceStatus);
      if (!reconcileResult.success) {
        return { success: false, message: reconcileResult.message ?? 'Failed to reconcile stopped service state' };
      }

      return {
        success: true,
        message: reconcileResult.reconciled
          ? 'Server stop completed and stale systemd state was reconciled'
          : 'Server stopped successfully',
      };
    }
  }

  const tmuxStopResult = await stopTmuxRuntime(config);
  if (!tmuxStopResult.success) {
    return tmuxStopResult;
  }

  const stoppedRuntime = await waitForRuntimeState(config, 'stopped', 5_000);
  if (!isRuntimeStopped(stoppedRuntime)) {
    return {
      success: false,
      message: 'The tmux session was asked to stop, but the runtime is still present. Run scripts/doctor.sh --repair on the VPS.',
    };
  }

  const reconcileResult = await reconcileSystemdStoppedState(config, serviceStatus);
  if (!reconcileResult.success) {
    return { success: false, message: reconcileResult.message ?? 'Failed to reconcile stopped service state' };
  }

  return {
    success: true,
    message: reconcileResult.reconciled
      ? 'Server stop completed and stale systemd state was reconciled'
      : 'Server stopped successfully',
  };
}

async function _restartServer(config: HelperConfig): Promise<{ success: boolean; message: string }> {
  // Direct restart: let systemd transition stop→start in one operation instead
  // of running two sequential lifecycle dances. Falls back to stop-then-start
  // if no systemd unit is registered (tmux-only deployments).
  const statusResult = await runAllowlistedCommand(
    '/usr/bin/systemctl',
    ['status', config.serviceName],
    SYSTEMCTL_STATUS_OPTS
  );
  const serviceStatus = extractSystemdStatus(statusResult.stdout + statusResult.stderr);

  if (!serviceStatus.unitFound) {
    const stopResult = await _stopServer(config);
    if (!stopResult.success) return stopResult;
    const startResult = await _startServer(config);
    if (!startResult.success) return startResult;
    return { success: true, message: 'Server restarted (tmux path; no systemd unit found)' };
  }

  const restartResult = await runAllowlistedCommand('/usr/bin/systemctl', ['restart', config.serviceName]);
  if (restartResult.exitCode !== 0) {
    return { success: false, message: `Failed to restart launcher service: ${truncateMessage(restartResult.stderr)}` };
  }

  const startedRuntime = await waitForRuntimeState(config, 'running', START_RUNTIME_APPEAR_TIMEOUT_MS);
  if (!isRuntimeRunning(startedRuntime)) {
    const launcherFailure = await getRecentLauncherFailure(config);
    return {
      success: false,
      message: buildStartFailureMessage(
        'Restart issued, but no managed Hytale Java runtime appeared on the shared tmux socket.',
        launcherFailure
      ),
    };
  }

  const stableRuntime = await verifyRuntimeStability(config);
  if (!isRuntimeRunning(stableRuntime)) {
    const launcherFailure = await getRecentLauncherFailure(config);
    return {
      success: false,
      message: buildStartFailureMessage(
        'The managed Hytale runtime appeared after restart but died during startup.',
        launcherFailure
      ),
    };
  }

  return { success: true, message: 'Server restarted successfully' };
}

export function startServer(config: HelperConfig): Promise<{ success: boolean; message: string }> {
  return enqueueGlobalOperation(() => _startServer(config));
}

export function stopServer(config: HelperConfig): Promise<{ success: boolean; message: string }> {
  return enqueueGlobalOperation(() => _stopServer(config));
}

export function restartServer(config: HelperConfig): Promise<{ success: boolean; message: string }> {
  return enqueueGlobalOperation(() => _restartServer(config));
}

export interface ServerStatusResult {
  running: boolean;
  pid: number | null;
  uptime: string | null;
  lastRestart: string | null;
}

export async function getServerStatus(config: HelperConfig): Promise<ServerStatusResult> {
  const result = await runAllowlistedCommand('/usr/bin/systemctl', ['status', config.serviceName], SYSTEMCTL_STATUS_OPTS);
  const output = result.stdout + result.stderr;
  const systemdStatus = extractSystemdStatus(output);
  const runtime = await detectTmuxRuntime(config);
  const running = isRuntimeRunning(runtime);

  return {
    running,
    pid: runtime.process?.pid ?? null,
    uptime: runtime.process ? formatElapsedSeconds(runtime.process.elapsedSeconds) : (running ? systemdStatus.uptime : null),
    lastRestart: runtime.process
      ? new Date(Date.now() - (runtime.process.elapsedSeconds ?? 0) * 1000).toISOString()
      : systemdStatus.lastRestart,
  };
}
