import {
  BulkCardUpdateSchema,
  BulkPriorityUpdateSchema,
  CardSchema,
  CommentSchema,
  SmartQueryInputSchema,
  UserSchema,
  isDueSoon,
  isOverdue,
  normalizeTag,
  normalizeTags,
  resolveEffectiveDueInstant,
  type Card,
  type Comment,
  type SmartQueryType,
  type User,
} from '@agent-kanban/shared';
import { getConfig } from '../config.js';
import { AppError, parseWithSchema } from '../lib/errors.js';
import { getDb } from '../lib/firebase.js';
import {
  buildActivityEntry,
  computeFieldDiff,
  writeActivityInTransaction,
} from '../services/activity.js';
import { writeEventInTransaction } from '../services/events.js';
import { runIdempotentTransaction } from '../services/idempotency.js';
import type { AuthContext } from '../types/express.js';
import {
  assertCardVisible,
  compareTodoCards,
  compareUpdatedDesc,
  nextMonotonicIso,
  parseStoredCard,
  type CompleteCardHandlerDeps,
  type CreateCardHandlerOptions,
} from './cards.js';
import { aggregateTagSummaries } from './tags.js';

const BULK_TRACKED_DIFF_FIELDS = [
  'status',
  'tags',
  'due',
  'dueFirm',
  'dueHasTime',
  'archived',
] as const;

function assertUniqueCardIds(cardIds: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of cardIds) {
    if (seen.has(id)) {
      throw new AppError(400, 'VALIDATION_ERROR', `Duplicate cardId "${id}" in bulk payload`);
    }
    seen.add(id);
  }
}

export async function bulkUpdatePrioritiesHandler(
  auth: AuthContext,
  rawInput: unknown,
  options: CreateCardHandlerOptions = {},
): Promise<{ status: number; body: { cards: Card[] }; replayed: boolean }> {
  const input = parseWithSchema(
    BulkPriorityUpdateSchema,
    rawInput,
    'Invalid bulk priority update payload',
  );
  assertUniqueCardIds(input.updates.map((u) => u.cardId));

  const db = options.db ?? getDb();
  const now = (options.now ?? (() => new Date()))();

  return runIdempotentTransaction(db, {
    scope: 'cards.bulk_priorities',
    ownerUserId: auth.ownerUserId,
    idempotencyKey: options.idempotencyKey,
    now,
    execute: async (tx) => {
      const cardRefs = input.updates.map((item) => db.collection('cards').doc(item.cardId));
      const snaps = await Promise.all(cardRefs.map((ref) => tx.get(ref)));

      const existingCards = snaps.map((snap) =>
        assertCardVisible(
          snap.exists ? parseStoredCard(snap.id, snap.data() ?? {}) : null,
          auth.ownerUserId,
        ),
      );

      const updatedCards: Card[] = [];

      for (let i = 0; i < input.updates.length; i += 1) {
        const update = input.updates[i]!;
        const existing = existingCards[i]!;
        const cardRef = cardRefs[i]!;
        const nowIso = nextMonotonicIso(existing.updatedAt, now);

        const nextCard = CardSchema.parse({
          ...existing,
          priorityScore: update.priorityScore,
          priorityReason:
            update.priorityReason !== undefined ? update.priorityReason : existing.priorityReason,
          updatedAt: nowIso,
        });

        const diff = computeFieldDiff(existing, nextCard, ['priorityScore', 'priorityReason']);
        const activity = buildActivityEntry({
          cardId: nextCard.id,
          visibleToUserIds: nextCard.visibleToUserIds,
          auth,
          action: 'card.prioritized',
          diff,
          note: input.note ?? null,
          createdAt: nowIso,
        });

        tx.set(cardRef, nextCard);
        writeActivityInTransaction(tx, db, activity);
        writeEventInTransaction(tx, db, {
          type: 'card.updated',
          card: nextCard,
          auth,
          payload: { diff },
          note: input.note ?? null,
          createdAt: nowIso,
        });
        updatedCards.push(nextCard);
      }

      return {
        status: 200,
        body: { cards: updatedCards },
      };
    },
  });
}

