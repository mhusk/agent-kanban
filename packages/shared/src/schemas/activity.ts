import { z } from 'zod';
import { EntityIdSchema, IsoDateTimeSchema, NoteSchema } from './common.js';

export const ActorTypeSchema = z.enum(['human', 'agent', 'system']);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const ActivityActionSchema = z.enum([
  'card.created',
  'card.updated',
  'card.status_changed',
  'card.completed',
  'card.archived',
  'card.unarchived',
  'card.auto_archived',
  'card.commented',
  'card.prioritized',
  'card.checklist_created',
  'card.checklist_updated',
  'card.checklist_deleted',
  'card.checklist_item_added',
  'card.checklist_item_updated',
  'card.checklist_item_deleted',
  'card.link_added',
  'card.link_removed',
  'card.attachment_added',
  'card.attachment_deleted',
]);
export type ActivityAction = z.infer<typeof ActivityActionSchema>;

export const FieldDiffSchema = z.object({
  from: z.unknown(),
  to: z.unknown(),
});
export type FieldDiff = z.infer<typeof FieldDiffSchema>;

export const ActivitySchema = z.object({
  id: EntityIdSchema,
  cardId: EntityIdSchema,
  visibleToUserIds: z.array(EntityIdSchema).min(1),
  actorType: ActorTypeSchema,
  actorId: EntityIdSchema,
  agentName: z.string().trim().min(1).max(120).nullable().default(null),
  platform: z.string().trim().min(1).max(120).nullable().default(null),
  action: ActivityActionSchema,
  diff: z.record(z.string(), FieldDiffSchema).default({}),
  note: NoteSchema.nullable().default(null),
  createdAt: IsoDateTimeSchema,
});
export type Activity = z.infer<typeof ActivitySchema>;
