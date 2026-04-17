import { z } from 'zod';
import { MAX_COMMAND_LENGTH, COMMAND_CHAR_ALLOWLIST } from '../constants';

export const SendCommandSchema = z.object({
  command: z
    .string()
    .min(1)
    .max(MAX_COMMAND_LENGTH)
    .refine((val) => COMMAND_CHAR_ALLOWLIST.test(val), {
      message: 'Command contains disallowed characters',
    }),
});

export const ClientWsMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe') }),
  z.object({
    type: z.literal('command'),
    data: z
      .string()
      .min(1)
      .max(MAX_COMMAND_LENGTH)
      .refine((val) => COMMAND_CHAR_ALLOWLIST.test(val), {
        message: 'Command contains disallowed characters',
      }),
  }),
  z.object({ type: z.literal('pong') }),
]);

export type SendCommandInput = z.infer<typeof SendCommandSchema>;
export type ClientWsMessage = z.infer<typeof ClientWsMessageSchema>;