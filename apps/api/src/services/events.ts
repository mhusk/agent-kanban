import crypto from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { EventSchema, type Card, type Event, type EventType } from '@agent-kanban/shared';
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
