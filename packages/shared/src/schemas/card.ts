import { z } from 'zod';
import {
  EntityIdSchema,
  HttpUrlSchema,
  IanaTimezoneSchema,
  IsoDateTimeSchema,
  NoteSchema,
  TagSchema,
} from './common.js';

export const CardStatusSchema = z.enum(['todo', 'doing', 'blocked', 'done']);
export type CardStatus = z.infer<typeof CardStatusSchema>;

export const ChecklistItemSchema = z.object({
  id: EntityIdSchema,
  text: z.string().trim().min(1).max(500),
  checked: z.boolean().default(false),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const ChecklistSchema = z.object({
  id: EntityIdSchema,
  title: z.string().trim().min(1).max(200),
  items: z.array(ChecklistItemSchema).default([]),
});
export type Checklist = z.infer<typeof ChecklistSchema>;

export const LinkAttachmentSchema = z.object({
  id: EntityIdSchema,
  url: HttpUrlSchema,
  label: z.string().trim().min(1).max(200).nullable().optional(),
  createdAt: IsoDateTimeSchema.optional(),
});
export type LinkAttachment = z.infer<typeof LinkAttachmentSchema>;

export const CreateLinkAttachmentInputSchema = z.object({
  url: HttpUrlSchema,
  label: z.string().trim().min(1).max(200).optional(),
});
export type CreateLinkAttachmentInput = z.infer<typeof CreateLinkAttachmentInputSchema>;

const CRON_FIELD_REGEX = /^[A-Za-z0-9*,/?#-]+$/;

export function isValidFiveFieldCron(expression: string): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return false;
  }
  return fields.every((field) => CRON_FIELD_REGEX.test(field));
}

export const CronExpressionSchema = z.string().trim().min(9).max(120).refine(isValidFiveFieldCron, {
  message: 'Cron expression must contain exactly 5 valid cron fields',
});

export const RecurrenceUnitSchema = z.enum(['days', 'weeks', 'months']);
export type RecurrenceUnit = z.infer<typeof RecurrenceUnitSchema>;

export const CronRecurrenceSchema = z.object({
  type: z.literal('cron'),
  expression: CronExpressionSchema,
  timezone: IanaTimezoneSchema.optional(),
});
export type CronRecurrence = z.infer<typeof CronRecurrenceSchema>;

export const IntervalRecurrenceSchema = z.object({
  type: z.literal('interval_after_completion'),
  every: z.number().int().min(1).max(3650),
  unit: RecurrenceUnitSchema,
  timezone: IanaTimezoneSchema.optional(),
});
export type IntervalRecurrence = z.infer<typeof IntervalRecurrenceSchema>;

export const RecurrenceSchema = z.discriminatedUnion('type', [
  CronRecurrenceSchema,
  IntervalRecurrenceSchema,
]);
export type Recurrence = z.infer<typeof RecurrenceSchema>;

export const PriorityScoreSchema = z.number().min(0).max(100).nullable();
export type PriorityScore = z.infer<typeof PriorityScoreSchema>;

export const PriorityReasonSchema = z.string().trim().min(1).max(500).nullable();
export type PriorityReason = z.infer<typeof PriorityReasonSchema>;

export const CardSchema = z.object({
  id: EntityIdSchema,
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20000).default(''),
  status: CardStatusSchema,
  tags: z.array(TagSchema).default([]),
  assignedUserIds: z.array(EntityIdSchema).default([]),
  awareUserIds: z.array(EntityIdSchema).default([]),
  visibleToUserIds: z.array(EntityIdSchema).min(1),
  priorityScore: PriorityScoreSchema,
  priorityReason: PriorityReasonSchema,
  due: IsoDateTimeSchema.nullable(),
  dueFirm: z.boolean().default(false),
  dueHasTime: z.boolean().default(false),
  recurrence: RecurrenceSchema.nullable(),
  links: z.array(LinkAttachmentSchema).default([]),
  checklists: z.array(ChecklistSchema).default([]),
  archived: z.boolean().default(false),
  enteredStatusAt: IsoDateTimeSchema,
  lastTouchedAt: IsoDateTimeSchema,
  createdBy: EntityIdSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  searchTokens: z.array(z.string()).default([]),
  trelloUrl: HttpUrlSchema.nullable().default(null),
  trelloShortLink: z.string().trim().min(1).max(64).nullable().default(null),
  dueSoonNotifiedAt: IsoDateTimeSchema.nullable().default(null),
  overdueNotifiedAt: IsoDateTimeSchema.nullable().default(null),
});
export type Card = z.infer<typeof CardSchema>;

