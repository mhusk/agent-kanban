import crypto from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import {
  ActivitySchema,
  ArchiveCardInputSchema,
  CardSchema,
  CardStatusSchema,
  ChangeCardStatusInputSchema,
  CompleteCardInputSchema,
  CreateCardInputSchema,
  EntityIdSchema,
  IsoDateTimeSchema,
  SearchCardsQuerySchema,
  UpdateCardInputSchema,
  buildSearchTokens,
  computeNextDueDate,
  matchesSearchQuery,
  normalizeTag,
  normalizeTags,
  tokenizeQuery,
  type Activity,
  type Card,
  type CardStatus,
  type Checklist,
  type LinkAttachment,
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

export interface HandlerDeps {
  db?: Firestore;
  now?: () => Date;
}

const TRELLO_SHORT_LINK_REGEX = /^https?:\/\/(?:www\.)?trello\.com\/c\/([A-Za-z0-9]+)(?:\/|$)/i;
const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const TRACKED_CARD_DIFF_FIELDS = [
  'title',
  'description',
  'status',
  'tags',
  'assignedUserIds',
  'awareUserIds',
  'visibleToUserIds',
  'priorityScore',
  'priorityReason',
  'due',
  'dueFirm',
  'dueHasTime',
  'recurrence',
  'archived',
  'trelloUrl',
  'trelloShortLink',
] as const;

export function dedupeStrings(values: readonly string[]): string[] {
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

/**
 * Guarantees strictly monotonic ISO timestamps across consecutive updates so
 * same-millisecond updates never collide on `ifUpdatedAt` preconditions.
 */
export function nextMonotonicIso(previousIso: string, now: Date): string {
  const prevMs = Date.parse(previousIso);
  const nowMs = now.getTime();
  if (Number.isFinite(prevMs) && nowMs <= prevMs) {
    return new Date(prevMs + 1).toISOString();
  }
  return now.toISOString();
}

export function extractTrelloShortLink(url: string | null | undefined): string | null {
  if (!url) {
    return null;
  }
  const match = TRELLO_SHORT_LINK_REGEX.exec(url.trim());
  return match?.[1] ?? null;
}

function normalizeUrlForComparison(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Canonical `todo` sort:
 * 1. `priorityScore DESC` (nulls last)
 * 2. `due ASC` (nulls last)
 * 3. `createdAt ASC`
 * 4. `id ASC`
 */
export function compareTodoCards(a: Card, b: Card): number {
  const aScore = a.priorityScore;
  const bScore = b.priorityScore;
  if (aScore !== null && bScore !== null) {
    if (aScore !== bScore) {
      return bScore - aScore;
    }
  } else if (aScore !== null) {
    return -1;
  } else if (bScore !== null) {
    return 1;
  }

  const aDue = a.due !== null ? Date.parse(a.due) : null;
  const bDue = b.due !== null ? Date.parse(b.due) : null;
  if (aDue !== null && bDue !== null) {
    if (aDue !== bDue) {
      return aDue - bDue;
    }
  } else if (aDue !== null) {
    return -1;
  } else if (bDue !== null) {
    return 1;
  }

  const createdDiff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (createdDiff !== 0) {
    return createdDiff;
  }

  return a.id.localeCompare(b.id);
}

export function compareUpdatedDesc(a: Card, b: Card): number {
  const updatedDiff = Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  if (updatedDiff !== 0) {
    return updatedDiff;
  }
  const createdDiff = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (createdDiff !== 0) {
    return createdDiff;
  }
  return a.id.localeCompare(b.id);
}

export function parseStoredCard(id: string, rawData: Record<string, unknown>): Card {
  const parsed = CardSchema.safeParse({
    ...rawData,
    id,
  });
  if (!parsed.success) {
    throw new AppError(500, 'INVALID_CARD_RECORD', `Stored card "${id}" failed schema validation`);
  }
  return parsed.data;
}

function parseStoredActivity(id: string, rawData: Record<string, unknown>): Activity {
  const parsed = ActivitySchema.safeParse({
    ...rawData,
    id,
  });
  if (!parsed.success) {
    throw new AppError(
      500,
      'INVALID_ACTIVITY_RECORD',
      `Stored activity "${id}" failed schema validation`,
    );
  }
  return parsed.data;
}

/**
 * Enforces card existence and visibility isolation. Returns 404 for both missing
 * and unauthorized cards so card IDs are never leaked.
 */
export function assertCardVisible(card: Card | null, ownerUserId: string): Card {
  if (!card || !card.visibleToUserIds.includes(ownerUserId)) {
    throw new AppError(404, 'CARD_NOT_FOUND', 'Card not found');
  }
  return card;
}

function parseDateFilterMs(raw: string, boundary: 'start' | 'end'): number {
  const trimmed = raw.trim();
  if (DATE_ONLY_REGEX.test(trimmed)) {
    const suffix = boundary === 'end' ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
    const ms = Date.parse(`${trimmed}${suffix}`);
    if (!Number.isFinite(ms)) {
      throw new AppError(400, 'VALIDATION_ERROR', `Invalid date filter "${raw}"`);
    }
    const [yearStr, monthStr, dayStr] = trimmed.split('-');
    const parsedDate = new Date(ms);
    if (
      parsedDate.getUTCFullYear() !== Number(yearStr) ||
      parsedDate.getUTCMonth() + 1 !== Number(monthStr) ||
      parsedDate.getUTCDate() !== Number(dayStr)
    ) {
      throw new AppError(400, 'VALIDATION_ERROR', `Invalid calendar date "${raw}"`);
    }
    return ms;
  }

  const iso = parseWithSchema(IsoDateTimeSchema, trimmed, `Invalid ISO datetime filter "${raw}"`);
  return Date.parse(iso);
}

const ListCardsQuerySchema = z.object({
  status: z.string().trim().min(1).optional(),
  tag: z.string().trim().min(1).optional(),
  assignedTo: EntityIdSchema.optional(),
  awareOf: EntityIdSchema.optional(),
  dueBefore: z.string().trim().min(1).optional(),
  dueAfter: z.string().trim().min(1).optional(),
  updatedSince: z.string().trim().min(1).optional(),
  archived: z.enum(['true', 'false', 'all']).optional().default('false'),
  sort: z.enum(['priority', 'updated']).optional(),
});

const TrelloLookupQuerySchema = z.object({
  url: z
    .string()
    .trim()
    .transform((v) => (v.length > 0 ? v : undefined))
    .optional(),
  shortLink: z
    .string()
    .trim()
    .transform((v) => (v.length > 0 ? v : undefined))
    .optional(),
});

const ActivityPaginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  cursor: z
    .string()
    .trim()
    .transform((v) => (v.length > 0 ? v : undefined))
    .optional(),
});

export interface CreateCardHandlerOptions extends HandlerDeps {
  idempotencyKey?: string;
}

export async function createCardHandler(
  auth: AuthContext,
  rawInput: unknown,
  options: CreateCardHandlerOptions = {},
): Promise<{ status: number; body: { card: Card }; replayed: boolean }> {
  const input = parseWithSchema(CreateCardInputSchema, rawInput, 'Invalid card creation payload');
  const db = options.db ?? getDb();
  const now = (options.now ?? (() => new Date()))();

  return runIdempotentTransaction(db, {
    scope: 'cards.create',
    ownerUserId: auth.ownerUserId,
    idempotencyKey: options.idempotencyKey,
    now,
    execute: async (tx) => {
      const nowIso = now.toISOString();
      const cardId = `card-${crypto.randomUUID()}`;

      const assignedUserIds = dedupeStrings(
        input.assignedUserIds !== undefined ? input.assignedUserIds : [auth.userId],
      );
      const awareUserIds = dedupeStrings(input.awareUserIds);
      const visibleToUserIds = dedupeStrings([...assignedUserIds, ...awareUserIds]);

      if (visibleToUserIds.length === 0) {
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'At least one assigned or aware user is required for card visibility',
        );
      }

      const tags = normalizeTags(input.tags);
      const links: LinkAttachment[] = input.links.map((link) => ({
        id: `lnk-${crypto.randomUUID()}`,
        url: link.url,
        label: link.label ?? null,
        createdAt: nowIso,
      }));
      const checklists: Checklist[] = input.checklists.map((chk) => ({
        id: `chk-${crypto.randomUUID()}`,
        title: chk.title,
        items: chk.items.map((item) => ({
          id: `chki-${crypto.randomUUID()}`,
          text: item.text,
          checked: item.checked ?? false,
        })),
      }));

      const trelloUrl = input.trelloUrl ?? null;
      const trelloShortLink = input.trelloShortLink ?? extractTrelloShortLink(trelloUrl);
      const searchTokens = buildSearchTokens({
        title: input.title,
        description: input.description,
        checklists,
      });

      const card = CardSchema.parse({
        id: cardId,
        title: input.title,
        description: input.description,
        status: input.status,
        tags,
        assignedUserIds,
        awareUserIds,
        visibleToUserIds,
        priorityScore: input.priorityScore,
        priorityReason: input.priorityReason,
        due: input.due,
        dueFirm: input.dueFirm,
        dueHasTime: input.dueHasTime,
        recurrence: input.recurrence,
        links,
        checklists,
        commentCount: 0,
        archived: false,
        enteredStatusAt: nowIso,
        lastTouchedAt: nowIso,
        createdBy: auth.userId,
        createdAt: nowIso,
        updatedAt: nowIso,
        searchTokens,
        trelloUrl,
        trelloShortLink,
        dueSoonNotifiedAt: null,
        overdueNotifiedAt: null,
      });

      const activity = buildActivityEntry({
        cardId: card.id,
        visibleToUserIds: card.visibleToUserIds,
        auth,
        action: 'card.created',
        diff: {},
        note: input.note ?? null,
        createdAt: nowIso,
      });

      tx.set(db.collection('cards').doc(card.id), card);
      writeActivityInTransaction(tx, db, activity);
      writeEventInTransaction(tx, db, {
        type: 'card.created',
        card,
        auth,
        note: input.note ?? null,
        createdAt: nowIso,
      });

      return {
        status: 201,
        body: { card },
      };
    },
  });
}

