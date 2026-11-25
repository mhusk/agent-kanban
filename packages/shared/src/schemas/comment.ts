import { z } from 'zod';
import { ActorTypeSchema } from './activity.js';
import { EntityIdSchema, IsoDateTimeSchema, NoteSchema } from './common.js';

export const CommentSchema = z.object({
  id: EntityIdSchema,
  cardId: EntityIdSchema,
  actorType: ActorTypeSchema,
  actorId: EntityIdSchema,
  agentName: z.string().trim().min(1).max(120).nullable().default(null),
  platform: z.string().trim().min(1).max(120).nullable().default(null),
  text: z.string().trim().min(1).max(10000),
  mentions: z.array(EntityIdSchema).default([]),
  createdAt: IsoDateTimeSchema,
});
export type Comment = z.infer<typeof CommentSchema>;

export const CreateCommentInputSchema = z.object({
  text: z.string().trim().min(1).max(10000),
  note: NoteSchema.optional(),
});
export type CreateCommentInput = z.infer<typeof CreateCommentInputSchema>;
