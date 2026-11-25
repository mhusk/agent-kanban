import crypto from 'node:crypto';
import type { Firestore, Transaction } from 'firebase-admin/firestore';
import {
  AddCardLinkInputSchema,
  CardMutationMetaInputSchema,
  CardSchema,
  CreateCardChecklistInputSchema,
  CreateChecklistItemInputSchema,
  EntityIdSchema,
  UpdateChecklistInputSchema,
  UpdateChecklistItemInputSchema,
  buildSearchTokens,
  type ActivityAction,
  type Card,
  type Checklist,
  type ChecklistItem,
  type FieldDiff,
  type LinkAttachment,
} from '@agent-kanban/shared';
import { AppError, parseWithSchema } from '../lib/errors.js';
import { getDb } from '../lib/firebase.js';
import { buildActivityEntry, writeActivityInTransaction } from '../services/activity.js';
import type { AuthContext } from '../types/express.js';
import { assertCardVisible, nextMonotonicIso, parseStoredCard, type HandlerDeps } from './cards.js';

interface CardMutationResult<TExtra> {
  card: Card;
  extra: TExtra;
}

async function mutateCardInTransaction<TExtra>(
  db: Firestore,
  auth: AuthContext,
  cardId: string,
  ifUpdatedAt: string | undefined,
  note: string | undefined,
  getNow: () => Date,
  apply: (
    existing: Card,
    nowIso: string,
  ) => {
    nextCard: Card;
    action: ActivityAction;
    diff: Record<string, FieldDiff>;
    extra: TExtra;
  },
): Promise<CardMutationResult<TExtra>> {
  const cardRef = db.collection('cards').doc(cardId);

  return db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(cardRef);
    const existing = assertCardVisible(
      snap.exists ? parseStoredCard(snap.id, snap.data() ?? {}) : null,
      auth.ownerUserId,
    );

    if (ifUpdatedAt !== undefined && ifUpdatedAt !== existing.updatedAt) {
      throw new AppError(409, 'CONFLICT', 'Card was modified concurrently', {
        expectedUpdatedAt: ifUpdatedAt,
        actualUpdatedAt: existing.updatedAt,
      });
    }

    const nowIso = nextMonotonicIso(existing.updatedAt, getNow());
    const { nextCard, action, diff, extra } = apply(existing, nowIso);
    const validatedCard = CardSchema.parse(nextCard);

    const activity = buildActivityEntry({
      cardId: validatedCard.id,
      visibleToUserIds: validatedCard.visibleToUserIds,
      auth,
      action,
      diff,
      note: note ?? null,
      createdAt: nowIso,
    });

    tx.set(cardRef, validatedCard);
    writeActivityInTransaction(tx, db, activity);

    return {
      card: validatedCard,
      extra,
    };
  });
}

export async function createChecklistHandler(
  auth: AuthContext,
  rawCardId: unknown,
  rawInput: unknown,
  deps: HandlerDeps = {},
): Promise<{ card: Card; checklist: Checklist }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const input = parseWithSchema(
    CreateCardChecklistInputSchema,
    rawInput,
    'Invalid checklist creation payload',
  );
  const db = deps.db ?? getDb();
  const getNow = deps.now ?? (() => new Date());

  const { card, extra: checklist } = await mutateCardInTransaction(
    db,
    auth,
    cardId,
    input.ifUpdatedAt,
    input.note,
    getNow,
    (existing, nowIso) => {
      const newChecklist: Checklist = {
        id: `chk-${crypto.randomUUID()}`,
        title: input.title,
        items: input.items.map((item) => ({
          id: `chki-${crypto.randomUUID()}`,
          text: item.text,
          checked: item.checked ?? false,
        })),
      };

      const nextChecklists = [...existing.checklists, newChecklist];
      const nextCard: Card = {
        ...existing,
        checklists: nextChecklists,
        lastTouchedAt: nowIso,
        updatedAt: nowIso,
        searchTokens: buildSearchTokens({
          title: existing.title,
          description: existing.description,
          checklists: nextChecklists,
        }),
      };

      return {
        nextCard,
        action: 'card.checklist_created',
        diff: {
          checklist: {
            from: null,
            to: newChecklist,
          },
        },
        extra: newChecklist,
      };
    },
  );

  return { card, checklist };
}