export async function listCardsHandler(
  auth: AuthContext,
  rawQuery: unknown,
  deps: HandlerDeps = {},
): Promise<{ cards: Card[] }> {
  const query = parseWithSchema(ListCardsQuerySchema, rawQuery ?? {}, 'Invalid card list filters');
  const db = deps.db ?? getDb();

  let statusFilter: CardStatus[] | undefined;
  if (query.status !== undefined) {
    const rawStatuses = query.status
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (rawStatuses.length === 0) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Status filter cannot be empty');
    }
    statusFilter = rawStatuses.map((s) =>
      parseWithSchema(CardStatusSchema, s, `Invalid status filter "${s}"`),
    );
  }

  const dueBeforeMs =
    query.dueBefore !== undefined ? parseDateFilterMs(query.dueBefore, 'end') : undefined;
  const dueAfterMs =
    query.dueAfter !== undefined ? parseDateFilterMs(query.dueAfter, 'start') : undefined;
  const updatedSinceMs =
    query.updatedSince !== undefined ? parseDateFilterMs(query.updatedSince, 'start') : undefined;
  const tagFilter = query.tag !== undefined ? normalizeTag(query.tag) : undefined;

  let firestoreQuery = db
    .collection('cards')
    .where('visibleToUserIds', 'array-contains', auth.ownerUserId);

  if (query.archived !== 'all') {
    firestoreQuery = firestoreQuery.where('archived', '==', query.archived === 'true');
  }

  const snap = await firestoreQuery.get();
  const cards = snap.docs
    .map((doc) => parseStoredCard(doc.id, doc.data()))
    .filter((card) => {
      if (statusFilter && !statusFilter.includes(card.status)) {
        return false;
      }
      if (tagFilter !== undefined && !card.tags.some((tag) => normalizeTag(tag) === tagFilter)) {
        return false;
      }
      if (query.assignedTo !== undefined && !card.assignedUserIds.includes(query.assignedTo)) {
        return false;
      }
      if (query.awareOf !== undefined && !card.awareUserIds.includes(query.awareOf)) {
        return false;
      }
      if (dueBeforeMs !== undefined) {
        if (card.due === null || Date.parse(card.due) > dueBeforeMs) {
          return false;
        }
      }
      if (dueAfterMs !== undefined) {
        if (card.due === null || Date.parse(card.due) < dueAfterMs) {
          return false;
        }
      }
      if (updatedSinceMs !== undefined && Date.parse(card.updatedAt) < updatedSinceMs) {
        return false;
      }
      return true;
    });

  const usePrioritySort =
    query.sort === 'priority' ||
    (query.sort === undefined && statusFilter?.length === 1 && statusFilter[0] === 'todo');

  cards.sort(usePrioritySort ? compareTodoCards : compareUpdatedDesc);

  return { cards };
}