export async function bulkUpdateCardsHandler(
  auth: AuthContext,
  rawInput: unknown,
  options: CreateCardHandlerOptions = {},
): Promise<{ status: number; body: { cards: Card[] }; replayed: boolean }> {
  const input = parseWithSchema(BulkCardUpdateSchema, rawInput, 'Invalid bulk card update payload');
  assertUniqueCardIds(input.updates.map((u) => u.cardId));

  const db = options.db ?? getDb();
  const now = (options.now ?? (() => new Date()))();

  return runIdempotentTransaction(db, {
    scope: 'cards.bulk_update',
    ownerUserId: auth.ownerUserId,
    idempotencyKey: options.idempotencyKey,
    now,
    execute: async (tx) => {
      const cardRefs = input.updates.map((item) => db.collection('cards').doc(item.cardId));
      const snaps = await Promise.all(cardRefs.map((ref) => tx.get(ref)));

      const existingCards = snaps.map((snap) =>
        assertCardVisible(
          snap.exists ? parseStoredCard(snap.id, snap.data() ?? {}) : null,
          auth.ownerUserId,
        ),
      );

      const updatedCards: Card[] = [];

      for (let i = 0; i < input.updates.length; i += 1) {
        const update = input.updates[i]!;
        const existing = existingCards[i]!;
        const cardRef = cardRefs[i]!;
        const nowIso = nextMonotonicIso(existing.updatedAt, now);

        const status = update.status ?? existing.status;
        const touchesTags =
          update.tags !== undefined ||
          update.addTags !== undefined ||
          update.removeTags !== undefined;
        let tags = update.tags !== undefined ? [...update.tags] : [...existing.tags];
        if (update.addTags !== undefined && update.addTags.length > 0) {
          tags = [...tags, ...update.addTags];
        }
        if (update.removeTags !== undefined && update.removeTags.length > 0) {
          const removeSet = new Set(update.removeTags.map((tag) => normalizeTag(tag)));
          tags = tags.filter((tag) => !removeSet.has(normalizeTag(tag)));
        }
        if (touchesTags) {
          tags = normalizeTags(tags);
        }

        const dueChanged =
          (update.due !== undefined && update.due !== existing.due) ||
          (update.dueHasTime !== undefined && update.dueHasTime !== existing.dueHasTime);
        const due = update.due !== undefined ? update.due : existing.due;

        const nextCard = CardSchema.parse({
          ...existing,
          status,
          tags,
          due,
          dueFirm: update.dueFirm !== undefined ? update.dueFirm : existing.dueFirm,
          dueHasTime: update.dueHasTime !== undefined ? update.dueHasTime : existing.dueHasTime,
          archived: update.archived !== undefined ? update.archived : existing.archived,
          enteredStatusAt: status !== existing.status ? nowIso : existing.enteredStatusAt,
          lastTouchedAt: nowIso,
          updatedAt: nowIso,
          dueSoonNotifiedAt: dueChanged ? null : existing.dueSoonNotifiedAt,
          overdueNotifiedAt: dueChanged ? null : existing.overdueNotifiedAt,
        });

        const diff = computeFieldDiff(existing, nextCard, BULK_TRACKED_DIFF_FIELDS);
        const activity = buildActivityEntry({
          cardId: nextCard.id,
          visibleToUserIds: nextCard.visibleToUserIds,
          auth,
          action: 'card.updated',
          diff,
          note: input.note ?? null,
          createdAt: nowIso,
        });

        tx.set(cardRef, nextCard);
        writeActivityInTransaction(tx, db, activity);
        writeEventInTransaction(tx, db, {
          type: 'card.updated',
          card: nextCard,
          auth,
          payload: { diff },
          note: input.note ?? null,
          createdAt: nowIso,
        });
        updatedCards.push(nextCard);
      }

      return {
        status: 200,
        body: { cards: updatedCards },
      };
    },
  });
}

export async function smartQueryCardsHandler(
  auth: AuthContext,
  rawQuery: unknown,
  deps: CompleteCardHandlerDeps = {},
): Promise<{ query: SmartQueryType; days: number; timezone: string; cards: Card[] }> {
  const input = parseWithSchema(
    SmartQueryInputSchema,
    rawQuery ?? {},
    'Invalid smart query parameters',
  );
  const db = deps.db ?? getDb();
  const tz = deps.householdTimezone ?? getConfig().householdTimezone;
  const now = (deps.now ?? (() => new Date()))();

  const snap = await db
    .collection('cards')
    .where('visibleToUserIds', 'array-contains', auth.ownerUserId)
    .where('archived', '==', false)
    .get();

  const visibleCards = snap.docs.map((doc) => parseStoredCard(doc.id, doc.data()));

  if (input.query === 'overdue_or_due_within_days') {
    const days = input.days ?? 3;
    const matched = visibleCards.filter(
      (card) =>
        card.status !== 'done' && (isOverdue(card, now, tz) || isDueSoon(card, now, tz, days)),
    );
    matched.sort((a, b) => {
      const aDueMs = resolveEffectiveDueInstant(a.due!, a.dueHasTime, tz).getTime();
      const bDueMs = resolveEffectiveDueInstant(b.due!, b.dueHasTime, tz).getTime();
      if (aDueMs !== bDueMs) {
        return aDueMs - bDueMs;
      }
      return compareTodoCards(a, b);
    });
    return {
      query: input.query,
      days,
      timezone: tz,
      cards: matched,
    };
  }

  const days = input.days ?? 14;
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  const stale = visibleCards.filter(
    (card) => card.status === 'todo' && Date.parse(card.enteredStatusAt) <= cutoffMs,
  );
  stale.sort((a, b) => {
    const diff = Date.parse(a.enteredStatusAt) - Date.parse(b.enteredStatusAt);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });

  return {
    query: input.query,
    days,
    timezone: tz,
    cards: stale,
  };
}

