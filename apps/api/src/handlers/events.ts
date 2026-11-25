import { z } from 'zod';
import {
  EventSchema,
  EventTypeSchema,
  IsoDateTimeSchema,
  type Event,
  type EventType,
} from '@agent-kanban/shared';
import { AppError, parseWithSchema } from '../lib/errors.js';
import { getDb } from '../lib/firebase.js';
import type { AuthContext } from '../types/express.js';
import type { HandlerDeps } from './cards.js';

export const ListEventsQuerySchema = z.object({
  since: z
    .string()
    .trim()
    .transform((v) => (v.length > 0 ? v : undefined))
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  type: EventTypeSchema.optional(),
});

export function parseStoredEvent(id: string, rawData: Record<string, unknown>): Event {
  const parsed = EventSchema.safeParse({
    ...rawData,
    id,
  });
  if (!parsed.success) {
    throw new AppError(
      500,
      'INVALID_EVENT_RECORD',
      `Stored event "${id}" failed schema validation`,
    );
  }
  return parsed.data;
}

export async function listEventsHandler(
  auth: AuthContext,
  rawQuery: unknown,
  deps: HandlerDeps = {},
): Promise<{ events: Event[]; nextCursor: string | null; hasMore: boolean }> {
  const query = parseWithSchema(
    ListEventsQuerySchema,
    rawQuery ?? {},
    'Invalid event list parameters',
  );
  const db = deps.db ?? getDb();

  let firestoreQuery = db
    .collection('events')
    .where('visibleToUserIds', 'array-contains', auth.ownerUserId)
    .orderBy('createdAt', 'asc');

  if (query.since !== undefined) {
    const cursorSnap = await db.collection('events').doc(query.since).get();
    if (cursorSnap.exists) {
      const cursorEvent = parseStoredEvent(cursorSnap.id, cursorSnap.data() ?? {});
      if (!cursorEvent.visibleToUserIds.includes(auth.ownerUserId)) {
        throw new AppError(400, 'INVALID_CURSOR', 'Invalid events cursor');
      }
      firestoreQuery = firestoreQuery.startAfter(cursorSnap);
    } else if (IsoDateTimeSchema.safeParse(query.since).success) {
      firestoreQuery = firestoreQuery.where('createdAt', '>', query.since);
    } else {
      throw new AppError(400, 'INVALID_CURSOR', 'Invalid events cursor');
    }
  }

  const filterType: EventType | undefined = query.type;
  if (filterType === undefined) {
    const snap = await firestoreQuery.limit(query.limit + 1).get();
    const hasMore = snap.docs.length > query.limit;
    const pageDocs = hasMore ? snap.docs.slice(0, query.limit) : snap.docs;
    const events = pageDocs.map((doc) => parseStoredEvent(doc.id, doc.data()));
    const lastEvent = events[events.length - 1];
    return {
      events,
      nextCursor: lastEvent ? lastEvent.id : (query.since ?? null),
      hasMore,
    };
  }

  // Filter optional event type in memory so no extra composite index is needed.
  const snap = await firestoreQuery.get();
  const matching = snap.docs
    .map((doc) => parseStoredEvent(doc.id, doc.data()))
    .filter((event) => event.type === filterType);
  const hasMore = matching.length > query.limit;
  const events = hasMore ? matching.slice(0, query.limit) : matching;
  const lastEvent = events[events.length - 1];
  return {
    events,
    nextCursor: lastEvent ? lastEvent.id : (query.since ?? null),
    hasMore,
  };
}