export async function searchCardsHandler(
  auth: AuthContext,
  rawQuery: unknown,
  deps: HandlerDeps = {},
): Promise<{ cards: Card[] }> {
  const query = parseWithSchema(SearchCardsQuerySchema, rawQuery ?? {}, 'Invalid search query');
  const queryTokens = tokenizeQuery(query.q);
  if (queryTokens.length === 0) {
    return { cards: [] };
  }

  const db = deps.db ?? getDb();
  let firestoreQuery = db
    .collection('cards')
    .where('visibleToUserIds', 'array-contains', auth.ownerUserId);

  if (query.archived !== 'all') {
    firestoreQuery = firestoreQuery.where('archived', '==', query.archived === 'true');
  }

  const snap = await firestoreQuery.get();
  const cards = snap.docs
    .map((doc) => parseStoredCard(doc.id, doc.data()))
    .filter((card) => matchesSearchQuery(card.searchTokens, query.q));

  cards.sort(compareUpdatedDesc);

  return { cards };
}

export async function getCardByIdHandler(
  auth: AuthContext,
  rawCardId: unknown,
  deps: HandlerDeps = {},
): Promise<{ card: Card }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const db = deps.db ?? getDb();

  const snap = await db.collection('cards').doc(cardId).get();
  const card = snap.exists ? parseStoredCard(snap.id, snap.data() ?? {}) : null;

  return {
    card: assertCardVisible(card, auth.ownerUserId),
  };
}

