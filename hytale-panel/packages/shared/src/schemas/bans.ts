import { z } from 'zod';
import { BAN_REASON_REGEX, PLAYER_NAME_REGEX } from '../constants';

export const BanEntrySchema = z.object({
  name: z.string().regex(PLAYER_NAME_REGEX),
  reason: z.string().max(200).optional(),
  bannedAt: z.string().optional(),
});

export const BanFileSchema = z.array(BanEntrySchema);

export const AddBanSchema = z.object({
  name: z.string().min(1).max(32).regex(PLAYER_NAME_REGEX, 'Invalid player name'),
  reason: z
    .string()
    .max(200)
    .regex(BAN_REASON_REGEX, 'Ban reason must contain only letters, digits, space, and _-.@:/')
    .optional()
    .default(''),
});

export const RemoveBanSchema = z.object({
  name: z.string().min(1).max(32).regex(PLAYER_NAME_REGEX, 'Invalid player name'),
});

export type BanEntry = z.infer<typeof BanEntrySchema>;
export type AddBanInput = z.infer<typeof AddBanSchema>;
export type RemoveBanInput = z.infer<typeof RemoveBanSchema>;