import crypto from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import {
  EventSchema,
  type Event,
  type EventDeliveryStatus,
  type Subscription,
} from '@agent-kanban/shared';
import { getConfig, type AppConfig } from '../config.js';
import { toPublicSubscription } from '../handlers/subscriptions.js';
import { decryptSecret } from '../lib/crypto.js';
import { getDb } from '../lib/firebase.js';

export const WEBHOOK_TIMEOUT_MS = 5000;
export const MAX_DELIVERY_ATTEMPTS = 5;
export const RETRY_BACKOFF_MINUTES = [1, 5, 15, 60] as const;

const FIRESTORE_IN_CHUNK_SIZE = 30;

export interface WebhookDeliveryRecord {
  id: string;
  eventId: string;
  subscriptionId: string;
  ownerUserId: string;
  status: 'pending' | 'succeeded' | 'failed';
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookAttemptResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
}

export interface DispatcherDeps {
  db?: Firestore;
  now?: () => Date;
  config?: AppConfig;
  fetchFn?: typeof fetch;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function intersects(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) {
    return false;
  }
  const setB = new Set(b);
  return a.some((item) => setB.has(item));
}

/**
 * Evaluates whether an event satisfies a webhook subscription's active flag,
 * agent loop suppression invariant, user visibility, and all configured filters.
 */
export function matchesSubscription(
  event: Event,
  sub: Pick<Subscription, 'active' | 'ownerUserId' | 'filters'>,
): boolean {
  if (!sub.active) {
    return false;
  }

  // Defense-in-depth agent loop suppression.
  if (event.actor.actorType === 'agent') {
    return false;
  }

  if (!event.visibleToUserIds.includes(sub.ownerUserId)) {
    return false;
  }

  if (!sub.filters.eventTypes.includes(event.type)) {
    return false;
  }

  const { filters } = sub;

  if (filters.tags && filters.tags.length > 0) {
    const eventTags = readStringArray(event.payload.tags);
    if (!intersects(filters.tags, eventTags)) {
      return false;
    }
  }

  if (filters.statuses && filters.statuses.length > 0) {
    const eventStatus = typeof event.payload.status === 'string' ? event.payload.status : null;
    if (
      eventStatus === null ||
      !filters.statuses.includes(
        eventStatus as Subscription['filters']['statuses'] extends Array<infer T> ? T : never,
      )
    ) {
      return false;
    }
  }

  if (filters.assignedUserIds && filters.assignedUserIds.length > 0) {
    const eventAssigned = readStringArray(event.payload.assignedUserIds);
    if (!intersects(filters.assignedUserIds, eventAssigned)) {
      return false;
    }
  }

  if (filters.mentionedUserIds && filters.mentionedUserIds.length > 0) {
    const eventMentions = readStringArray(event.payload.mentions);
    if (!intersects(filters.mentionedUserIds, eventMentions)) {
      return false;
    }
  }

  return true;
}

export function computeHmacSignature(secret: string, unixSeconds: string, rawBody: string): string {
  const digest = crypto
    .createHmac('sha256', secret)
    .update(`${unixSeconds}.${rawBody}`)
    .digest('hex');
  return `t=${unixSeconds},v1=${digest}`;
}

export function computeStandardWebhookSignature(
  secret: string,
  webhookId: string,
  unixSeconds: string,
  rawBody: string,
): string {
  const rawKey = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  const decoded = Buffer.from(rawKey, 'base64');
  const key = decoded.length > 0 ? decoded : Buffer.from(rawKey, 'utf8');
  const digest = crypto
    .createHmac('sha256', key)
    .update(`${webhookId}.${unixSeconds}.${rawBody}`)
    .digest('base64');
  return `v1,${digest}`;
}

export function computeNextRetryIso(attemptCount: number, now: Date): string | null {
  if (attemptCount >= MAX_DELIVERY_ATTEMPTS) {
    return null;
  }
  const backoffMinutes =
    RETRY_BACKOFF_MINUTES[attemptCount - 1] ??
    RETRY_BACKOFF_MINUTES[RETRY_BACKOFF_MINUTES.length - 1]!;
  return new Date(now.getTime() + backoffMinutes * 60_000).toISOString();
}