export const CreateChecklistInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  items: z
    .array(
      z.object({
        text: z.string().trim().min(1).max(500),
        checked: z.boolean().optional().default(false),
      }),
    )
    .optional()
    .default([]),
});
export type CreateChecklistInput = z.infer<typeof CreateChecklistInputSchema>;

export const CreateCardChecklistInputSchema = CreateChecklistInputSchema.extend({
  ifUpdatedAt: IsoDateTimeSchema.optional(),
  note: NoteSchema.optional(),
});
export type CreateCardChecklistInput = z.infer<typeof CreateCardChecklistInputSchema>;

export const UpdateChecklistInputSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    items: z
      .array(
        z.object({
          id: EntityIdSchema.optional(),
          text: z.string().trim().min(1).max(500),
          checked: z.boolean().optional().default(false),
        }),
      )
      .optional(),
    ifUpdatedAt: IsoDateTimeSchema.optional(),
    note: NoteSchema.optional(),
  })
  .refine((v) => v.title !== undefined || v.items !== undefined, {
    message: 'At least one of "title" or "items" must be provided',
  });
export type UpdateChecklistInput = z.infer<typeof UpdateChecklistInputSchema>;

export const CreateChecklistItemInputSchema = z.object({
  text: z.string().trim().min(1).max(500),
  checked: z.boolean().optional().default(false),
  ifUpdatedAt: IsoDateTimeSchema.optional(),
  note: NoteSchema.optional(),
});
export type CreateChecklistItemInput = z.infer<typeof CreateChecklistItemInputSchema>;

export const UpdateChecklistItemInputSchema = z
  .object({
    text: z.string().trim().min(1).max(500).optional(),
    checked: z.boolean().optional(),
    ifUpdatedAt: IsoDateTimeSchema.optional(),
    note: NoteSchema.optional(),
  })
  .refine((v) => v.text !== undefined || v.checked !== undefined, {
    message: 'At least one of "text" or "checked" must be provided',
  });
export type UpdateChecklistItemInput = z.infer<typeof UpdateChecklistItemInputSchema>;

export const AddCardLinkInputSchema = CreateLinkAttachmentInputSchema.extend({
  ifUpdatedAt: IsoDateTimeSchema.optional(),
  note: NoteSchema.optional(),
});
export type AddCardLinkInput = z.infer<typeof AddCardLinkInputSchema>;

export const CardMutationMetaInputSchema = z.object({
  ifUpdatedAt: IsoDateTimeSchema.optional(),
  note: NoteSchema.optional(),
});
export type CardMutationMetaInput = z.infer<typeof CardMutationMetaInputSchema>;

export const SearchCardsQuerySchema = z.object({
  q: z.string().trim().min(1).max(500),
  archived: z.enum(['true', 'false', 'all']).optional().default('false'),
});
export type SearchCardsQuery = z.infer<typeof SearchCardsQuerySchema>;

