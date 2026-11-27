import { z } from 'zod';
import {
  CardSchema,
  RenameTagInputSchema,
  buildSearchTokens,
  normalizeTag,
  type Card,
} from '@agent-kanban/shared';
import { parseWithSchema } from '../lib/errors.js';
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
  nextMonotonicIso,
  parseStoredCard,
  type CreateCardHandlerOptions,
  type HandlerDeps,
} from './cards.js';

export interface TagSummary {
  tag: string;
  openCount: number;
  totalCount: number;
  lastUsedAt: string;
}

export interface RenameTagResult {
  fromTag: string;
  toTag: string | null;
  updatedCount: number;
  cards: Card[];
}

const ListTagsQuerySchema = z.object({
  includeArchived: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .default(false)
    .transform((value) => value === true || value === 'true'),
});

function isOpenCard(card: Card): boolean {
  return !card.archived && card.status !== 'done';
}

function sameTags(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((tag, index) => tag === right[index]);
}

/**
 * Rewrites `fromTag` to `toTag` (or removes it when `toTag` is null).
 * Matching is case-insensitive. The destination is stored in normalized form and
 * deduped. Cards that do not contain `fromTag` are returned unchanged.
 */
export function rewriteTags(
  tags: readonly string[],
  fromTag: string,
  toTag: string | null,
): string[] {
  const fromNorm = normalizeTag(fromTag);
  const toNorm = toTag === null ? null : normalizeTag(toTag);
  if (fromNorm.length === 0 || !tags.some((tag) => normalizeTag(tag) === fromNorm)) {
    return [...tags];
  }

  const seenDestination = new Set<string>();
  const result: string[] = [];

  for (const tag of tags) {
    const currentNorm = normalizeTag(tag);
    if (currentNorm.length === 0) {
      continue;
    }
    if (currentNorm === fromNorm || (toNorm !== null && currentNorm === toNorm)) {
      if (toNorm === null || seenDestination.has(toNorm)) {
        continue;
      }
      seenDestination.add(toNorm);
      result.push(toNorm);
      continue;
    }
    result.push(tag);
  }

  return result;
}

/**
 * Groups visible cards by normalized tag.
 * `openCount` counts non-archived cards whose status is not `done`.
 * `totalCount` counts every card in the provided set.
 * `lastUsedAt` is the latest `updatedAt` among cards carrying the tag.
 */
export function aggregateTagSummaries(cards: readonly Card[]): TagSummary[] {
  const buckets = new Map<string, TagSummary>();

  for (const card of cards) {
    const seenOnCard = new Set<string>();
    for (const rawTag of card.tags) {
      const tag = normalizeTag(rawTag);
      if (tag.length === 0 || seenOnCard.has(tag)) {
        continue;
      }
      seenOnCard.add(tag);

      const openIncrement = isOpenCard(card) ? 1 : 0;
      const existing = buckets.get(tag);
      if (!existing) {
        buckets.set(tag, {
          tag,
          openCount: openIncrement,
          totalCount: 1,
          lastUsedAt: card.updatedAt,
        });
        continue;
      }

      existing.totalCount += 1;
      existing.openCount += openIncrement;
      if (card.updatedAt > existing.lastUsedAt) {
        existing.lastUsedAt = card.updatedAt;
      }
    }
  }

  return [...buckets.values()].sort((a, b) => {
    if (a.openCount !== b.openCount) {
      return b.openCount - a.openCount;
    }
    if (a.totalCount !== b.totalCount) {
      return b.totalCount - a.totalCount;
    }
    return a.tag.localeCompare(b.tag);
  });
}

export async function listTagsHandler(
  auth: AuthContext,
  rawQuery: unknown,
  deps: HandlerDeps = {},
): Promise<{ tags: TagSummary[] }> {
  const query = parseWithSchema(ListTagsQuerySchema, rawQuery ?? {}, 'Invalid tag list filters');
  const db = deps.db ?? getDb();

  let firestoreQuery = db
    .collection('cards')
    .where('visibleToUserIds', 'array-contains', auth.ownerUserId);

  if (!query.includeArchived) {
    firestoreQuery = firestoreQuery.where('archived', '==', false);
  }

  const snap = await firestoreQuery.get();
  const cards = snap.docs.map((doc) => parseStoredCard(doc.id, doc.data()));
  return { tags: aggregateTagSummaries(cards) };
}

export async function renameTagHandler(
  auth: AuthContext,
  rawInput: unknown,
  options: CreateCardHandlerOptions = {},
): Promise<{ status: number; body: RenameTagResult; replayed: boolean }> {
  const input = parseWithSchema(RenameTagInputSchema, rawInput, 'Invalid tag rename payload');
  const db = options.db ?? getDb();
  const now = (options.now ?? (() => new Date()))();

  return runIdempotentTransaction(db, {
    scope: 'tags.rename',
    ownerUserId: auth.ownerUserId,
    idempotencyKey: options.idempotencyKey,
    now,
    execute: async (tx) => {
      const snap = await tx.get(
        db.collection('cards').where('visibleToUserIds', 'array-contains', auth.ownerUserId),
      );

      const pending: Array<{ existing: Card; nextTags: string[] }> = [];
      for (const doc of snap.docs) {
        const existing = parseStoredCard(doc.id, doc.data());
        if (!existing.visibleToUserIds.includes(auth.ownerUserId)) {
          continue;
        }
        const nextTags = rewriteTags(existing.tags, input.fromTag, input.toTag);
        if (sameTags(existing.tags, nextTags)) {
          continue;
        }
        pending.push({ existing, nextTags });
      }

      pending.sort((a, b) => a.existing.id.localeCompare(b.existing.id));

      const updatedCards: Card[] = [];
      for (const { existing, nextTags } of pending) {
        const nowIso = nextMonotonicIso(existing.updatedAt, now);
        const nextCard = CardSchema.parse({
          ...existing,
          tags: nextTags,
          lastTouchedAt: nowIso,
          updatedAt: nowIso,
          searchTokens: buildSearchTokens({
            title: existing.title,
            description: existing.description,
            checklists: existing.checklists,
          }),
        });

        const diff = computeFieldDiff(existing, nextCard, ['tags']);
        const activity = buildActivityEntry({
          cardId: nextCard.id,
          visibleToUserIds: nextCard.visibleToUserIds,
          auth,
          action: 'card.updated',
          diff,
          note: input.note ?? null,
          createdAt: nowIso,
        });

        tx.set(db.collection('cards').doc(nextCard.id), nextCard);
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
        body: {
          fromTag: input.fromTag,
          toTag: input.toTag,
          updatedCount: updatedCards.length,
          cards: updatedCards,
        },
      };
    },
  });
}
