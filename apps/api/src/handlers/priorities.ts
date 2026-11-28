import {
  BulkCardUpdateSchema,
  BulkCompleteCardsSchema,
  BulkPriorityUpdateSchema,
  CardSchema,
  CommentSchema,
  SmartQueryInputSchema,
  UserSchema,
  computeNextDueDate,
  computeRecurrenceDeferUntil,
  isCardDeferred,
  isDueSoon,
  isOverdue,
  normalizeTag,
  normalizeTags,
  projectNextOccurrences,
  resolveEffectiveDueInstant,
  type Card,
  type Checklist,
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
import { writeBulkEventsInTransaction, writeEventInTransaction } from '../services/events.js';
import { runIdempotentTransaction } from '../services/idempotency.js';
import type { AuthContext } from '../types/express.js';
import {
  assertCardVisible,
  compareTodoCards,
  compareUpdatedDesc,
  dedupeStrings,
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
  'assignedUserIds',
  'awareUserIds',
  'visibleToUserIds',
  'pinned',
  'deferUntil',
  'priorityScore',
  'priorityReason',
] as const;

const RECURRING_BULK_DONE_MESSAGE =
  'Recurring cards cannot be marked done with PATCH /api/cards/bulk. Use POST /api/cards/bulk/complete.';

function applyMembershipDelta(
  existing: readonly string[],
  replace: readonly string[] | undefined,
  add: readonly string[] | undefined,
  remove: readonly string[] | undefined,
): string[] {
  let next = replace !== undefined ? dedupeStrings(replace) : [...existing];
  if (add !== undefined && add.length > 0) {
    next = dedupeStrings([...next, ...add]);
  }
  if (remove !== undefined && remove.length > 0) {
    const removeSet = new Set(remove);
    next = next.filter((id) => !removeSet.has(id));
  }
  return next;
}

function latestIso(timestamps: readonly string[]): string {
  let latest = timestamps[0] ?? new Date().toISOString();
  for (const timestamp of timestamps) {
    if (timestamp > latest) {
      latest = timestamp;
    }
  }
  return latest;
}

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

      const plans: Array<{
        nextCard: Card;
        nowIso: string;
        rescoreRequested: boolean;
      }> = [];

      for (let i = 0; i < input.updates.length; i += 1) {
        const update = input.updates[i]!;
        const existing = existingCards[i]!;
        const nowIso = nextMonotonicIso(existing.updatedAt, now);

        if (update.status === 'done' && existing.recurrence !== null) {
          throw new AppError(400, 'VALIDATION_ERROR', RECURRING_BULK_DONE_MESSAGE);
        }

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

        const assignedUserIds = applyMembershipDelta(
          existing.assignedUserIds,
          update.assignedUserIds,
          update.addAssignedUserIds,
          update.removeAssignedUserIds,
        );
        const awareUserIds = applyMembershipDelta(
          existing.awareUserIds,
          update.awareUserIds,
          update.addAwareUserIds,
          update.removeAwareUserIds,
        );
        const visibleToUserIds = dedupeStrings([...assignedUserIds, ...awareUserIds]);
        if (visibleToUserIds.length === 0) {
          throw new AppError(
            400,
            'VALIDATION_ERROR',
            'At least one assigned or aware user is required for card visibility',
          );
        }

        const dueChanged =
          (update.due !== undefined && update.due !== existing.due) ||
          (update.dueHasTime !== undefined && update.dueHasTime !== existing.dueHasTime);
        const due = update.due !== undefined ? update.due : existing.due;
        const rescoreRequested = update.rescoreRequested === true;

        const nextCard = CardSchema.parse({
          ...existing,
          status,
          tags,
          assignedUserIds,
          awareUserIds,
          visibleToUserIds,
          due,
          dueFirm: update.dueFirm !== undefined ? update.dueFirm : existing.dueFirm,
          dueHasTime: update.dueHasTime !== undefined ? update.dueHasTime : existing.dueHasTime,
          archived: update.archived !== undefined ? update.archived : existing.archived,
          pinned: update.pinned !== undefined ? update.pinned : existing.pinned,
          deferUntil: update.deferUntil !== undefined ? update.deferUntil : existing.deferUntil,
          priorityScore: rescoreRequested ? null : existing.priorityScore,
          priorityReason: rescoreRequested ? null : existing.priorityReason,
          enteredStatusAt: status !== existing.status ? nowIso : existing.enteredStatusAt,
          lastTouchedAt: nowIso,
          updatedAt: nowIso,
          dueSoonNotifiedAt: dueChanged ? null : existing.dueSoonNotifiedAt,
          overdueNotifiedAt: dueChanged ? null : existing.overdueNotifiedAt,
        });

        plans.push({ nextCard, nowIso, rescoreRequested });
      }

      const updatedCards: Card[] = [];
      for (let i = 0; i < plans.length; i += 1) {
        const plan = plans[i]!;
        const existing = existingCards[i]!;
        const cardRef = cardRefs[i]!;
        const diff = computeFieldDiff(existing, plan.nextCard, BULK_TRACKED_DIFF_FIELDS);
        const activity = buildActivityEntry({
          cardId: plan.nextCard.id,
          visibleToUserIds: plan.nextCard.visibleToUserIds,
          auth,
          action: 'card.updated',
          diff,
          note: input.note ?? null,
          createdAt: plan.nowIso,
        });

        tx.set(cardRef, plan.nextCard);
        writeActivityInTransaction(tx, db, activity);
        updatedCards.push(plan.nextCard);
      }

      writeBulkEventsInTransaction(tx, db, {
        cards: updatedCards,
        auth,
        actionSummary: 'updated',
        rescoreRequestedCardIds: plans
          .filter((plan) => plan.rescoreRequested)
          .map((plan) => plan.nextCard.id),
        note: input.note ?? null,
        createdAt: latestIso(plans.map((plan) => plan.nowIso)),
      });

      return {
        status: 200,
        body: { cards: updatedCards },
      };
    },
  });
}

