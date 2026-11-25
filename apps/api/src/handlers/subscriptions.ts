import crypto from 'node:crypto';
import {
  CreateSubscriptionEmulatorSchema,
  CreateSubscriptionSchema,
  EntityIdSchema,
  SubscriptionEmulatorSchema,
  SubscriptionSchema,
  UpdateSubscriptionEmulatorSchema,
  UpdateSubscriptionSchema,
  type Subscription,
  type SubscriptionFilters,
} from '@agent-kanban/shared';
import { getConfig, type AppConfig } from '../config.js';
import { encryptSecret } from '../lib/crypto.js';
import { AppError, parseWithSchema } from '../lib/errors.js';
import { getDb } from '../lib/firebase.js';
import type { AuthContext } from '../types/express.js';
import type { HandlerDeps } from './cards.js';

export interface SubscriptionHandlerDeps extends HandlerDeps {
  config?: AppConfig;
}

function allowLocalWebhookUrls(config: Pick<AppConfig, 'isEmulator' | 'isTest'>): boolean {
  return config.isEmulator || config.isTest;
}

function dedupeArray<T extends string>(items: readonly T[] | undefined): T[] | undefined {
  if (items === undefined) {
    return undefined;
  }
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function normalizeFilters(filters: SubscriptionFilters): SubscriptionFilters {
  const tags = dedupeArray(filters.tags);
  const statuses = dedupeArray(filters.statuses);
  const assignedUserIds = dedupeArray(filters.assignedUserIds);
  const mentionedUserIds = dedupeArray(filters.mentionedUserIds);

  return {
    eventTypes: dedupeArray(filters.eventTypes) ?? filters.eventTypes,
    ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
    ...(statuses !== undefined && statuses.length > 0 ? { statuses } : {}),
    ...(assignedUserIds !== undefined && assignedUserIds.length > 0 ? { assignedUserIds } : {}),
    ...(mentionedUserIds !== undefined && mentionedUserIds.length > 0 ? { mentionedUserIds } : {}),
  };
}

export function toPublicSubscription(
  id: string,
  rawData: Record<string, unknown>,
  config?: Pick<AppConfig, 'isEmulator' | 'isTest'>,
): Subscription {
  const { encryptedSecret: _enc, secret: _sec, ...rest } = rawData;
  const resolvedConfig = config ?? getConfig();
  const schema = allowLocalWebhookUrls(resolvedConfig)
    ? SubscriptionEmulatorSchema
    : SubscriptionSchema;

  const parsed = schema.safeParse({
    ...rest,
    id,
  });
  if (!parsed.success) {
    throw new AppError(
      500,
      'INVALID_SUBSCRIPTION_RECORD',
      `Stored subscription "${id}" failed schema validation`,
    );
  }
  return parsed.data;
}

export async function listSubscriptionsHandler(
  auth: AuthContext,
  deps: SubscriptionHandlerDeps = {},
): Promise<{ subscriptions: Subscription[] }> {
  const db = deps.db ?? getDb();
  const config = deps.config ?? getConfig();
  const snap = await db
    .collection('subscriptions')
    .where('ownerUserId', '==', auth.ownerUserId)
    .get();

  const subscriptions = snap.docs
    .map((doc) => toPublicSubscription(doc.id, doc.data(), config))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return { subscriptions };
}

export async function createSubscriptionHandler(
  auth: AuthContext,
  rawInput: unknown,
  deps: SubscriptionHandlerDeps = {},
): Promise<{ subscription: Subscription }> {
  const config = deps.config ?? getConfig();
  const createSchema = allowLocalWebhookUrls(config)
    ? CreateSubscriptionEmulatorSchema
    : CreateSubscriptionSchema;
  const input = parseWithSchema(createSchema, rawInput, 'Invalid webhook subscription payload');
  const db = deps.db ?? getDb();
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();

  let connectionId: string | null = null;
  if (input.connectionId !== undefined) {
    connectionId = input.connectionId;
  } else if (auth.connectionId !== undefined) {
    connectionId = auth.connectionId;
  }

  if (connectionId !== null) {
    const connSnap = await db.collection('agentConnections').doc(connectionId).get();
    const connData = connSnap.exists ? (connSnap.data() ?? {}) : null;
    if (!connData || connData.ownerUserId !== auth.ownerUserId) {
      throw new AppError(404, 'CONNECTION_NOT_FOUND', 'Agent connection not found');
    }
  }

  const subscriptionId = `sub-${crypto.randomUUID()}`;
  const publicSchema = allowLocalWebhookUrls(config)
    ? SubscriptionEmulatorSchema
    : SubscriptionSchema;

  const subscription = publicSchema.parse({
    id: subscriptionId,
    ownerUserId: auth.ownerUserId,
    connectionId,
    webhookUrl: input.webhookUrl,
    authType: input.authType,
    filters: normalizeFilters(input.filters),
    active: input.active,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  const encryptedSecret = encryptSecret(input.secret, config);

  await db
    .collection('subscriptions')
    .doc(subscriptionId)
    .set({
      ...subscription,
      encryptedSecret,
    });

  return { subscription };
}

export async function updateSubscriptionHandler(
  auth: AuthContext,
  rawSubId: unknown,
  rawInput: unknown,
  deps: SubscriptionHandlerDeps = {},
): Promise<{ subscription: Subscription }> {
  const subscriptionId = parseWithSchema(EntityIdSchema, rawSubId, 'Invalid subscription ID');
  const config = deps.config ?? getConfig();
  const updateSchema = allowLocalWebhookUrls(config)
    ? UpdateSubscriptionEmulatorSchema
    : UpdateSubscriptionSchema;
  const input = parseWithSchema(updateSchema, rawInput, 'Invalid subscription update payload');
  const db = deps.db ?? getDb();
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();

  const subRef = db.collection('subscriptions').doc(subscriptionId);

  const updated = await db.runTransaction(async (tx) => {
    const snap = await tx.get(subRef);
    const data = snap.exists ? (snap.data() ?? {}) : null;
    if (!data || data.ownerUserId !== auth.ownerUserId) {
      throw new AppError(404, 'SUBSCRIPTION_NOT_FOUND', 'Webhook subscription not found');
    }

    const existing = toPublicSubscription(snap.id, data, config);
    const publicSchema = allowLocalWebhookUrls(config)
      ? SubscriptionEmulatorSchema
      : SubscriptionSchema;

    const nextSubscription = publicSchema.parse({
      ...existing,
      webhookUrl: input.webhookUrl ?? existing.webhookUrl,
      authType: input.authType ?? existing.authType,
      filters: input.filters !== undefined ? normalizeFilters(input.filters) : existing.filters,
      active: input.active !== undefined ? input.active : existing.active,
      updatedAt: nowIso,
    });

    const encryptedSecret =
      input.secret !== undefined
        ? encryptSecret(input.secret, config)
        : typeof data.encryptedSecret === 'string'
          ? data.encryptedSecret
          : (() => {
              throw new AppError(
                500,
                'INVALID_SUBSCRIPTION_RECORD',
                `Stored subscription "${subscriptionId}" is missing encryptedSecret`,
              );
            })();

    tx.set(subRef, {
      ...nextSubscription,
      encryptedSecret,
    });

    return nextSubscription;
  });

  return { subscription: updated };
}

export async function deleteSubscriptionHandler(
  auth: AuthContext,
  rawSubId: unknown,
  deps: SubscriptionHandlerDeps = {},
): Promise<{ deleted: true; id: string }> {
  const subscriptionId = parseWithSchema(EntityIdSchema, rawSubId, 'Invalid subscription ID');
  const db = deps.db ?? getDb();
  const subRef = db.collection('subscriptions').doc(subscriptionId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(subRef);
    const data = snap.exists ? (snap.data() ?? {}) : null;
    if (!data || data.ownerUserId !== auth.ownerUserId) {
      throw new AppError(404, 'SUBSCRIPTION_NOT_FOUND', 'Webhook subscription not found');
    }
    tx.delete(subRef);
  });

  return { deleted: true, id: subscriptionId };
}