export async function getCardByTrelloHandler(
  auth: AuthContext,
  rawQuery: unknown,
  deps: HandlerDeps = {},
): Promise<{ card: Card }> {
  const query = parseWithSchema(
    TrelloLookupQuerySchema,
    rawQuery ?? {},
    'Invalid Trello lookup parameters',
  );
  if (!query.url && !query.shortLink) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Either "url" or "shortLink" query parameter is required',
    );
  }

  const db = deps.db ?? getDb();
  const snap = await db
    .collection('cards')
    .where('visibleToUserIds', 'array-contains', auth.ownerUserId)
    .get();

  const normalizedQueryUrl = query.url ? normalizeUrlForComparison(query.url) : null;
  const queryUrlShortLink = query.url ? extractTrelloShortLink(query.url) : null;

  const matches = snap.docs
    .map((doc) => parseStoredCard(doc.id, doc.data()))
    .filter((card) => {
      const cardShortLink = card.trelloShortLink ?? extractTrelloShortLink(card.trelloUrl);
      const shortLinkMatches = query.shortLink !== undefined && cardShortLink === query.shortLink;

      let urlMatches = false;
      if (normalizedQueryUrl !== null && card.trelloUrl !== null) {
        const normalizedCardUrl = normalizeUrlForComparison(card.trelloUrl);
        urlMatches =
          normalizedCardUrl === normalizedQueryUrl ||
          (queryUrlShortLink !== null && cardShortLink === queryUrlShortLink);
      } else if (queryUrlShortLink !== null && cardShortLink === queryUrlShortLink) {
        urlMatches = true;
      }

      if (query.shortLink !== undefined && query.url !== undefined) {
        return shortLinkMatches && urlMatches;
      }
      return shortLinkMatches || urlMatches;
    });

  if (matches.length === 0) {
    throw new AppError(404, 'CARD_NOT_FOUND', 'Card not found');
  }

  matches.sort((a, b) => {
    if (a.archived !== b.archived) {
      return a.archived ? 1 : -1;
    }
    return compareUpdatedDesc(a, b);
  });

  const matched = matches[0];
  if (!matched) {
    throw new AppError(404, 'CARD_NOT_FOUND', 'Card not found');
  }

  return { card: matched };
}

