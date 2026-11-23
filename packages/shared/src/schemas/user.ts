import { z } from 'zod';
import { EntityIdSchema, HandleSchema, IsoDateTimeSchema } from './common.js';

export const UserRoleSchema = z.enum(['admin', 'member']);
export type UserRole = z.infer<typeof UserRoleSchema>;

export const UserSchema = z.object({
  id: EntityIdSchema,
  workosUserId: z.string().trim().min(1).nullable(),
  email: z
    .string()
    .trim()
    .email()
    .transform((value) => value.toLowerCase()),
  displayName: z.string().trim().min(1).max(100),
  handle: HandleSchema,
  role: UserRoleSchema,
  createdAt: IsoDateTimeSchema,
});
export type User = z.infer<typeof UserSchema>;

export const CreateUserInputSchema = z.object({
  email: z
    .string()
    .trim()
    .email()
    .transform((value) => value.toLowerCase()),
  displayName: z.string().trim().min(1).max(100),
  handle: z
    .string()
    .trim()
    .transform((value) => value.replace(/^@/, '').toLowerCase())
    .pipe(HandleSchema),
  role: UserRoleSchema.default('member'),
});
export type CreateUserInput = z.infer<typeof CreateUserInputSchema>;