export interface SnapshotCardSummary extends Card {
  isOverdue: boolean;
  isDueSoon: boolean;
  checklistCounts: { checked: number; total: number };
  linkCount: number;
  latestComment: Comment | null;
}

export interface WorkspaceSnapshotTagSummary {
  tag: string;
  openCount: number;
}

export interface WorkspaceSnapshotResult {
  generatedAt: string;
  timezone: string;
  ownerUserId: string;
  users: User[];
  counts: {
    todo: number;
    doing: number;
    blocked: number;
    done: number;
    open: number;
  };
  tags: WorkspaceSnapshotTagSummary[];
  cards: SnapshotCardSummary[];
}

export async function workspaceSnapshotHandler(
  auth: AuthContext,
  deps: CompleteCardHandlerDeps = {},
): Promise<WorkspaceSnapshotResult> {
  const db = deps.db ?? getDb();
  const tz = deps.householdTimezone ?? getConfig().householdTimezone;
  const now = (deps.now ?? (() => new Date()))();

  const [cardsSnap, usersSnap] = await Promise.all([
    db
      .collection('cards')
      .where('visibleToUserIds', 'array-contains', auth.ownerUserId)
      .where('archived', '==', false)
      .get(),
    db.collection('users').get(),
  ]);

  const users = usersSnap.docs
    .map((doc) => {
      const parsed = UserSchema.safeParse({ ...doc.data(), id: doc.id });
      if (!parsed.success) {
        throw new AppError(500, 'INVALID_USER_RECORD', `Invalid user document "${doc.id}"`);
      }
      return parsed.data;
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const allCards = cardsSnap.docs.map((doc) => parseStoredCard(doc.id, doc.data()));

  const todoCards = allCards.filter((c) => c.status === 'todo').sort(compareTodoCards);
  const doingCards = allCards.filter((c) => c.status === 'doing').sort(compareUpdatedDesc);
  const blockedCards = allCards.filter((c) => c.status === 'blocked').sort(compareUpdatedDesc);
  const doneCount = allCards.filter((c) => c.status === 'done').length;

  const openCards = [...todoCards, ...doingCards, ...blockedCards];

  const latestCommentSnaps = await Promise.all(
    openCards.map((card) =>
      db
        .collection('cards')
        .doc(card.id)
        .collection('comments')
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get(),
    ),
  );

  const cards: SnapshotCardSummary[] = openCards.map((card, index) => {
    const commentSnap = latestCommentSnaps[index]!;
    const commentDoc = commentSnap.docs[0];
    let latestComment: Comment | null = null;
    if (commentDoc) {
      const parsed = CommentSchema.safeParse({ ...commentDoc.data(), id: commentDoc.id });
      if (parsed.success) {
        latestComment = parsed.data;
      }
    }

    let checked = 0;
    let total = 0;
    for (const chk of card.checklists) {
      for (const item of chk.items) {
        total += 1;
        if (item.checked) {
          checked += 1;
        }
      }
    }

    return {
      ...card,
      isOverdue: isOverdue(card, now, tz),
      isDueSoon: isDueSoon(card, now, tz, 2),
      checklistCounts: { checked, total },
      linkCount: card.links.length,
      latestComment,
    };
  });

  const tags = aggregateTagSummaries(allCards).map((summary) => ({
    tag: summary.tag,
    openCount: summary.openCount,
  }));

  return {
    generatedAt: now.toISOString(),
    timezone: tz,
    ownerUserId: auth.ownerUserId,
    users,
    counts: {
      todo: todoCards.length,
      doing: doingCards.length,
      blocked: blockedCards.length,
      done: doneCount,
      open: openCards.length,
    },
    tags,
    cards,
  };
}
