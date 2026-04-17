import { z } from 'zod';

export const LoginSchema = z.object({
  username: z.string().min(1).max(50).trim(),
  password: z.string().min(1).max(128),
});

export const VerifyTotpSchema = z.object({
  code: z.string().length(6).regex(/^\d{6}$/),
});

export const SetupTotpSchema = z.object({}).strict();

export const ConfirmTotpSchema = z.object({
  code: z.string().length(6).regex(/^\d{6}$/),
});

export const CreateUserSchema = z.object({
  username: z.string().min(3).max(50).regex(/^[a-zA-Z0-9_]+$/),
  password: z.string().min(12).max(128),
  role: z.enum(['admin', 'readonly']),
});

export const UpdateUserSchema = z.object({
  role: z.enum(['admin', 'readonly']).optional(),
  password: z.string().min(12).max(128).optional(),
});

export type LoginInput = z.infer<typeof LoginSchema>;
export type VerifyTotpInput = z.infer<typeof VerifyTotpSchema>;
export type SetupTotpInput = z.infer<typeof SetupTotpSchema>;
export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