export async function updateChecklistHandler(
  auth: AuthContext,
  rawCardId: unknown,
  rawChecklistId: unknown,
  rawInput: unknown,
  deps: HandlerDeps = {},
): Promise<{ card: Card; checklist: Checklist }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const checklistId = parseWithSchema(EntityIdSchema, rawChecklistId, 'Invalid checklist ID');
  const input = parseWithSchema(
    UpdateChecklistInputSchema,
    rawInput,
    'Invalid checklist update payload',
  );
  const db = deps.db ?? getDb();
  const getNow = deps.now ?? (() => new Date());

  const { card, extra: checklist } = await mutateCardInTransaction(
    db,
    auth,
    cardId,
    input.ifUpdatedAt,
    input.note,
    getNow,
    (existing, nowIso) => {
      const index = existing.checklists.findIndex((chk) => chk.id === checklistId);
      if (index === -1) {
        throw new AppError(404, 'CHECKLIST_NOT_FOUND', 'Checklist not found');
      }

      const prevChecklist = existing.checklists[index]!;
      let nextItems: ChecklistItem[] = prevChecklist.items;

      if (input.items !== undefined) {
        const seenIds = new Set<string>();
        nextItems = input.items.map((item) => {
          const itemId = item.id ?? `chki-${crypto.randomUUID()}`;
          if (seenIds.has(itemId)) {
            throw new AppError(400, 'VALIDATION_ERROR', `Duplicate checklist item ID "${itemId}"`);
          }
          seenIds.add(itemId);
          return {
            id: itemId,
            text: item.text,
            checked: item.checked ?? false,
          };
        });
      }

      const updatedChecklist: Checklist = {
        id: prevChecklist.id,
        title: input.title ?? prevChecklist.title,
        items: nextItems,
      };

      const nextChecklists = existing.checklists.map((chk, i) =>
        i === index ? updatedChecklist : chk,
      );

      const nextCard: Card = {
        ...existing,
        checklists: nextChecklists,
        lastTouchedAt: nowIso,
        updatedAt: nowIso,
        searchTokens: buildSearchTokens({
          title: existing.title,
          description: existing.description,
          checklists: nextChecklists,
        }),
      };

      return {
        nextCard,
        action: 'card.checklist_updated',
        diff: {
          checklist: {
            from: prevChecklist,
            to: updatedChecklist,
          },
        },
        extra: updatedChecklist,
      };
    },
  );

  return { card, checklist };
}

export async function deleteChecklistHandler(
  auth: AuthContext,
  rawCardId: unknown,
  rawChecklistId: unknown,
  rawInput: unknown,
  deps: HandlerDeps = {},
): Promise<{ card: Card }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const checklistId = parseWithSchema(EntityIdSchema, rawChecklistId, 'Invalid checklist ID');
  const input = parseWithSchema(
    CardMutationMetaInputSchema,
    rawInput ?? {},
    'Invalid checklist deletion payload',
  );
  const db = deps.db ?? getDb();
  const getNow = deps.now ?? (() => new Date());

  const { card } = await mutateCardInTransaction(
    db,
    auth,
    cardId,
    input.ifUpdatedAt,
    input.note,
    getNow,
    (existing, nowIso) => {
      const prevChecklist = existing.checklists.find((chk) => chk.id === checklistId);
      if (!prevChecklist) {
        throw new AppError(404, 'CHECKLIST_NOT_FOUND', 'Checklist not found');
      }

      const nextChecklists = existing.checklists.filter((chk) => chk.id !== checklistId);
      const nextCard: Card = {
        ...existing,
        checklists: nextChecklists,
        lastTouchedAt: nowIso,
        updatedAt: nowIso,
        searchTokens: buildSearchTokens({
          title: existing.title,
          description: existing.description,
          checklists: nextChecklists,
        }),
      };

      return {
        nextCard,
        action: 'card.checklist_deleted',
        diff: {
          checklist: {
            from: prevChecklist,
            to: null,
          },
        },
        extra: null,
      };
    },
  );

  return { card };
}