export async function updateCardHandler(
  auth: AuthContext,
  rawCardId: unknown,
  rawInput: unknown,
  deps: HandlerDeps = {},
): Promise<{ card: Card }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const input = parseWithSchema(UpdateCardInputSchema, rawInput, 'Invalid card update payload');
  const db = deps.db ?? getDb();
  const getNow = deps.now ?? (() => new Date());

  const cardRef = db.collection('cards').doc(cardId);

  const updated = await db.runTransaction(async (tx) => {
    const snap = await tx.get(cardRef);
    const existing = assertCardVisible(
      snap.exists ? parseStoredCard(snap.id, snap.data() ?? {}) : null,
      auth.ownerUserId,
    );

    if (input.ifUpdatedAt !== undefined && input.ifUpdatedAt !== existing.updatedAt) {
      throw new AppError(409, 'CONFLICT', 'Card was modified concurrently', {
        expectedUpdatedAt: input.ifUpdatedAt,
        actualUpdatedAt: existing.updatedAt,
      });
    }

    const nowIso = nextMonotonicIso(existing.updatedAt, getNow());
    const title = input.title ?? existing.title;
    const description = input.description ?? existing.description;
    const status = input.status ?? existing.status;
    const tags = input.tags !== undefined ? normalizeTags(input.tags) : existing.tags;
    const assignedUserIds =
      input.assignedUserIds !== undefined
        ? dedupeStrings(input.assignedUserIds)
        : existing.assignedUserIds;
    const awareUserIds =
      input.awareUserIds !== undefined ? dedupeStrings(input.awareUserIds) : existing.awareUserIds;
    const visibleToUserIds = dedupeStrings([...assignedUserIds, ...awareUserIds]);

    if (visibleToUserIds.length === 0) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'At least one assigned or aware user is required for card visibility',
      );
    }

    const dueChanged =
      (input.due !== undefined && input.due !== existing.due) ||
      (input.dueHasTime !== undefined && input.dueHasTime !== existing.dueHasTime);
    const due = input.due !== undefined ? input.due : existing.due;
    const trelloUrl = input.trelloUrl !== undefined ? input.trelloUrl : existing.trelloUrl;
    let trelloShortLink =
      input.trelloShortLink !== undefined ? input.trelloShortLink : existing.trelloShortLink;

    if (
      input.trelloUrl !== undefined &&
      input.trelloUrl !== existing.trelloUrl &&
      input.trelloUrl !== null &&
      input.trelloShortLink === undefined &&
      existing.trelloShortLink === null
    ) {
      trelloShortLink = extractTrelloShortLink(input.trelloUrl);
    }

    const nextCard = CardSchema.parse({
      ...existing,
      title,
      description,
      status,
      tags,
      assignedUserIds,
      awareUserIds,
      visibleToUserIds,
      priorityScore:
        input.priorityScore !== undefined ? input.priorityScore : existing.priorityScore,
      priorityReason:
        input.priorityReason !== undefined ? input.priorityReason : existing.priorityReason,
      due,
      dueFirm: input.dueFirm !== undefined ? input.dueFirm : existing.dueFirm,
      dueHasTime: input.dueHasTime !== undefined ? input.dueHasTime : existing.dueHasTime,
      recurrence: input.recurrence !== undefined ? input.recurrence : existing.recurrence,
      archived: input.archived !== undefined ? input.archived : existing.archived,
      trelloUrl,
      trelloShortLink,
      enteredStatusAt: status !== existing.status ? nowIso : existing.enteredStatusAt,
      lastTouchedAt: nowIso,
      updatedAt: nowIso,
      searchTokens: buildSearchTokens({
        title,
        description,
        checklists: existing.checklists,
      }),
      dueSoonNotifiedAt: dueChanged ? null : existing.dueSoonNotifiedAt,
      overdueNotifiedAt: dueChanged ? null : existing.overdueNotifiedAt,
    });

    const diff = computeFieldDiff(existing, nextCard, TRACKED_CARD_DIFF_FIELDS);
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

    return nextCard;
  });

  return { card: updated };
}

