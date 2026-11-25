import crypto from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import {
  CommentSchema,
  CreateCommentInputSchema,
  EntityIdSchema,
  extractMentionHandles,
  type Card,
  type Comment,
} from '@agent-kanban/shared';
import { AppError, parseWithSchema } from '../lib/errors.js';
import { getDb } from '../lib/firebase.js';
import { buildActivityEntry, writeActivityInTransaction } from '../services/activity.js';
import type { AuthContext } from '../types/express.js';
import { assertCardVisible, nextMonotonicIso, parseStoredCard, type HandlerDeps } from './cards.js';

const FIRESTORE_IN_CHUNK_SIZE = 30;

function parseStoredComment(id: string, rawData: Record<string, unknown>): Comment {
  const parsed = CommentSchema.safeParse({
    ...rawData,
    id,
  });
  if (!parsed.success) {
    throw new AppError(
      500,
      'INVALID_COMMENT_RECORD',
      `Stored comment "${id}" failed schema validation`,
    );
  }
  return parsed.data;
}

async function resolveMentionUserIds(db: Firestore, handles: readonly string[]): Promise<string[]> {
  if (handles.length === 0) {
    return [];
  }

  const handleToUserId = new Map<string, string>();
  for (let i = 0; i < handles.length; i += FIRESTORE_IN_CHUNK_SIZE) {
    const chunk = handles.slice(i, i + FIRESTORE_IN_CHUNK_SIZE);
    const snap = await db.collection('users').where('handle', 'in', chunk).get();
    for (const doc of snap.docs) {
      const data = doc.data();
      if (typeof data.handle === 'string') {
        handleToUserId.set(data.handle.toLowerCase(), doc.id);
      }
    }
  }

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const handle of handles) {
    const userId = handleToUserId.get(handle.toLowerCase());
    if (userId !== undefined && !seen.has(userId)) {
      seen.add(userId);
      resolved.push(userId);
    }
  }
  return resolved;
}

export async function listCardCommentsHandler(
  auth: AuthContext,
  rawCardId: unknown,
  deps: HandlerDeps = {},
): Promise<{ comments: Comment[] }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const db = deps.db ?? getDb();

  const cardRef = db.collection('cards').doc(cardId);
  const cardSnap = await cardRef.get();
  assertCardVisible(
    cardSnap.exists ? parseStoredCard(cardSnap.id, cardSnap.data() ?? {}) : null,
    auth.ownerUserId,
  );

  const snap = await cardRef.collection('comments').orderBy('createdAt', 'asc').get();
  const comments = snap.docs.map((doc) => parseStoredComment(doc.id, doc.data()));

  return { comments };
}

export async function createCardCommentHandler(
  auth: AuthContext,
  rawCardId: unknown,
  rawInput: unknown,
  deps: HandlerDeps = {},
): Promise<{ comment: Comment; card: Card }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const input = parseWithSchema(
    CreateCommentInputSchema,
    rawInput,
    'Invalid comment creation payload',
  );
  const db = deps.db ?? getDb();
  const getNow = deps.now ?? (() => new Date());

  const handles = extractMentionHandles(input.text);
  const mentions = await resolveMentionUserIds(db, handles);

  const cardRef = db.collection('cards').doc(cardId);

  return db.runTransaction(async (tx) => {
    const cardSnap = await tx.get(cardRef);
    const existing = assertCardVisible(
      cardSnap.exists ? parseStoredCard(cardSnap.id, cardSnap.data() ?? {}) : null,
      auth.ownerUserId,
    );

    const nowIso = nextMonotonicIso(existing.lastTouchedAt, getNow());
    const comment = CommentSchema.parse({
      id: `cmt-${crypto.randomUUID()}`,
      cardId: existing.id,
      actorType: auth.actorType,
      actorId: auth.userId,
      agentName: auth.agentName ?? null,
      platform: auth.platform ?? null,
      text: input.text,
      mentions,
      createdAt: nowIso,
    });

    const updatedCard: Card = {
      ...existing,
      lastTouchedAt: nowIso,
    };

    const activity = buildActivityEntry({
      cardId: existing.id,
      visibleToUserIds: existing.visibleToUserIds,
      auth,
      action: 'card.commented',
      diff: {
        comment: {
          from: null,
          to: {
            id: comment.id,
            text: comment.text,
            mentions: comment.mentions,
          },
        },
      },
      note: input.note ?? null,
      createdAt: nowIso,
    });

    tx.set(cardRef.collection('comments').doc(comment.id), comment);
    tx.update(cardRef, { lastTouchedAt: nowIso });
    writeActivityInTransaction(tx, db, activity);

    return {
      comment,
      card: updatedCard,
    };
  });
}
