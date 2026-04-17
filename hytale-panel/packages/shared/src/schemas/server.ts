import { z } from 'zod';

export const ServerStatusSchema = z.object({
  running: z.boolean(),
  pid: z.number().nullable(),
  uptime: z.string().nullable(),
  lastRestart: z.string().nullable(),
  playerCount: z.number().nullable(),
});

export type ServerStatus = z.infer<typeof ServerStatusSchema>;