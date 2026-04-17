import { callHelper } from './helper-client';
import type { BanEntry } from '@hytale-panel/shared';

export async function getBans(): Promise<{
  success: boolean;
  entries: BanEntry[];
  error?: string;
}> {
  const result = await callHelper('bans.read');
  if (!result.success) {
    return { success: false, entries: [], error: result.error };
  }
  const data = result.data as { entries: BanEntry[] };
  return { success: true, entries: data.entries };
}

export async function addBan(
  name: string,
  reason: string,
  serverRunning: boolean
): Promise<{ success: boolean; message: string }> {
  if (serverRunning) {
    const cmd = reason ? `ban ${name} ${reason}` : `ban ${name}`;
    const cmdResult = await callHelper('server.sendCommand', { command: cmd });
    if (cmdResult.success) {
      return { success: true, message: `Sent ban command for ${name}` };
    }
  }

  // File-based fallback
  const readResult = await callHelper('bans.read');
  if (!readResult.success) {
    return { success: false, message: readResult.error ?? 'Failed to read bans' };
  }

  const data = readResult.data as { entries: BanEntry[] };
  const entries = data.entries;

  if (entries.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
    return { success: false, message: `${name} is already banned` };
  }

  entries.push({ name, reason, bannedAt: new Date().toISOString() });

  const writeResult = await callHelper('bans.write', { entries });
  if (!writeResult.success) {
    return { success: false, message: writeResult.error ?? 'Failed to write bans' };
  }

  return { success: true, message: `Banned ${name}` };
}

export async function removeBan(
  name: string,
  serverRunning: boolean
): Promise<{ success: boolean; message: string }> {
  if (serverRunning) {
    const cmdResult = await callHelper('server.sendCommand', { command: `unban ${name}` });
    if (cmdResult.success) {
      return { success: true, message: `Sent unban command for ${name}` };
    }
  }

  const readResult = await callHelper('bans.read');
  if (!readResult.success) {
    return { success: false, message: readResult.error ?? 'Failed to read bans' };
  }

  const data = readResult.data as { entries: BanEntry[] };
  const entries = data.entries.filter((e) => e.name.toLowerCase() !== name.toLowerCase());

  const writeResult = await callHelper('bans.write', { entries });
  if (!writeResult.success) {
    return { success: false, message: writeResult.error ?? 'Failed to write bans' };
  }

  return { success: true, message: `Unbanned ${name}` };
}