export const CreateCardInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(20000).optional().default(''),
  status: CardStatusSchema.optional().default('todo'),
  tags: z.array(TagSchema).optional().default([]),
  assignedUserIds: z.array(EntityIdSchema).optional(),
  awareUserIds: z.array(EntityIdSchema).optional().default([]),
  priorityScore: PriorityScoreSchema.optional().default(null),
  priorityReason: PriorityReasonSchema.optional().default(null),
  due: IsoDateTimeSchema.nullable().optional().default(null),
  dueFirm: z.boolean().optional().default(false),
  dueHasTime: z.boolean().optional().default(false),
  recurrence: RecurrenceSchema.nullable().optional().default(null),
  links: z.array(CreateLinkAttachmentInputSchema).optional().default([]),
  checklists: z.array(CreateChecklistInputSchema).optional().default([]),
  trelloUrl: HttpUrlSchema.nullable().optional().default(null),
  trelloShortLink: z.string().trim().min(1).max(64).nullable().optional().default(null),
  note: NoteSchema.optional(),
});
export type CreateCardInput = z.infer<typeof CreateCardInputSchema>;

export const UpdateCardInputSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(20000).optional(),
  status: CardStatusSchema.optional(),
  tags: z.array(TagSchema).optional(),
  assignedUserIds: z.array(EntityIdSchema).optional(),
  awareUserIds: z.array(EntityIdSchema).optional(),
  priorityScore: PriorityScoreSchema.optional(),
  priorityReason: PriorityReasonSchema.optional(),
  due: IsoDateTimeSchema.nullable().optional(),
  dueFirm: z.boolean().optional(),
  dueHasTime: z.boolean().optional(),
  recurrence: RecurrenceSchema.nullable().optional(),
  archived: z.boolean().optional(),
  trelloUrl: HttpUrlSchema.nullable().optional(),
  trelloShortLink: z.string().trim().min(1).max(64).nullable().optional(),
  ifUpdatedAt: IsoDateTimeSchema.optional(),
  note: NoteSchema.optional(),
});
export type UpdateCardInput = z.infer<typeof UpdateCardInputSchema>;

export const ChangeCardStatusInputSchema = z.object({
  status: CardStatusSchema,
  ifUpdatedAt: IsoDateTimeSchema.optional(),
  note: NoteSchema.optional(),
});
export type ChangeCardStatusInput = z.infer<typeof ChangeCardStatusInputSchema>;

export const ArchiveCardInputSchema = z.object({
  archived: z.boolean().optional().default(true),
  ifUpdatedAt: IsoDateTimeSchema.optional(),
  note: NoteSchema.optional(),
});
export type ArchiveCardInput = z.infer<typeof ArchiveCardInputSchema>;

export const BulkPriorityUpdateItemSchema = z.object({
  cardId: EntityIdSchema,
  priorityScore: PriorityScoreSchema,
  priorityReason: PriorityReasonSchema.optional(),
});
export type BulkPriorityUpdateItem = z.infer<typeof BulkPriorityUpdateItemSchema>;

export const BulkPriorityUpdateSchema = z.object({
  updates: z.array(BulkPriorityUpdateItemSchema).min(1).max(200),
  note: NoteSchema.optional(),
});
export type BulkPriorityUpdate = z.infer<typeof BulkPriorityUpdateSchema>;

export const BulkCardUpdateItemSchema = z.object({
  cardId: EntityIdSchema,
  status: CardStatusSchema.optional(),
  tags: z.array(TagSchema).optional(),
  addTags: z.array(TagSchema).optional(),
  removeTags: z.array(TagSchema).optional(),
  due: IsoDateTimeSchema.nullable().optional(),
  dueFirm: z.boolean().optional(),
  dueHasTime: z.boolean().optional(),
  archived: z.boolean().optional(),
});
export type BulkCardUpdateItem = z.infer<typeof BulkCardUpdateItemSchema>;

export const BulkCardUpdateSchema = z.object({
  updates: z.array(BulkCardUpdateItemSchema).min(1).max(200),
  note: NoteSchema.optional(),
});
export type BulkCardUpdate = z.infer<typeof BulkCardUpdateSchema>;
