import type { Firestore } from 'firebase-admin/firestore';
import { CardSchema, isDueSoon, isOverdue, type Card, type EventType } from '@agent-kanban/shared';
import { getConfig } from '../config.js';
import { AppError } from '../lib/errors.js';
import { getDb } from '../lib/firebase.js';
import { writeEventInTransaction } from '../services/events.js';

const SYSTEM_EVENT_AUTH = {
  actorType: 'system' as const,
  userId: 'system',
};

export interface DueScannerDeps {
  db?: Firestore;
}

export interface DueScannerResult {
  scanned: number;
  dueSoonEmitted: number;
  overdueEmitted: number;
}

function parseStoredCard(id: string, rawData: Record<string, unknown>): Card {
  const parsed = CardSchema.safeParse({
    ...rawData,
    id,
  });
  if (!parsed.success) {
    throw new AppError(
      500,
      'INVALID_CARD_RECORD',
      `Stored card "${id}" failed schema validation during due scan`,
    );
  }
  return parsed.data;
}

async function emitDueEventOnce(params: {
  db: Firestore;
  cardId: string;
  expectedDue: string;
  eventType: Extract<EventType, 'card.due_soon' | 'card.overdue'>;
  flagField: 'dueSoonNotifiedAt' | 'overdueNotifiedAt';
  nowIso: string;
}): Promise<boolean> {
  const cardRef = params.db.collection('cards').doc(params.cardId);

  return params.db.runTransaction(async (tx) => {
    const snap = await tx.get(cardRef);
    if (!snap.exists) {
      return false;
    }

    const latest = parseStoredCard(snap.id, snap.data() ?? {});
    if (
      latest.archived ||
      latest.status === 'done' ||
      latest.due === null ||
      latest.due !== params.expectedDue
    ) {
      return false;
    }

    if (latest[params.flagField] !== null) {
      return false;
    }

    const updatedCard: Card = {
      ...latest,
      [params.flagField]: params.nowIso,
    };

    tx.update(cardRef, { [params.flagField]: params.nowIso });
    writeEventInTransaction(tx, params.db, {
      type: params.eventType,
      card: updatedCard,
      auth: SYSTEM_EVENT_AUTH,
      payload: {
        due: updatedCard.due,
        dueFirm: updatedCard.dueFirm,
        dueHasTime: updatedCard.dueHasTime,
      },
      createdAt: params.nowIso,
    });

    return true;
  });
}

/**
 * Scans open non-archived cards with a `due` value and emits `card.due_soon` (within 2 days)
 * and `card.overdue` (past due) events at most once per due cycle.
 */
export async function runDueScanner(
  now: Date = new Date(),
  tz?: string,
  deps: DueScannerDeps = {},
): Promise<DueScannerResult> {
  const db = deps.db ?? getDb();
  const timezone = tz ?? getConfig().householdTimezone;
  const nowIso = now.toISOString();

  const snap = await db
    .collection('cards')
    .where('archived', '==', false)
    .where('due', '>', '')
    .get();

  let scanned = 0;
  let dueSoonEmitted = 0;
  let overdueEmitted = 0;

  for (const doc of snap.docs) {
    const card = parseStoredCard(doc.id, doc.data());
    if (card.status === 'done' || card.due === null) {
      continue;
    }

    scanned += 1;

    if (isOverdue(card, now, timezone)) {
      if (card.overdueNotifiedAt === null) {
        const emitted = await emitDueEventOnce({
          db,
          cardId: card.id,
          expectedDue: card.due,
          eventType: 'card.overdue',
          flagField: 'overdueNotifiedAt',
          nowIso,
        });
        if (emitted) {
          overdueEmitted += 1;
        }
      }
      continue;
    }

    if (isDueSoon(card, now, timezone) && card.dueSoonNotifiedAt === null) {
      const emitted = await emitDueEventOnce({
        db,
        cardId: card.id,
        expectedDue: card.due,
        eventType: 'card.due_soon',
        flagField: 'dueSoonNotifiedAt',
        nowIso,
      });
      if (emitted) {
        dueSoonEmitted += 1;
      }
    }
  }

  return { scanned, dueSoonEmitted, overdueEmitted };
}
