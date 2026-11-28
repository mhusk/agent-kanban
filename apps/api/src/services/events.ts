import crypto from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  EventSchema,
  normalizeTags,
  type Card,
  type Event,
  type EventType,
} from '@agent-kanban/shared';
import type { AuthContext } from '../types/express.js';

export interface PublishEventParams {
  type: EventType;
  card: Card;
  auth: Pick<AuthContext, 'actorType' | 'userId' | 'agentName' | 'platform'>;
  payload?: Record<string, unknown>;
  note?: string | null;
  createdAt?: string;
}

/**
 * Builds an immutable domain Event document for persistence, enforcing the strict
 * agent loop suppression invariant: writes with `actorType === 'agent'` never
 * emit events.
 */
export function buildEventRecord(params: PublishEventParams): Event | null {
  if (params.auth.actorType === 'agent') {
    return null;
  }

  return EventSchema.parse({
    id: `evt-${crypto.randomUUID()}`,
    type: params.type,
    cardId: params.card.id,
    visibleToUserIds: params.card.visibleToUserIds,
    actor: {
      actorType: params.auth.actorType,
      actorId: params.auth.userId,
      agentName: params.auth.agentName ?? null,
      platform: params.auth.platform ?? null,
    },
    note: params.note ?? null,
    payload: {
      title: params.card.title,
      status: params.card.status,
      tags: params.card.tags,
      assignedUserIds: params.card.assignedUserIds,
      awareUserIds: params.card.awareUserIds,
      due: params.card.due,
      dueFirm: params.card.dueFirm,
      ...(params.payload ?? {}),
    },
    createdAt: params.createdAt ?? new Date().toISOString(),
    deliveries: {},
  });
}

export function writeEventInTransaction(
  tx: Transaction,
  db: Firestore,
  params: PublishEventParams,
): Event | null {
  const event = buildEventRecord(params);
  if (event === null) {
    return null;
  }
  tx.set(db.collection('events').doc(event.id), event);
  return event;
}

export async function publishEvent(
  db: Firestore,
  params: PublishEventParams,
): Promise<Event | null> {
  const event = buildEventRecord(params);
  if (event === null) {
    return null;
  }
  await db.collection('events').doc(event.id).set(event);
  return event;
}

export interface BuildBulkEventRecordsParams {
  cards: readonly Card[];
  auth: Pick<AuthContext, 'actorType' | 'userId' | 'agentName' | 'platform'>;
  actionSummary: string;
  rescoreRequestedCardIds?: readonly string[];
  completedCardIds?: readonly string[];
  recurringResetCardIds?: readonly string[];
  note?: string | null;
  createdAt?: string;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

/** Canonical grouping key: sorted `visibleToUserIds` joined by comma. */
export function visibilityGroupKey(visibleToUserIds: readonly string[]): string {
  return [...visibleToUserIds].sort().join(',');
}

/**
 * Groups mutated cards by visibility and emits one `cards.bulk_updated` event per
 * group. Agent actors emit nothing. A group's payload lists only that group's card
 * IDs, so a private card never appears on another member's event.
 */
export function buildBulkEventRecords(params: BuildBulkEventRecordsParams): Event[] {
  if (params.auth.actorType === 'agent') {
    return [];
  }

  const groups = new Map<string, Card[]>();
  for (const card of params.cards) {
    const key = visibilityGroupKey(card.visibleToUserIds);
    const group = groups.get(key);
    if (group) {
      group.push(card);
    } else {
      groups.set(key, [card]);
    }
  }

  const rescoreIds = new Set(params.rescoreRequestedCardIds ?? []);
  const completedIds =
    params.completedCardIds !== undefined ? new Set(params.completedCardIds) : null;
  const recurringResetIds =
    params.recurringResetCardIds !== undefined ? new Set(params.recurringResetCardIds) : null;
  const createdAt = params.createdAt ?? new Date().toISOString();
  const events: Event[] = [];

  for (const groupCards of groups.values()) {
    const first = groupCards[0];
    if (!first) {
      continue;
    }
    const cardIds = groupCards.map((card) => card.id);
    const visibleToUserIds = [...first.visibleToUserIds].sort();
    const payload: Record<string, unknown> = {
      cardIds,
      count: cardIds.length,
      tags: normalizeTags(groupCards.flatMap((card) => card.tags)),
      statuses: uniqueStrings(groupCards.map((card) => card.status)),
      assignedUserIds: uniqueStrings(groupCards.flatMap((card) => card.assignedUserIds)),
      actionSummary: params.actionSummary,
      rescoreRequested: groupCards.some((card) => rescoreIds.has(card.id)),
    };
    if (completedIds !== null) {
      payload.completedCardIds = cardIds.filter((id) => completedIds.has(id));
    }
    if (recurringResetIds !== null) {
      payload.recurringResetCardIds = cardIds.filter((id) => recurringResetIds.has(id));
    }

    events.push(
      EventSchema.parse({
        id: `evt-${crypto.randomUUID()}`,
        type: 'cards.bulk_updated',
        cardId: groupCards.length === 1 ? first.id : null,
        visibleToUserIds,
        actor: {
          actorType: params.auth.actorType,
          actorId: params.auth.userId,
          agentName: params.auth.agentName ?? null,
          platform: params.auth.platform ?? null,
        },
        note: params.note ?? null,
        payload,
        createdAt,
        deliveries: {},
      }),
    );
  }

  return events;
}

export function writeBulkEventsInTransaction(
  tx: Transaction,
  db: Firestore,
  params: BuildBulkEventRecordsParams,
): Event[] {
  const events = buildBulkEventRecords(params);
  for (const event of events) {
    tx.set(db.collection('events').doc(event.id), event);
  }
  return events;
}
