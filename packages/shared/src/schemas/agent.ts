import { z } from 'zod';
import { ActorTypeSchema } from './activity.js';
import { CardStatusSchema } from './card.js';
import {
  DevWebhookUrlSchema,
  EntityIdSchema,
  HttpsUrlSchema,
  IsoDateTimeSchema,
  NormalizedTagsSchema,
  NoteSchema,
} from './common.js';

export const AgentAuthTypeSchema = z.enum(['oauth', 'api_key']);
export type AgentAuthType = z.infer<typeof AgentAuthTypeSchema>;

const DefaultAgentNameInputSchema = z
  .union([z.string().trim().max(120), z.null()])
  .transform((val) => (val === null || val.length === 0 ? null : val));

export const AgentConnectionSchema = z.object({
  id: EntityIdSchema,
  ownerUserId: EntityIdSchema,
  platform: z.string().trim().min(1).max(100),
  defaultAgentName: z.string().trim().min(1).max(120).nullable().default(null),
  authType: AgentAuthTypeSchema,
  keyPrefix: z.string().trim().min(1).max(32).nullable(),
  revoked: z.boolean().default(false),
  rotatedAt: IsoDateTimeSchema.nullable().default(null),
  createdAt: IsoDateTimeSchema,
});
export type AgentConnection = z.infer<typeof AgentConnectionSchema>;

export const CreateAgentConnectionSchema = z.object({
  platform: z.string().trim().min(1).max(100),
  defaultAgentName: DefaultAgentNameInputSchema.optional(),
});
export type CreateAgentConnection = z.infer<typeof CreateAgentConnectionSchema>;

export const UpdateAgentConnectionSchema = z
  .object({
    platform: z.string().trim().min(1).max(100).optional(),
    defaultAgentName: DefaultAgentNameInputSchema.optional(),
  })
  .refine(
    (data) => data.platform !== undefined || data.defaultAgentName !== undefined,
    'At least one field (platform or defaultAgentName) must be provided',
  );
export type UpdateAgentConnection = z.infer<typeof UpdateAgentConnectionSchema>;

export const EventTypeSchema = z.enum([
  'card.created',
  'card.updated',
  'card.status_changed',
  'card.commented',
  'card.completed',
  'card.due_soon',
  'card.overdue',
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const WebhookAuthTypeSchema = z.enum(['bearer', 'hmac', 'standard_webhooks']);
export type WebhookAuthType = z.infer<typeof WebhookAuthTypeSchema>;

export const EventDeliveryStatusSchema = z.object({
  status: z.enum(['pending', 'succeeded', 'failed']),
  attemptCount: z.number().int().min(0),
  lastAttemptAt: IsoDateTimeSchema.nullable().optional(),
  nextAttemptAt: IsoDateTimeSchema.nullable().optional(),
  lastError: z.string().nullable().optional(),
});
export type EventDeliveryStatus = z.infer<typeof EventDeliveryStatusSchema>;

export const SubscriptionFiltersSchema = z.object({
  eventTypes: z.array(EventTypeSchema).min(1),
  tags: NormalizedTagsSchema.optional(),
  statuses: z.array(CardStatusSchema).optional(),
  assignedUserIds: z.array(EntityIdSchema).optional(),
  mentionedUserIds: z.array(EntityIdSchema).optional(),
});
export type SubscriptionFilters = z.infer<typeof SubscriptionFiltersSchema>;

export const SubscriptionSchema = z.object({
  id: EntityIdSchema,
  ownerUserId: EntityIdSchema,
  connectionId: EntityIdSchema.nullable().default(null),
  webhookUrl: HttpsUrlSchema,
  authType: WebhookAuthTypeSchema,
  filters: SubscriptionFiltersSchema,
  active: z.boolean().default(true),
  lastDelivery: EventDeliveryStatusSchema.nullable().optional(),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

export const SubscriptionEmulatorSchema = SubscriptionSchema.extend({
  webhookUrl: DevWebhookUrlSchema,
});
export type SubscriptionEmulator = z.infer<typeof SubscriptionEmulatorSchema>;

export const CreateSubscriptionSchema = z.object({
  connectionId: EntityIdSchema.nullable().optional(),
  webhookUrl: HttpsUrlSchema,
  authType: WebhookAuthTypeSchema,
  secret: z.string().min(16).max(512),
  filters: SubscriptionFiltersSchema,
  active: z.boolean().optional().default(true),
});
export type CreateSubscription = z.infer<typeof CreateSubscriptionSchema>;

export const CreateSubscriptionEmulatorSchema = CreateSubscriptionSchema.extend({
  webhookUrl: DevWebhookUrlSchema,
});
export type CreateSubscriptionEmulator = z.infer<typeof CreateSubscriptionEmulatorSchema>;

export const UpdateSubscriptionSchema = z.object({
  webhookUrl: HttpsUrlSchema.optional(),
  authType: WebhookAuthTypeSchema.optional(),
  secret: z.string().min(16).max(512).optional(),
  filters: SubscriptionFiltersSchema.optional(),
  active: z.boolean().optional(),
});
export type UpdateSubscription = z.infer<typeof UpdateSubscriptionSchema>;

export const UpdateSubscriptionEmulatorSchema = UpdateSubscriptionSchema.extend({
  webhookUrl: DevWebhookUrlSchema.optional(),
});
export type UpdateSubscriptionEmulator = z.infer<typeof UpdateSubscriptionEmulatorSchema>;

export const EventActorSchema = z.object({
  actorType: ActorTypeSchema,
  actorId: EntityIdSchema,
  agentName: z.string().trim().min(1).max(120).nullable().default(null),
  platform: z.string().trim().min(1).max(120).nullable().default(null),
});
export type EventActor = z.infer<typeof EventActorSchema>;

export const EventSchema = z.object({
  id: EntityIdSchema,
  type: EventTypeSchema,
  cardId: EntityIdSchema,
  visibleToUserIds: z.array(EntityIdSchema).min(1),
  actor: EventActorSchema,
  note: NoteSchema.nullable().default(null),
  payload: z.record(z.string(), z.unknown()).default({}),
  createdAt: IsoDateTimeSchema,
  deliveries: z.record(z.string(), EventDeliveryStatusSchema).default({}),
});
export type Event = z.infer<typeof EventSchema>;