export async function deliverWebhookOnce(params: {
  event: Event;
  subscription: Pick<Subscription, 'id' | 'webhookUrl' | 'authType'>;
  secret: string;
  now?: Date;
  fetchFn?: typeof fetch;
}): Promise<WebhookAttemptResult> {
  const now = params.now ?? new Date();
  const unixSeconds = String(Math.floor(now.getTime() / 1000));
  const rawBody = JSON.stringify({
    id: params.event.id,
    eventId: params.event.id,
    type: params.event.type,
    cardId: params.event.cardId,
    createdAt: params.event.createdAt,
    actor: params.event.actor,
    note: params.event.note,
    payload: params.event.payload,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Agent-Kanban-Event-Id': params.event.id,
    'X-Agent-Kanban-Event-Type': params.event.type,
    'X-Agent-Kanban-Timestamp': unixSeconds,
  };

  if (params.subscription.authType === 'bearer') {
    headers.Authorization = `Bearer ${params.secret}`;
  } else if (params.subscription.authType === 'standard_webhooks') {
    const webhookId = `msg_${params.event.id}`;
    headers['webhook-id'] = webhookId;
    headers['webhook-timestamp'] = unixSeconds;
    headers['webhook-signature'] = computeStandardWebhookSignature(
      params.secret,
      webhookId,
      unixSeconds,
      rawBody,
    );
  } else {
    headers['X-Agent-Kanban-Signature'] = computeHmacSignature(params.secret, unixSeconds, rawBody);
  }

  const fetchImpl = params.fetchFn ?? fetch;

  try {
    const response = await fetchImpl(params.subscription.webhookUrl, {
      method: 'POST',
      headers,
      body: rawBody,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });

    if (response.ok) {
      return { ok: true, statusCode: response.status };
    }

    const snippet = await response
      .text()
      .then((t) => t.slice(0, 200))
      .catch(() => '');
    return {
      ok: false,
      statusCode: response.status,
      error: `HTTP ${response.status}${snippet ? `: ${snippet}` : ''}`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: message.slice(0, 500),
    };
  }
}

async function recordDeliveryOutcome(params: {
  db: Firestore;
  deliveryId: string;
  eventId: string;
  subscriptionId: string;
  ownerUserId: string;
  attemptCount: number;
  nowIso: string;
  nextAttemptAt: string | null;
  status: EventDeliveryStatus['status'];
  lastError: string | null;
  createdAt: string;
}): Promise<void> {
  const record: WebhookDeliveryRecord = {
    id: params.deliveryId,
    eventId: params.eventId,
    subscriptionId: params.subscriptionId,
    ownerUserId: params.ownerUserId,
    status: params.status,
    attemptCount: params.attemptCount,
    lastAttemptAt: params.nowIso,
    nextAttemptAt: params.nextAttemptAt,
    lastError: params.lastError,
    createdAt: params.createdAt,
    updatedAt: params.nowIso,
  };

  const summary: EventDeliveryStatus = {
    status: params.status,
    attemptCount: params.attemptCount,
    lastAttemptAt: params.nowIso,
    nextAttemptAt: params.nextAttemptAt,
    lastError: params.lastError,
  };

  await params.db.collection('webhookDeliveries').doc(params.deliveryId).set(record);
  await params.db
    .collection('events')
    .doc(params.eventId)
    .set({ deliveries: { [params.subscriptionId]: summary } }, { merge: true });
  await params.db
    .collection('subscriptions')
    .doc(params.subscriptionId)
    .update({ lastDelivery: summary })
    .catch(() => undefined);
}

/**
 * Finds all active subscriptions matching an event and performs attempt 1 delivery.
 * Writes `webhookDeliveries/{eventId}_{subId}` and mirrors status onto `events/{eventId}`.
 */
export async function dispatchEventWebhooks(
  event: Event,
  deps: DispatcherDeps = {},
): Promise<{ attempted: number; succeeded: number; failed: number }> {
  if (event.actor.actorType === 'agent') {
    return { attempted: 0, succeeded: 0, failed: 0 };
  }

  const db = deps.db ?? getDb();
  const config = deps.config ?? getConfig();
  const getNow = deps.now ?? (() => new Date());

  const candidateDocs: Array<{ id: string; data: Record<string, unknown> }> = [];
  for (let i = 0; i < event.visibleToUserIds.length; i += FIRESTORE_IN_CHUNK_SIZE) {
    const chunk = event.visibleToUserIds.slice(i, i + FIRESTORE_IN_CHUNK_SIZE);
    const snap = await db
      .collection('subscriptions')
      .where('ownerUserId', 'in', chunk)
      .where('active', '==', true)
      .get();
    for (const doc of snap.docs) {
      candidateDocs.push({ id: doc.id, data: doc.data() });
    }
  }

  let attempted = 0;
  let succeeded = 0;
  let failed = 0;

  for (const doc of candidateDocs) {
    const subscription = toPublicSubscription(doc.id, doc.data, config);
    if (!matchesSubscription(event, subscription)) {
      continue;
    }

    const deliveryId = `${event.id}_${subscription.id}`;
    const deliveryRef = db.collection('webhookDeliveries').doc(deliveryId);
    const existingDelivery = await deliveryRef.get();
    if (existingDelivery.exists) {
      const existingData = existingDelivery.data();
      if (typeof existingData?.attemptCount === 'number' && existingData.attemptCount >= 1) {
        continue;
      }
    }

    const attemptTime = getNow();
    const attemptIso = attemptTime.toISOString();
    attempted += 1;

    const encryptedSecret =
      typeof doc.data.encryptedSecret === 'string' ? doc.data.encryptedSecret : null;

    if (!encryptedSecret) {
      failed += 1;
      await recordDeliveryOutcome({
        db,
        deliveryId,
        eventId: event.id,
        subscriptionId: subscription.id,
        ownerUserId: subscription.ownerUserId,
        attemptCount: 1,
        nowIso: attemptIso,
        nextAttemptAt: null,
        status: 'failed',
        lastError: 'Missing encryptedSecret on subscription',
        createdAt: attemptIso,
      });
      continue;
    }

    let plaintextSecret: string;
    try {
      plaintextSecret = decryptSecret(encryptedSecret, config);
    } catch (err) {
      failed += 1;
      await recordDeliveryOutcome({
        db,
        deliveryId,
        eventId: event.id,
        subscriptionId: subscription.id,
        ownerUserId: subscription.ownerUserId,
        attemptCount: 1,
        nowIso: attemptIso,
        nextAttemptAt: null,
        status: 'failed',
        lastError: err instanceof Error ? err.message : 'Unable to decrypt secret',
        createdAt: attemptIso,
      });
      continue;
    }

    const result = await deliverWebhookOnce({
      event,
      subscription,
      secret: plaintextSecret,
      now: attemptTime,
      fetchFn: deps.fetchFn,
    });

    if (result.ok) {
      succeeded += 1;
      await recordDeliveryOutcome({
        db,
        deliveryId,
        eventId: event.id,
        subscriptionId: subscription.id,
        ownerUserId: subscription.ownerUserId,
        attemptCount: 1,
        nowIso: attemptIso,
        nextAttemptAt: null,
        status: 'succeeded',
        lastError: null,
        createdAt: attemptIso,
      });
    } else {
      failed += 1;
      await recordDeliveryOutcome({
        db,
        deliveryId,
        eventId: event.id,
        subscriptionId: subscription.id,
        ownerUserId: subscription.ownerUserId,
        attemptCount: 1,
        nowIso: attemptIso,
        nextAttemptAt: computeNextRetryIso(1, attemptTime),
        status: 'pending',
        lastError: result.error ?? 'Webhook delivery failed',
        createdAt: attemptIso,
      });
    }
  }

  return { attempted, succeeded, failed };
}

/**
 * Retries all pending webhook deliveries whose `nextAttemptAt <= now`.
 */
export async function processDueWebhookRetries(
  now: Date = new Date(),
  deps: Omit<DispatcherDeps, 'now'> = {},
): Promise<{ processed: number; succeeded: number; rescheduled: number; failed: number }> {
  const db = deps.db ?? getDb();
  const config = deps.config ?? getConfig();
  const nowIso = now.toISOString();

  const dueSnap = await db
    .collection('webhookDeliveries')
    .where('status', '==', 'pending')
    .where('nextAttemptAt', '<=', nowIso)
    .get();

  let processed = 0;
  let succeeded = 0;
  let rescheduled = 0;
  let failed = 0;

  for (const doc of dueSnap.docs) {
    const raw = doc.data() as Partial<WebhookDeliveryRecord>;
    if (!raw.eventId || !raw.subscriptionId || !raw.ownerUserId) {
      continue;
    }

    processed += 1;
    const prevAttempts = typeof raw.attemptCount === 'number' ? raw.attemptCount : 1;
    const nextAttemptCount = prevAttempts + 1;
    const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : nowIso;

    const [eventSnap, subSnap] = await Promise.all([
      db.collection('events').doc(raw.eventId).get(),
      db.collection('subscriptions').doc(raw.subscriptionId).get(),
    ]);

    if (!eventSnap.exists || !subSnap.exists) {
      failed += 1;
      await recordDeliveryOutcome({
        db,
        deliveryId: doc.id,
        eventId: raw.eventId,
        subscriptionId: raw.subscriptionId,
        ownerUserId: raw.ownerUserId,
        attemptCount: nextAttemptCount,
        nowIso,
        nextAttemptAt: null,
        status: 'failed',
        lastError: 'Event or subscription no longer exists',
        createdAt,
      });
      continue;
    }

    const parsedEvent = EventSchema.safeParse({ ...eventSnap.data(), id: eventSnap.id });
    const subData = subSnap.data() ?? {};
    const subscription = toPublicSubscription(subSnap.id, subData, config);

    if (!parsedEvent.success || !matchesSubscription(parsedEvent.data, subscription)) {
      failed += 1;
      await recordDeliveryOutcome({
        db,
        deliveryId: doc.id,
        eventId: raw.eventId,
        subscriptionId: raw.subscriptionId,
        ownerUserId: raw.ownerUserId,
        attemptCount: nextAttemptCount,
        nowIso,
        nextAttemptAt: null,
        status: 'failed',
        lastError: 'Subscription inactive or no longer matches event',
        createdAt,
      });
      continue;
    }

    const encryptedSecret =
      typeof subData.encryptedSecret === 'string' ? subData.encryptedSecret : null;
    if (!encryptedSecret) {
      failed += 1;
      await recordDeliveryOutcome({
        db,
        deliveryId: doc.id,
        eventId: raw.eventId,
        subscriptionId: raw.subscriptionId,
        ownerUserId: raw.ownerUserId,
        attemptCount: nextAttemptCount,
        nowIso,
        nextAttemptAt: null,
        status: 'failed',
        lastError: 'Missing encryptedSecret on subscription',
        createdAt,
      });
      continue;
    }

    const plaintextSecret = decryptSecret(encryptedSecret, config);
    const result = await deliverWebhookOnce({
      event: parsedEvent.data,
      subscription,
      secret: plaintextSecret,
      now,
      fetchFn: deps.fetchFn,
    });

    if (result.ok) {
      succeeded += 1;
      await recordDeliveryOutcome({
        db,
        deliveryId: doc.id,
        eventId: raw.eventId,
        subscriptionId: raw.subscriptionId,
        ownerUserId: raw.ownerUserId,
        attemptCount: nextAttemptCount,
        nowIso,
        nextAttemptAt: null,
        status: 'succeeded',
        lastError: null,
        createdAt,
      });
    } else if (nextAttemptCount >= MAX_DELIVERY_ATTEMPTS) {
      failed += 1;
      await recordDeliveryOutcome({
        db,
        deliveryId: doc.id,
        eventId: raw.eventId,
        subscriptionId: raw.subscriptionId,
        ownerUserId: raw.ownerUserId,
        attemptCount: nextAttemptCount,
        nowIso,
        nextAttemptAt: null,
        status: 'failed',
        lastError: result.error ?? 'Webhook retry exhausted',
        createdAt,
      });
    } else {
      rescheduled += 1;
      await recordDeliveryOutcome({
        db,
        deliveryId: doc.id,
        eventId: raw.eventId,
        subscriptionId: raw.subscriptionId,
        ownerUserId: raw.ownerUserId,
        attemptCount: nextAttemptCount,
        nowIso,
        nextAttemptAt: computeNextRetryIso(nextAttemptCount, now),
        status: 'pending',
        lastError: result.error ?? 'Webhook delivery failed',
        createdAt,
      });
    }
  }

  return { processed, succeeded, rescheduled, failed };
}
