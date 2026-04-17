import { z } from 'zod';
import { UUID_REGEX, PLAYER_NAME_REGEX } from '../constants';

/**
 * Real Hytale whitelist.json format:
 * { "enabled": true, "list": ["uuid1", "uuid2"] }
 *
 * The file stores UUIDs, not player names.
 */
export const WhitelistFileSchema = z.object({
  enabled: z.boolean(),
  list: z.array(z.string()),
});

/** Online add: by player name (server resolves to UUID) */
export const AddPlayerSchema = z.object({
  name: z.string().min(1).max(32).regex(PLAYER_NAME_REGEX, 'Invalid player name'),
});

/** Online remove: by player name (server resolves to UUID) */
export const RemovePlayerSchema = z.object({
  name: z.string().min(1).max(32).regex(PLAYER_NAME_REGEX, 'Invalid player name'),
});

/** Offline add: by UUID (direct file edit) */
export const AddPlayerByUuidSchema = z.object({
  uuid: z.string().regex(UUID_REGEX, 'Invalid UUID'),
});

/** Offline remove: by UUID (direct file edit) */
export const RemovePlayerByUuidSchema = z.object({
  uuid: z.string().regex(UUID_REGEX, 'Invalid UUID'),
});

export const ToggleWhitelistSchema = z.object({
  enabled: z.boolean(),
});

export type WhitelistFile = z.infer<typeof WhitelistFileSchema>;
export type AddPlayerInput = z.infer<typeof AddPlayerSchema>;
export type RemovePlayerInput = z.infer<typeof RemovePlayerSchema>;
export type AddPlayerByUuidInput = z.infer<typeof AddPlayerByUuidSchema>;
export type RemovePlayerByUuidInput = z.infer<typeof RemovePlayerByUuidSchema>;