export async function addChecklistItemHandler(
  auth: AuthContext,
  rawCardId: unknown,
  rawChecklistId: unknown,
  rawInput: unknown,
  deps: HandlerDeps = {},
): Promise<{ card: Card; item: ChecklistItem }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const checklistId = parseWithSchema(EntityIdSchema, rawChecklistId, 'Invalid checklist ID');
  const input = parseWithSchema(
    CreateChecklistItemInputSchema,
    rawInput,
    'Invalid checklist item creation payload',
  );
  const db = deps.db ?? getDb();
  const getNow = deps.now ?? (() => new Date());

  const { card, extra: item } = await mutateCardInTransaction(
    db,
    auth,
    cardId,
    input.ifUpdatedAt,
    input.note,
    getNow,
    (existing, nowIso) => {
      const index = existing.checklists.findIndex((chk) => chk.id === checklistId);
      if (index === -1) {
        throw new AppError(404, 'CHECKLIST_NOT_FOUND', 'Checklist not found');
      }

      const targetChecklist = existing.checklists[index]!;
      const newItem: ChecklistItem = {
        id: `chki-${crypto.randomUUID()}`,
        text: input.text,
        checked: input.checked,
      };

      const updatedChecklist: Checklist = {
        ...targetChecklist,
        items: [...targetChecklist.items, newItem],
      };

      const nextChecklists = existing.checklists.map((chk, i) =>
        i === index ? updatedChecklist : chk,
      );

      const nextCard: Card = {
        ...existing,
        checklists: nextChecklists,
        lastTouchedAt: nowIso,
        updatedAt: nowIso,
        searchTokens: buildSearchTokens({
          title: existing.title,
          description: existing.description,
          checklists: nextChecklists,
        }),
      };

      return {
        nextCard,
        action: 'card.checklist_item_added',
        diff: {
          checklistItem: {
            from: null,
            to: { checklistId, ...newItem },
          },
        },
        extra: newItem,
      };
    },
  );

  return { card, item };
}

export async function updateChecklistItemHandler(
  auth: AuthContext,
  rawCardId: unknown,
  rawChecklistId: unknown,
  rawItemId: unknown,
  rawInput: unknown,
  deps: HandlerDeps = {},
): Promise<{ card: Card; item: ChecklistItem }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const checklistId = parseWithSchema(EntityIdSchema, rawChecklistId, 'Invalid checklist ID');
  const itemId = parseWithSchema(EntityIdSchema, rawItemId, 'Invalid checklist item ID');
  const input = parseWithSchema(
    UpdateChecklistItemInputSchema,
    rawInput,
    'Invalid checklist item update payload',
  );
  const db = deps.db ?? getDb();
  const getNow = deps.now ?? (() => new Date());

  const { card, extra: item } = await mutateCardInTransaction(
    db,
    auth,
    cardId,
    input.ifUpdatedAt,
    input.note,
    getNow,
    (existing, nowIso) => {
      const checklistIndex = existing.checklists.findIndex((chk) => chk.id === checklistId);
      if (checklistIndex === -1) {
        throw new AppError(404, 'CHECKLIST_NOT_FOUND', 'Checklist not found');
      }

      const targetChecklist = existing.checklists[checklistIndex]!;
      const itemIndex = targetChecklist.items.findIndex((entry) => entry.id === itemId);
      if (itemIndex === -1) {
        throw new AppError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'Checklist item not found');
      }

      const prevItem = targetChecklist.items[itemIndex]!;
      const updatedItem: ChecklistItem = {
        id: prevItem.id,
        text: input.text ?? prevItem.text,
        checked: input.checked ?? prevItem.checked,
      };

      const updatedChecklist: Checklist = {
        ...targetChecklist,
        items: targetChecklist.items.map((entry, i) => (i === itemIndex ? updatedItem : entry)),
      };

      const nextChecklists = existing.checklists.map((chk, i) =>
        i === checklistIndex ? updatedChecklist : chk,
      );

      const nextCard: Card = {
        ...existing,
        checklists: nextChecklists,
        lastTouchedAt: nowIso,
        updatedAt: nowIso,
        searchTokens: buildSearchTokens({
          title: existing.title,
          description: existing.description,
          checklists: nextChecklists,
        }),
      };

      return {
        nextCard,
        action: 'card.checklist_item_updated',
        diff: {
          checklistItem: {
            from: { checklistId, ...prevItem },
            to: { checklistId, ...updatedItem },
          },
        },
        extra: updatedItem,
      };
    },
  );

  return { card, item };
}