interface PlannedCompletion {
  existing: Card;
  nextCard: Card;
  recurringReset: boolean;
  nowIso: string;
}

function planBulkCompletion(
  existing: Card,
  now: Date,
  householdTimezone: string,
): PlannedCompletion {
  const nowIso = nextMonotonicIso(existing.updatedAt, now);

  if (existing.recurrence === null) {
    const nextCard = CardSchema.parse({
      ...existing,
      status: 'done',
      pinned: false,
      deferUntil: null,
      lastCompletedAt: nowIso,
      enteredStatusAt: existing.status !== 'done' ? nowIso : existing.enteredStatusAt,
      lastTouchedAt: nowIso,
      updatedAt: nowIso,
    });
    return { existing, nextCard, recurringReset: false, nowIso };
  }

  let nextDue: string;
  try {
    nextDue = computeNextDueDate(existing.recurrence, nowIso, existing.due, householdTimezone, {
      dueHasTime: existing.dueHasTime,
    });
  } catch (error) {
    throw new AppError(
      400,
      'INVALID_RECURRENCE',
      error instanceof Error ? error.message : 'Invalid card recurrence rule',
    );
  }

  let deferUntil: string | null;
  try {
    deferUntil = computeRecurrenceDeferUntil(
      existing.recurrence,
      nextDue,
      nowIso,
      householdTimezone,
      { dueHasTime: existing.dueHasTime },
    );
  } catch (error) {
    throw new AppError(
      400,
      'INVALID_RECURRENCE',
      error instanceof Error ? error.message : 'Invalid card recurrence rule',
    );
  }

  const resetChecklists: Checklist[] = existing.checklists.map((checklist) => ({
    ...checklist,
    items: checklist.items.map((item) => ({
      ...item,
      checked: false,
    })),
  }));

  const nextCard = CardSchema.parse({
    ...existing,
    status: 'todo',
    due: nextDue,
    checklists: resetChecklists,
    priorityScore: null,
    priorityReason: null,
    pinned: false,
    deferUntil,
    lastCompletedAt: nowIso,
    dueSoonNotifiedAt: null,
    overdueNotifiedAt: null,
    enteredStatusAt: nowIso,
    lastTouchedAt: nowIso,
    updatedAt: nowIso,
  });

  return { existing, nextCard, recurringReset: true, nowIso };
}