export async function changeCardStatusHandler(
  auth: AuthContext,
  rawCardId: unknown,
  rawInput: unknown,
  deps: HandlerDeps = {},
): Promise<{ card: Card }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const input = parseWithSchema(
    ChangeCardStatusInputSchema,
    rawInput,
    'Invalid status transition payload',
  );
  const db = deps.db ?? getDb();
  const getNow = deps.now ?? (() => new Date());

  const cardRef = db.collection('cards').doc(cardId);

  const updated = await db.runTransaction(async (tx) => {
    const snap = await tx.get(cardRef);
    const existing = assertCardVisible(
      snap.exists ? parseStoredCard(snap.id, snap.data() ?? {}) : null,
      auth.ownerUserId,
    );

    if (input.ifUpdatedAt !== undefined && input.ifUpdatedAt !== existing.updatedAt) {
      throw new AppError(409, 'CONFLICT', 'Card was modified concurrently', {
        expectedUpdatedAt: input.ifUpdatedAt,
        actualUpdatedAt: existing.updatedAt,
      });
    }

    const nowIso = nextMonotonicIso(existing.updatedAt, getNow());
    const statusChanged = input.status !== existing.status;

    const nextCard = CardSchema.parse({
      ...existing,
      status: input.status,
      enteredStatusAt: statusChanged ? nowIso : existing.enteredStatusAt,
      lastTouchedAt: nowIso,
      updatedAt: nowIso,
    });

    const diff = computeFieldDiff(existing, nextCard, ['status']);
    const activity = buildActivityEntry({
      cardId: nextCard.id,
      visibleToUserIds: nextCard.visibleToUserIds,
      auth,
      action: 'card.status_changed',
      diff,
      note: input.note ?? null,
      createdAt: nowIso,
    });

    tx.set(cardRef, nextCard);
    writeActivityInTransaction(tx, db, activity);
    writeEventInTransaction(tx, db, {
      type: 'card.status_changed',
      card: nextCard,
      auth,
      payload: {
        fromStatus: existing.status,
        toStatus: nextCard.status,
      },
      note: input.note ?? null,
      createdAt: nowIso,
    });

    return nextCard;
  });

  return { card: updated };
}

export async function archiveCardHandler(
  auth: AuthContext,
  rawCardId: unknown,
  rawInput: unknown,
  deps: HandlerDeps = {},
): Promise<{ card: Card }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const input = parseWithSchema(ArchiveCardInputSchema, rawInput ?? {}, 'Invalid archive payload');
  const db = deps.db ?? getDb();
  const getNow = deps.now ?? (() => new Date());

  const cardRef = db.collection('cards').doc(cardId);

  const updated = await db.runTransaction(async (tx) => {
    const snap = await tx.get(cardRef);
    const existing = assertCardVisible(
      snap.exists ? parseStoredCard(snap.id, snap.data() ?? {}) : null,
      auth.ownerUserId,
    );

    if (input.ifUpdatedAt !== undefined && input.ifUpdatedAt !== existing.updatedAt) {
      throw new AppError(409, 'CONFLICT', 'Card was modified concurrently', {
        expectedUpdatedAt: input.ifUpdatedAt,
        actualUpdatedAt: existing.updatedAt,
      });
    }

    const nowIso = nextMonotonicIso(existing.updatedAt, getNow());

    const nextCard = CardSchema.parse({
      ...existing,
      archived: input.archived,
      lastTouchedAt: nowIso,
      updatedAt: nowIso,
    });

    const diff = computeFieldDiff(existing, nextCard, ['archived']);
    const activity = buildActivityEntry({
      cardId: nextCard.id,
      visibleToUserIds: nextCard.visibleToUserIds,
      auth,
      action: input.archived ? 'card.archived' : 'card.unarchived',
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
      payload: { archived: nextCard.archived },
      note: input.note ?? null,
      createdAt: nowIso,
    });

    return nextCard;
  });

  return { card: updated };
}

