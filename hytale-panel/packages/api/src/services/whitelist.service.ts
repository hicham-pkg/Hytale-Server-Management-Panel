import { callHelper } from './helper-client';

/**
 * Hytale whitelist.json format:
 * { "enabled": true, "list": ["uuid1", "uuid2"] }
 *
 * The file stores UUIDs, not player names.
 *
 * Behavior:
 * - Online (server running): add/remove by username via console commands.
 *   The server resolves names to UUIDs internally.
 * - Offline (server stopped): toggle "enabled" via file edit.
 *   Remove UUID from file is allowed (direct file manipulation).
 *   Adding by name is NOT supported offline because name→UUID resolution
 *   requires the running server.
 */

export async function getWhitelist(): Promise<{
  success: boolean;
  enabled: boolean;
  list: string[];
  error?: string;
}> {
  const result = await callHelper('whitelist.read');
  if (!result.success) {
    return { success: false, enabled: false, list: [], error: result.error };
  }
  const data = result.data as { enabled: boolean; list: string[] };
  return { success: true, enabled: data.enabled ?? false, list: data.list ?? [] };
}

export async function addPlayer(
  name: string,
  serverRunning: boolean
): Promise<{ success: boolean; message: string }> {
  if (!serverRunning) {
    return {
      success: false,
      message:
        'Cannot add players by name while the server is stopped. ' +
        'The whitelist file stores UUIDs, and name-to-UUID resolution requires a running server. ' +
        'Start the server first, then add the player.',
    };
  }

  const cmdResult = await callHelper('server.sendCommand', { command: `whitelist add ${name}` });
  if (cmdResult.success) {
    return { success: true, message: `Sent whitelist add command for ${name}` };
  }
  return { success: false, message: cmdResult.error ?? 'Failed to send whitelist add command' };
}

/**
 * Online remove: sends "whitelist remove <name>" console command.
 * Only works when the server is running.
 */
export async function removePlayerOnline(
  name: string,
  serverRunning: boolean
): Promise<{ success: boolean; message: string }> {
  if (!serverRunning) {
    return {
      success: false,
      message:
        'Cannot remove players by name while the server is stopped. ' +
        'Use offline UUID removal instead, or start the server first.',
    };
  }

  const cmdResult = await callHelper('server.sendCommand', { command: `whitelist remove ${name}` });
  if (cmdResult.success) {
    return { success: true, message: `Sent whitelist remove command for ${name}` };
  }
  return { success: false, message: cmdResult.error ?? 'Failed to send whitelist remove command' };
}

/**
 * Offline remove: removes a UUID directly from the whitelist file.
 * Only works when the server is stopped (to avoid conflicts with the running server).
 */
export async function removePlayerOffline(
  uuid: string,
  serverRunning: boolean
): Promise<{ success: boolean; message: string }> {
  if (serverRunning) {
    return {
      success: false,
      message:
        'Cannot edit the whitelist file while the server is running. ' +
        'Use the "Remove by Username" form instead (online removal via console command).',
    };
  }

  // Read current whitelist
  const readResult = await callHelper('whitelist.read');
  if (!readResult.success) {
    return { success: false, message: readResult.error ?? 'Failed to read whitelist' };
  }

  const data = readResult.data as { enabled: boolean; list: string[] };
  const currentList = data.list ?? [];

  if (!currentList.includes(uuid)) {
    return { success: false, message: `UUID ${uuid} not found in whitelist` };
  }

  const newList = currentList.filter((entry) => entry !== uuid);

  const writeResult = await callHelper('whitelist.write', {
    enabled: data.enabled,
    list: newList,
  });

  if (!writeResult.success) {
    return { success: false, message: writeResult.error ?? 'Failed to write whitelist' };
  }

  return { success: true, message: `Removed UUID ${uuid} from whitelist file` };
}

export async function toggleWhitelist(
  enabled: boolean,
  serverRunning: boolean
): Promise<{ success: boolean; message: string }> {
  if (serverRunning) {
    const cmd = enabled ? 'whitelist on' : 'whitelist off';
    const result = await callHelper('server.sendCommand', { command: cmd });
    return {
      success: result.success,
      message: result.success ? `Whitelist ${enabled ? 'enabled' : 'disabled'}` : (result.error ?? 'Failed'),
    };
  }

  // File-based toggle when server is stopped — safe because we only change "enabled",
  // preserving the existing UUID list untouched.
  const readResult = await callHelper('whitelist.read');
  if (!readResult.success) {
    return { success: false, message: readResult.error ?? 'Failed to read whitelist' };
  }

  const data = readResult.data as { enabled: boolean; list: string[] };
  const writeResult = await callHelper('whitelist.write', { enabled, list: data.list ?? [] });
  if (!writeResult.success) {
    return { success: false, message: writeResult.error ?? 'Failed to write whitelist' };
  }

  return { success: true, message: `Whitelist ${enabled ? 'enabled' : 'disabled'}` };
}