export async function deleteChecklistItemHandler(
  auth: AuthContext,
  rawCardId: unknown,
  rawChecklistId: unknown,
  rawItemId: unknown,
  rawInput: unknown,
  deps: HandlerDeps = {},
): Promise<{ card: Card }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const checklistId = parseWithSchema(EntityIdSchema, rawChecklistId, 'Invalid checklist ID');
  const itemId = parseWithSchema(EntityIdSchema, rawItemId, 'Invalid checklist item ID');
  const input = parseWithSchema(
    CardMutationMetaInputSchema,
    rawInput ?? {},
    'Invalid checklist item deletion payload',
  );
  const db = deps.db ?? getDb();
  const getNow = deps.now ?? (() => new Date());

  const { card } = await mutateCardInTransaction(
    db,
    auth,
    cardId,
    input.ifUpdatedAt,
    input.note,
    getNow,
    (existing, nowIso) => {
      const checklistIndex = existing.checklists.findIndex((chk) => chk.id === checklistId);
      if (checklistIndex === -1) {
        throw new AppError(404, 'CHECKLIST_NOT_FOUND', 'Checklist not found');
      }

      const targetChecklist = existing.checklists[checklistIndex]!;
      const prevItem = targetChecklist.items.find((entry) => entry.id === itemId);
      if (!prevItem) {
        throw new AppError(404, 'CHECKLIST_ITEM_NOT_FOUND', 'Checklist item not found');
      }

      const updatedChecklist: Checklist = {
        ...targetChecklist,
        items: targetChecklist.items.filter((entry) => entry.id !== itemId),
      };

      const nextChecklists = existing.checklists.map((chk, i) =>
        i === checklistIndex ? updatedChecklist : chk,
      );

      const nextCard: Card = {
        ...existing,
        checklists: nextChecklists,
        lastTouchedAt: nowIso,
        updatedAt: nowIso,
        searchTokens: buildSearchTokens({
          title: existing.title,
          description: existing.description,
          checklists: nextChecklists,
        }),
      };

      return {
        nextCard,
        action: 'card.checklist_item_deleted',
        diff: {
          checklistItem: {
            from: { checklistId, ...prevItem },
            to: null,
          },
        },
        extra: null,
      };
    },
  );

  return { card };
}

export async function addCardLinkHandler(
  auth: AuthContext,
  rawCardId: unknown,
  rawInput: unknown,
  deps: HandlerDeps = {},
): Promise<{ card: Card; link: LinkAttachment }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const input = parseWithSchema(
    AddCardLinkInputSchema,
    rawInput,
    'Invalid link attachment payload',
  );
  const db = deps.db ?? getDb();
  const getNow = deps.now ?? (() => new Date());

  const { card, extra: link } = await mutateCardInTransaction(
    db,
    auth,
    cardId,
    input.ifUpdatedAt,
    input.note,
    getNow,
    (existing, nowIso) => {
      const newLink: LinkAttachment = {
        id: `lnk-${crypto.randomUUID()}`,
        url: input.url,
        label: input.label ?? null,
        createdAt: nowIso,
      };

      const nextCard: Card = {
        ...existing,
        links: [...existing.links, newLink],
        lastTouchedAt: nowIso,
        updatedAt: nowIso,
      };

      return {
        nextCard,
        action: 'card.link_added',
        diff: {
          link: {
            from: null,
            to: newLink,
          },
        },
        extra: newLink,
      };
    },
  );

  return { card, link };
}

export async function deleteCardLinkHandler(
  auth: AuthContext,
  rawCardId: unknown,
  rawLinkId: unknown,
  rawInput: unknown,
  deps: HandlerDeps = {},
): Promise<{ card: Card }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const linkId = parseWithSchema(EntityIdSchema, rawLinkId, 'Invalid link ID');
  const input = parseWithSchema(
    CardMutationMetaInputSchema,
    rawInput ?? {},
    'Invalid link deletion payload',
  );
  const db = deps.db ?? getDb();
  const getNow = deps.now ?? (() => new Date());

  const { card } = await mutateCardInTransaction(
    db,
    auth,
    cardId,
    input.ifUpdatedAt,
    input.note,
    getNow,
    (existing, nowIso) => {
      const prevLink = existing.links.find((lnk) => lnk.id === linkId);
      if (!prevLink) {
        throw new AppError(404, 'LINK_NOT_FOUND', 'Link attachment not found');
      }

      const nextCard: Card = {
        ...existing,
        links: existing.links.filter((lnk) => lnk.id !== linkId),
        lastTouchedAt: nowIso,
        updatedAt: nowIso,
      };

      return {
        nextCard,
        action: 'card.link_removed',
        diff: {
          link: {
            from: prevLink,
            to: null,
          },
        },
        extra: null,
      };
    },
  );

  return { card };
}