export interface CompleteCardHandlerDeps extends HandlerDeps {
  householdTimezone?: string;
}

export async function completeCardHandler(
  auth: AuthContext,
  rawCardId: unknown,
  rawInput: unknown,
  deps: CompleteCardHandlerDeps = {},
): Promise<{ card: Card; recurringReset: boolean }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const input = parseWithSchema(
    CompleteCardInputSchema,
    rawInput ?? {},
    'Invalid completion payload',
  );
  const db = deps.db ?? getDb();
  const getNow = deps.now ?? (() => new Date());

  const cardRef = db.collection('cards').doc(cardId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(cardRef);
    const existing = assertCardVisible(
      snap.exists ? parseStoredCard(snap.id, snap.data() ?? {}) : null,
      auth.ownerUserId,
    );

    if (input.ifUpdatedAt !== undefined && input.ifUpdatedAt !== existing.updatedAt) {
      throw new AppError(409, 'CONFLICT', 'Card was modified concurrently', {
        expectedUpdatedAt: input.ifUpdatedAt,
        actualUpdatedAt: existing.updatedAt,
      });
    }

    const nowIso = nextMonotonicIso(existing.updatedAt, getNow());

    if (existing.recurrence === null) {
      const nextCard = CardSchema.parse({
        ...existing,
        status: 'done',
        enteredStatusAt: existing.status !== 'done' ? nowIso : existing.enteredStatusAt,
        lastTouchedAt: nowIso,
        updatedAt: nowIso,
      });

      const diff = computeFieldDiff(existing, nextCard, ['status']);
      const activity = buildActivityEntry({
        cardId: nextCard.id,
        visibleToUserIds: nextCard.visibleToUserIds,
        auth,
        action: 'card.completed',
        diff,
        note: input.note ?? null,
        createdAt: nowIso,
      });

      tx.set(cardRef, nextCard);
      writeActivityInTransaction(tx, db, activity);
      writeEventInTransaction(tx, db, {
        type: 'card.completed',
        card: nextCard,
        auth,
        payload: {
          recurringReset: false,
          previousDue: existing.due,
          nextDue: nextCard.due,
        },
        note: input.note ?? null,
        createdAt: nowIso,
      });

      return {
        card: nextCard,
        recurringReset: false,
      };
    }

    const defaultTz = deps.householdTimezone ?? getConfig().householdTimezone;
    let nextDue: string;
    try {
      nextDue = computeNextDueDate(existing.recurrence, nowIso, existing.due, defaultTz, {
        dueHasTime: existing.dueHasTime,
      });
    } catch (error) {
      throw new AppError(
        400,
        'INVALID_RECURRENCE',
        error instanceof Error ? error.message : 'Invalid card recurrence rule',
      );
    }

    const resetChecklists: Checklist[] = existing.checklists.map((chk) => ({
      ...chk,
      items: chk.items.map((item) => ({
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
      dueSoonNotifiedAt: null,
      overdueNotifiedAt: null,
      enteredStatusAt: nowIso,
      lastTouchedAt: nowIso,
      updatedAt: nowIso,
    });

    const diff = computeFieldDiff(existing, nextCard, [
      'status',
      'due',
      'priorityScore',
      'priorityReason',
      'checklists',
    ]);
    // Always record completed due -> next due on recurring completions even if unchanged.
    diff.due = {
      from: existing.due,
      to: nextDue,
    };

    const activity = buildActivityEntry({
      cardId: nextCard.id,
      visibleToUserIds: nextCard.visibleToUserIds,
      auth,
      action: 'card.completed',
      diff,
      note: input.note ?? null,
      createdAt: nowIso,
    });

    tx.set(cardRef, nextCard);
    writeActivityInTransaction(tx, db, activity);
    writeEventInTransaction(tx, db, {
      type: 'card.completed',
      card: nextCard,
      auth,
      payload: {
        recurringReset: true,
        previousDue: existing.due,
        nextDue,
      },
      note: input.note ?? null,
      createdAt: nowIso,
    });

    return {
      card: nextCard,
      recurringReset: true,
    };
  });
}

export async function listCardActivityHandler(
  auth: AuthContext,
  rawCardId: unknown,
  rawQuery: unknown,
  deps: HandlerDeps = {},
): Promise<{ activity: Activity[]; nextCursor: string | null }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const query = parseWithSchema(
    ActivityPaginationQuerySchema,
    rawQuery ?? {},
    'Invalid activity pagination parameters',
  );
  const db = deps.db ?? getDb();

  const cardSnap = await db.collection('cards').doc(cardId).get();
  assertCardVisible(
    cardSnap.exists ? parseStoredCard(cardSnap.id, cardSnap.data() ?? {}) : null,
    auth.ownerUserId,
  );

  let activityQuery = db
    .collection('activity')
    .where('cardId', '==', cardId)
    .orderBy('createdAt', 'desc');

  if (query.cursor !== undefined) {
    const cursorSnap = await db.collection('activity').doc(query.cursor).get();
    if (!cursorSnap.exists) {
      throw new AppError(400, 'INVALID_CURSOR', 'Invalid pagination cursor');
    }
    const cursorEntry = parseStoredActivity(cursorSnap.id, cursorSnap.data() ?? {});
    if (cursorEntry.cardId !== cardId) {
      throw new AppError(400, 'INVALID_CURSOR', 'Invalid pagination cursor');
    }
    activityQuery = activityQuery.startAfter(cursorSnap);
  }

  const snap = await activityQuery.limit(query.limit + 1).get();
  const hasMore = snap.docs.length > query.limit;
  const pageDocs = hasMore ? snap.docs.slice(0, query.limit) : snap.docs;
  const activity = pageDocs.map((doc) => parseStoredActivity(doc.id, doc.data()));
  const lastEntry = activity[activity.length - 1];

  return {
    activity,
    nextCursor: hasMore && lastEntry ? lastEntry.id : null,
  };
}

export async function listGlobalActivityHandler(
  auth: AuthContext,
  rawQuery: unknown,
  deps: HandlerDeps = {},
): Promise<{ activity: Activity[]; nextCursor: string | null }> {
  const query = parseWithSchema(
    ActivityPaginationQuerySchema,
    rawQuery ?? {},
    'Invalid activity pagination parameters',
  );
  const db = deps.db ?? getDb();

  let activityQuery = db
    .collection('activity')
    .where('visibleToUserIds', 'array-contains', auth.ownerUserId)
    .orderBy('createdAt', 'desc');

  if (query.cursor !== undefined) {
    const cursorSnap = await db.collection('activity').doc(query.cursor).get();
    if (!cursorSnap.exists) {
      throw new AppError(400, 'INVALID_CURSOR', 'Invalid pagination cursor');
    }
    const cursorEntry = parseStoredActivity(cursorSnap.id, cursorSnap.data() ?? {});
    if (!cursorEntry.visibleToUserIds.includes(auth.ownerUserId)) {
      throw new AppError(400, 'INVALID_CURSOR', 'Invalid pagination cursor');
    }
    activityQuery = activityQuery.startAfter(cursorSnap);
  }

  const snap = await activityQuery.limit(query.limit + 1).get();
  const hasMore = snap.docs.length > query.limit;
  const pageDocs = hasMore ? snap.docs.slice(0, query.limit) : snap.docs;
  const activity = pageDocs.map((doc) => parseStoredActivity(doc.id, doc.data()));
  const lastEntry = activity[activity.length - 1];

  return {
    activity,
    nextCursor: hasMore && lastEntry ? lastEntry.id : null,
  };
}