export async function bulkCompleteCardsHandler(
  auth: AuthContext,
  rawInput: unknown,
  options: CreateCardHandlerOptions & { householdTimezone?: string } = {},
): Promise<{
  status: number;
  body: { cards: Card[]; completedCardIds: string[]; recurringResetCardIds: string[] };
  replayed: boolean;
}> {
  const input = parseWithSchema(BulkCompleteCardsSchema, rawInput, 'Invalid bulk complete payload');
  assertUniqueCardIds(input.cardIds);

  const db = options.db ?? getDb();
  const now = (options.now ?? (() => new Date()))();
  const householdTimezone = options.householdTimezone ?? getConfig().householdTimezone;

  return runIdempotentTransaction(db, {
    scope: 'cards.bulk_complete',
    ownerUserId: auth.ownerUserId,
    idempotencyKey: options.idempotencyKey,
    now,
    execute: async (tx) => {
      const cardRefs = input.cardIds.map((cardId) => db.collection('cards').doc(cardId));
      const snaps = await Promise.all(cardRefs.map((ref) => tx.get(ref)));
      const existingCards = snaps.map((snap) =>
        assertCardVisible(
          snap.exists ? parseStoredCard(snap.id, snap.data() ?? {}) : null,
          auth.ownerUserId,
        ),
      );

      const plans = existingCards.map((existing) =>
        planBulkCompletion(existing, now, householdTimezone),
      );
      const updatedCards: Card[] = [];
      const completedCardIds: string[] = [];
      const recurringResetCardIds: string[] = [];

      for (let i = 0; i < plans.length; i += 1) {
        const plan = plans[i]!;
        const cardRef = cardRefs[i]!;
        const diff = plan.recurringReset
          ? computeFieldDiff(plan.existing, plan.nextCard, [
              'status',
              'due',
              'priorityScore',
              'priorityReason',
              'checklists',
              'pinned',
              'deferUntil',
              'lastCompletedAt',
            ])
          : computeFieldDiff(plan.existing, plan.nextCard, [
              'status',
              'pinned',
              'deferUntil',
              'lastCompletedAt',
            ]);
        if (plan.recurringReset) {
          diff.due = {
            from: plan.existing.due,
            to: plan.nextCard.due,
          };
        }

        const activity = buildActivityEntry({
          cardId: plan.nextCard.id,
          visibleToUserIds: plan.nextCard.visibleToUserIds,
          auth,
          action: 'card.completed',
          diff,
          note: input.note ?? null,
          createdAt: plan.nowIso,
        });

        tx.set(cardRef, plan.nextCard);
        writeActivityInTransaction(tx, db, activity);
        updatedCards.push(plan.nextCard);
        if (plan.recurringReset) {
          recurringResetCardIds.push(plan.nextCard.id);
        } else {
          completedCardIds.push(plan.nextCard.id);
        }
      }

      writeBulkEventsInTransaction(tx, db, {
        cards: updatedCards,
        auth,
        actionSummary: 'completed',
        completedCardIds,
        recurringResetCardIds,
        note: input.note ?? null,
        createdAt: latestIso(plans.map((plan) => plan.nowIso)),
      });

      return {
        status: 200,
        body: { cards: updatedCards, completedCardIds, recurringResetCardIds },
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

  switch (input.query) {
    case 'overdue_or_due_within_days': {
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
    case 'stale_in_todo_days': {
      const days = input.days ?? 14;
      const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
      const stale = visibleCards.filter(
        (card) =>
          card.status === 'todo' &&
          !isCardDeferred(card, now) &&
          Date.parse(card.enteredStatusAt) <= cutoffMs,
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
    case 'upcoming_recurring': {
      const days = input.days ?? 30;
      const horizonEndMs = now.getTime() + days * 24 * 60 * 60 * 1000;
      const matched = visibleCards.filter((card) => {
        if (card.recurrence === null) {
          return false;
        }
        if (card.due !== null && Date.parse(card.due) <= horizonEndMs) {
          return true;
        }
        try {
          const next = projectNextOccurrences(card.recurrence, now, card.due, 1, tz, {
            dueHasTime: card.dueHasTime,
          })[0];
          return next !== undefined && Date.parse(next) <= horizonEndMs;
        } catch (error) {
          throw new AppError(
            400,
            'INVALID_RECURRENCE',
            error instanceof Error ? error.message : 'Invalid card recurrence rule',
          );
        }
      });
      matched.sort((a, b) => {
        const aDue = a.due !== null ? Date.parse(a.due) : Number.POSITIVE_INFINITY;
        const bDue = b.due !== null ? Date.parse(b.due) : Number.POSITIVE_INFINITY;
        if (aDue !== bDue) {
          return aDue - bDue;
        }
        return a.id.localeCompare(b.id);
      });
      return {
        query: input.query,
        days,
        timezone: tz,
        cards: matched,
      };
    }
    default: {
      const unsupported: never = input.query;
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        `Unsupported smart query "${String(unsupported)}"`,
      );
    }
  }
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
    deferred: number;
    recurring: number;
  };
  tags: WorkspaceSnapshotTagSummary[];
  cards: SnapshotCardSummary[];
  deferredCards: SnapshotCardSummary[];
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
  const deferredSource = allCards
    .filter((card) => isCardDeferred(card, now))
    .sort((a, b) => {
      const diff = Date.parse(a.deferUntil ?? '') - Date.parse(b.deferUntil ?? '');
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    });
  const deferredIds = new Set(deferredSource.map((card) => card.id));

  const todoCards = allCards
    .filter((card) => card.status === 'todo' && !deferredIds.has(card.id))
    .sort(compareTodoCards);
  const doingCards = allCards
    .filter((card) => card.status === 'doing' && !deferredIds.has(card.id))
    .sort(compareUpdatedDesc);
  const blockedCards = allCards
    .filter((card) => card.status === 'blocked' && !deferredIds.has(card.id))
    .sort(compareUpdatedDesc);
  const doneCount = allCards.filter(
    (card) => card.status === 'done' && !deferredIds.has(card.id),
  ).length;

  const openCards = [...todoCards, ...doingCards, ...blockedCards];
  const summaryCards = [...openCards, ...deferredSource];

  const latestCommentSnaps = await Promise.all(
    summaryCards.map((card) =>
      db
        .collection('cards')
        .doc(card.id)
        .collection('comments')
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get(),
    ),
  );

  const summarize = (card: Card, index: number): SnapshotCardSummary => {
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
  };

  const cards = openCards.map((card, index) => summarize(card, index));
  const deferredCards = deferredSource.map((card, index) =>
    summarize(card, openCards.length + index),
  );

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
      deferred: deferredCards.length,
      recurring: allCards.filter((card) => card.recurrence !== null).length,
    },
    tags,
    cards,
    deferredCards,
  };
}
