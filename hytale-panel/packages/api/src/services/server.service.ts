import { callHelper } from './helper-client';
import type { ServerStatus } from '@hytale-panel/shared';

export async function getServerStatus(): Promise<ServerStatus & { serviceName: string }> {
  const result = await callHelper('server.status');
  if (!result.success) {
    return {
      running: false,
      pid: null,
      uptime: null,
      lastRestart: null,
      playerCount: null,
      serviceName: 'hytale-tmux.service',
    };
  }

  const data = result.data as {
    running: boolean;
    pid: number | null;
    uptime: string | null;
    lastRestart: string | null;
  };

  return {
    running: data.running,
    pid: data.pid,
    uptime: data.uptime,
    lastRestart: data.lastRestart,
    playerCount: null, // Best-effort; would need log parsing
    serviceName: 'hytale-tmux.service',
  };
}

export async function startServer(): Promise<{ success: boolean; message: string }> {
  const result = await callHelper('server.start');
  const data = result.data as { message: string } | undefined;
  return { success: result.success, message: data?.message ?? result.error ?? 'Unknown error' };
}

export async function stopServer(): Promise<{ success: boolean; message: string }> {
  const result = await callHelper('server.stop');
  const data = result.data as { message: string } | undefined;
  return { success: result.success, message: data?.message ?? result.error ?? 'Unknown error' };
}

export async function restartServer(): Promise<{ success: boolean; message: string }> {
  const result = await callHelper('server.restart');
  const data = result.data as { message: string } | undefined;
  return { success: result.success, message: data?.message ?? result.error ?? 'Unknown error' };
}