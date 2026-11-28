import http from 'node:http';
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  computeNextDueDate,
  computeRecurrenceDeferUntil,
  type Card,
  type Recurrence,
} from '@agent-kanban/shared';
import { seedEmulator } from '../../../scripts/seed-emulator.js';

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'demo-agent-kanban';
const REGION = 'us-central1';
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST ?? '127.0.0.1:5001';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const BASE_URL = `http://${FUNCTIONS_HOST}/${PROJECT_ID}/${REGION}/api`;

interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

interface StoredEvent {
  id: string;
  type: string;
  cardId: string | null;
  visibleToUserIds: string[];
  note: string | null;
  payload: Record<string, unknown>;
}

interface CapturedWebhook {
  path: string;
  body: {
    type: string;
    cardId: string | null;
    payload: Record<string, unknown>;
  };
}

function getTestFirestore(): Firestore {
  process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST;
  const app = getApps().length > 0 ? getApp() : initializeApp({ projectId: PROJECT_ID });
  return getFirestore(app);
}

async function clearFirestoreEmulator(): Promise<void> {
  const res = await fetch(
    `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    throw new Error(`Failed to clear Firestore emulator: HTTP ${res.status}`);
  }
}

async function getAuthToken(handle: 'alex' | 'sam'): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/dev/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle }),
  });
  if (!res.ok) {
    throw new Error(`Failed to get dev token for ${handle}: HTTP ${res.status}`);
  }
  const data = (await res.json()) as { token: string };
  return data.token;
}

async function apiRequest<T>(
  path: string,
  options: {
    method?: string;
    token: string;
    body?: unknown;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; headers: Headers; data: T }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${options.token}`,
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = (await res.json()) as T;
  return { status: res.status, headers: res.headers, data };
}

async function waitFor<T>(
  check: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs = 12_000,
  intervalMs = 150,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null && value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

async function listStoredEvents(db: Firestore): Promise<StoredEvent[]> {
  const snap = await db.collection('events').get();
  return snap.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      type: typeof data.type === 'string' ? data.type : '',
      cardId: typeof data.cardId === 'string' ? data.cardId : null,
      visibleToUserIds: Array.isArray(data.visibleToUserIds)
        ? data.visibleToUserIds.filter((id): id is string => typeof id === 'string')
        : [],
      note: typeof data.note === 'string' ? data.note : null,
      payload:
        typeof data.payload === 'object' && data.payload !== null
          ? (data.payload as Record<string, unknown>)
          : {},
    };
  });
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

describe('Hardened bulk updates, visibility-grouped events & recurring-safe complete (Emulator)', () => {
  let db: Firestore;
  let alexToken: string;
  let samToken: string;
  let samApiKey: string;
  let server: http.Server;
  let receiverBaseUrl: string;
  let captured: CapturedWebhook[] = [];

  beforeAll(async () => {
    db = getTestFirestore();
    await clearFirestoreEmulator();
    await seedEmulator(db);

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        captured.push({
          path: req.url ?? '/',
          body: JSON.parse(rawBody) as CapturedWebhook['body'],
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to bind local mock webhook server');
    }
    receiverBaseUrl = `http://127.0.0.1:${addr.port}`;

    alexToken = await getAuthToken('alex');
    samToken = await getAuthToken('sam');
    const connRes = await apiRequest<{ connection: { id: string }; apiKey: string }>(
      '/api/agent-connections',
      {
        method: 'POST',
        token: samToken,
        body: { platform: 'Bulk Safety Bot' },
      },
    );
    expect(connRes.status).toBe(201);
    samApiKey = connRes.data.apiKey;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('writes one cards.bulk_updated event and one webhook for five shared cards', async () => {
    const created = await Promise.all(
      [1, 2, 3, 4, 5].map((index) =>
        apiRequest<{ card: Card }>('/api/cards', {
          method: 'POST',
          token: alexToken,
          body: {
            title: `Shared bulk ${index}`,
            assignedUserIds: ['user-alex'],
            awareUserIds: ['user-sam'],
            tags: ['household'],
            priorityScore: 40,
            priorityReason: 'Seeded score',
          },
        }),
      ),
    );
    for (const result of created) {
      expect(result.status).toBe(201);
    }
    const cardIds = created.map((result) => result.data.card.id);

    const sub = await apiRequest<{ subscription: { id: string } }>('/api/subscriptions', {
      method: 'POST',
      token: alexToken,
      body: {
        webhookUrl: `${receiverBaseUrl}/alex-five`,
        authType: 'bearer',
        secret: 'bulk-five-secret-value',
        filters: {
          eventTypes: ['cards.bulk_updated'],
          tags: ['bulk-shared'],
          statuses: ['todo'],
          assignedUserIds: ['user-alex'],
        },
      },
    });
    expect(sub.status).toBe(201);
    captured = captured.filter((entry) => entry.path !== '/alex-five');

    const bulk = await apiRequest<{ cards: Card[] }>('/api/cards/bulk', {
      method: 'PATCH',
      token: alexToken,
      body: {
        updates: cardIds.map((cardId) => ({
          cardId,
          addTags: ['Bulk-Shared'],
          pinned: true,
          deferUntil: '2026-12-01T15:00:00.000Z',
          rescoreRequested: true,
        })),
        note: 'm7-five-shared',
      },
    });
    expect(bulk.status).toBe(200);
    expect(bulk.data.cards).toHaveLength(5);
    for (const card of bulk.data.cards) {
      expect(card.tags).toEqual(['household', 'bulk-shared']);
      expect(card.pinned).toBe(true);
      expect(card.deferUntil).toBe('2026-12-01T15:00:00.000Z');
      expect(card.priorityScore).toBeNull();
      expect(card.priorityReason).toBeNull();
      expect(card.status).toBe('todo');
    }

    const events = (await listStoredEvents(db)).filter((event) => event.note === 'm7-five-shared');
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe('cards.bulk_updated');
    expect(event.cardId).toBeNull();
    expect(event.visibleToUserIds).toEqual(['user-alex', 'user-sam']);
    expect(stringArray(event.payload.cardIds).sort()).toEqual([...cardIds].sort());
    expect(event.payload.count).toBe(5);
    expect(event.payload.tags).toEqual(['household', 'bulk-shared']);
    expect(event.payload.statuses).toEqual(['todo']);
    expect(event.payload.assignedUserIds).toEqual(['user-alex']);
    expect(event.payload.actionSummary).toBe('updated');
    expect(event.payload.rescoreRequested).toBe(true);

    const perCardUpdates = (await listStoredEvents(db)).filter(
      (entry) =>
        entry.type === 'card.updated' && entry.cardId !== null && cardIds.includes(entry.cardId),
    );
    expect(perCardUpdates).toHaveLength(0);

    const delivery = await waitFor(async () => {
      const matches = captured.filter((entry) => entry.path === '/alex-five');
      return matches.length > 0 ? matches : null;
    });
    expect(delivery).toHaveLength(1);
    expect(delivery[0]!.body.type).toBe('cards.bulk_updated');
    expect(stringArray(delivery[0]!.body.payload.cardIds)).toHaveLength(5);

    const deliveryDocs = await waitFor(async () => {
      const snap = await db.collection('webhookDeliveries').where('eventId', '==', event.id).get();
      return snap.size > 0 ? snap : null;
    });
    expect(deliveryDocs.size).toBe(1);
  }, 30_000);

  it('isolates private card ids from another member on mixed-visibility bulk updates', async () => {
    const privateCard = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Alex private bulk',
        assignedUserIds: ['user-alex'],
        awareUserIds: [],
      },
    });
    const sharedCard = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Shared mixed bulk',
        assignedUserIds: ['user-alex'],
        awareUserIds: ['user-sam'],
      },
    });
    expect(privateCard.status).toBe(201);
    expect(sharedCard.status).toBe(201);

    const sub = await apiRequest<{ subscription: { id: string } }>('/api/subscriptions', {
      method: 'POST',
      token: samToken,
      body: {
        webhookUrl: `${receiverBaseUrl}/sam-mixed`,
        authType: 'bearer',
        secret: 'bulk-mixed-secret-value',
        filters: {
          eventTypes: ['cards.bulk_updated'],
          tags: ['m7-mixed'],
        },
      },
    });
    expect(sub.status).toBe(201);
    captured = captured.filter((entry) => entry.path !== '/sam-mixed');

    const bulk = await apiRequest<{ cards: Card[] }>('/api/cards/bulk', {
      method: 'PATCH',
      token: alexToken,
      body: {
        updates: [
          { cardId: privateCard.data.card.id, addTags: ['m7-mixed'] },
          { cardId: sharedCard.data.card.id, addTags: ['m7-mixed'] },
        ],
        note: 'm7-mixed-visibility',
      },
    });
    expect(bulk.status).toBe(200);

    const events = (await listStoredEvents(db)).filter(
      (event) => event.note === 'm7-mixed-visibility',
    );
    expect(events).toHaveLength(2);

    const privateEvent = events.find((event) => event.visibleToUserIds.length === 1);
    const sharedEvent = events.find((event) => event.visibleToUserIds.length === 2);
    expect(privateEvent?.cardId).toBe(privateCard.data.card.id);
    expect(privateEvent?.visibleToUserIds).toEqual(['user-alex']);
    expect(stringArray(privateEvent?.payload.cardIds)).toEqual([privateCard.data.card.id]);
    expect(sharedEvent?.cardId).toBe(sharedCard.data.card.id);
    expect(sharedEvent?.visibleToUserIds).toEqual(['user-alex', 'user-sam']);
    expect(stringArray(sharedEvent?.payload.cardIds)).toEqual([sharedCard.data.card.id]);
    expect(JSON.stringify(sharedEvent?.payload)).not.toContain(privateCard.data.card.id);

    const samDelivery = await waitFor(async () => {
      const matches = captured.filter((entry) => entry.path === '/sam-mixed');
      return matches.length > 0 ? matches : null;
    });
    expect(samDelivery).toHaveLength(1);
    expect(stringArray(samDelivery[0]!.body.payload.cardIds)).toEqual([sharedCard.data.card.id]);
    expect(JSON.stringify(samDelivery[0]!.body)).not.toContain(privateCard.data.card.id);

    const polled = await apiRequest<{ events: Array<{ payload: Record<string, unknown> }> }>(
      '/api/events?type=cards.bulk_updated&limit=100',
      { token: samToken },
    );
    expect(polled.status).toBe(200);
    for (const event of polled.data.events) {
      expect(JSON.stringify(event.payload)).not.toContain(privateCard.data.card.id);
    }
  }, 30_000);

  it('applies assignee deltas, sets cardId for a single-card group, and rejects empty visibility', async () => {
    const created = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Assignee delta card',
        assignedUserIds: ['user-alex'],
        awareUserIds: [],
      },
    });
    expect(created.status).toBe(201);
    const cardId = created.data.card.id;

    const shared = await apiRequest<{ cards: Card[] }>('/api/cards/bulk', {
      method: 'PATCH',
      token: alexToken,
      body: {
        updates: [{ cardId, addAwareUserIds: ['user-sam'], pinned: true }],
        note: 'm7-assignee-add',
      },
    });
    expect(shared.status).toBe(200);
    expect(shared.data.cards[0]!.pinned).toBe(true);
    expect(shared.data.cards[0]!.visibleToUserIds.sort()).toEqual(['user-alex', 'user-sam']);
    const samRead = await apiRequest<{ card: Card }>(`/api/cards/${cardId}`, { token: samToken });
    expect(samRead.status).toBe(200);

    const addEvents = (await listStoredEvents(db)).filter(
      (event) => event.note === 'm7-assignee-add',
    );
    expect(addEvents).toHaveLength(1);
    expect(addEvents[0]!.cardId).toBe(cardId);
    expect(addEvents[0]!.visibleToUserIds).toEqual(['user-alex', 'user-sam']);

    const removed = await apiRequest<{ cards: Card[] }>('/api/cards/bulk', {
      method: 'PATCH',
      token: alexToken,
      body: {
        updates: [{ cardId, removeAwareUserIds: ['user-sam'] }],
        note: 'm7-assignee-remove',
      },
    });
    expect(removed.status).toBe(200);
    expect(removed.data.cards[0]!.visibleToUserIds).toEqual(['user-alex']);
    expect(removed.data.cards[0]!.assignedUserIds).toEqual(['user-alex']);
    const samHidden = await apiRequest<ApiErrorBody>(`/api/cards/${cardId}`, { token: samToken });
    expect(samHidden.status).toBe(404);

    const unchangedAt = removed.data.cards[0]!.updatedAt;
    const rejected = await apiRequest<ApiErrorBody>('/api/cards/bulk', {
      method: 'PATCH',
      token: alexToken,
      body: {
        updates: [{ cardId, assignedUserIds: [], awareUserIds: [] }],
      },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.data.error.code).toBe('VALIDATION_ERROR');
    const afterReject = await apiRequest<{ card: Card }>(`/api/cards/${cardId}`, {
      token: alexToken,
    });
    expect(afterReject.data.card.updatedAt).toBe(unchangedAt);
    expect(afterReject.data.card.visibleToUserIds).toEqual(['user-alex']);
  });

  it('suppresses events when an agent bulk-updates or bulk-completes cards', async () => {
    const created = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: samToken,
      body: {
        title: 'Agent bulk target',
        assignedUserIds: ['user-sam'],
        awareUserIds: [],
        pinned: false,
      },
    });
    expect(created.status).toBe(201);
    const cardId = created.data.card.id;
    const beforeIds = new Set((await listStoredEvents(db)).map((event) => event.id));

    const updated = await apiRequest<{ cards: Card[] }>('/api/cards/bulk', {
      method: 'PATCH',
      token: samApiKey,
      headers: { 'X-Agent-Name': 'Bulk Safety Bot' },
      body: {
        updates: [{ cardId, pinned: true }],
        note: 'm7-agent-update',
      },
    });
    expect(updated.status).toBe(200);
    expect(updated.data.cards[0]!.pinned).toBe(true);

    const completed = await apiRequest<{ cards: Card[] }>('/api/cards/bulk/complete', {
      method: 'POST',
      token: samApiKey,
      headers: { 'X-Agent-Name': 'Bulk Safety Bot' },
      body: { cardIds: [cardId], note: 'm7-agent-complete' },
    });
    expect(completed.status).toBe(200);
    expect(completed.data.cards[0]!.status).toBe('done');
    expect(completed.data.cards[0]!.pinned).toBe(false);
    expect(completed.data.cards[0]!.lastCompletedAt).toBe(completed.data.cards[0]!.updatedAt);

    const createdEvents = (await listStoredEvents(db)).filter((event) => !beforeIds.has(event.id));
    expect(createdEvents).toHaveLength(0);
  });

  it('atomically completes mixed recurring and non-recurring cards and replays idempotently', async () => {
    const snapshot = await apiRequest<{ timezone: string }>('/api/workspace/snapshot', {
      token: alexToken,
    });
    expect(snapshot.status).toBe(200);
    const timezone = snapshot.data.timezone;
    const recurrence: Recurrence = {
      type: 'interval_after_completion',
      every: 7,
      unit: 'days',
      autoDefer: true,
    };
    const originalDue = '2026-06-08T15:00:00.000Z';

    const recurring = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Weekly bins',
        assignedUserIds: ['user-alex'],
        awareUserIds: ['user-sam'],
        due: originalDue,
        dueHasTime: true,
        recurrence,
        pinned: true,
        priorityScore: 80,
        priorityReason: 'Due this week',
        checklists: [{ title: 'Bins', items: [{ text: 'Roll cart to curb', checked: true }] }],
      },
    });
    const oneOff = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'One-off errand',
        assignedUserIds: ['user-alex'],
        awareUserIds: ['user-sam'],
        pinned: true,
        deferUntil: '2026-12-01T15:00:00.000Z',
      },
    });
    expect(recurring.status).toBe(201);
    expect(oneOff.status).toBe(201);
    const recurringId = recurring.data.card.id;
    const oneOffId = oneOff.data.card.id;

    const untouched = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Should stay open',
        assignedUserIds: ['user-alex'],
        awareUserIds: [],
      },
    });
    expect(untouched.status).toBe(201);
    const missing = await apiRequest<ApiErrorBody>('/api/cards/bulk/complete', {
      method: 'POST',
      token: alexToken,
      body: { cardIds: [untouched.data.card.id, 'card-missing-m7'] },
    });
    expect(missing.status).toBe(404);
    const untouchedAfter = await apiRequest<{ card: Card }>(
      `/api/cards/${untouched.data.card.id}`,
      {
        token: alexToken,
      },
    );
    expect(untouchedAfter.data.card.updatedAt).toBe(untouched.data.card.updatedAt);
    expect(untouchedAfter.data.card.status).toBe('todo');

    const idempotencyKey = 'm7-bulk-complete-mixed';
    const completed = await apiRequest<{
      cards: Card[];
      completedCardIds: string[];
      recurringResetCardIds: string[];
    }>('/api/cards/bulk/complete', {
      method: 'POST',
      token: alexToken,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: {
        cardIds: [oneOffId, recurringId],
        note: 'm7-bulk-complete',
      },
    });
    expect(completed.status).toBe(200);
    expect(completed.headers.get('x-idempotent-replay')).toBeNull();
    expect(completed.data.completedCardIds).toEqual([oneOffId]);
    expect(completed.data.recurringResetCardIds).toEqual([recurringId]);

    const doneCard = completed.data.cards.find((card) => card.id === oneOffId);
    const resetCard = completed.data.cards.find((card) => card.id === recurringId);
    expect(doneCard?.status).toBe('done');
    expect(doneCard?.pinned).toBe(false);
    expect(doneCard?.deferUntil).toBeNull();
    expect(doneCard?.lastCompletedAt).toBe(doneCard?.updatedAt);

    expect(resetCard?.status).toBe('todo');
    expect(resetCard?.pinned).toBe(false);
    expect(resetCard?.priorityScore).toBeNull();
    expect(resetCard?.priorityReason).toBeNull();
    expect(resetCard?.lastCompletedAt).toBe(resetCard?.updatedAt);
    expect(resetCard?.checklists[0]?.items[0]?.checked).toBe(false);
    const completedAt = resetCard?.lastCompletedAt;
    expect(completedAt).toBeTruthy();
    const expectedDue = computeNextDueDate(recurrence, completedAt!, originalDue, timezone, {
      dueHasTime: true,
    });
    expect(resetCard?.due).toBe(expectedDue);
    expect(resetCard?.deferUntil).toBe(
      computeRecurrenceDeferUntil(recurrence, expectedDue, completedAt!, timezone, {
        dueHasTime: true,
      }),
    );

    for (const cardId of [oneOffId, recurringId]) {
      const activity = await apiRequest<{
        activity: Array<{ action: string; note: string | null }>;
      }>(`/api/cards/${cardId}/activity`, { token: alexToken });
      expect(
        activity.data.activity.some(
          (entry) => entry.action === 'card.completed' && entry.note === 'm7-bulk-complete',
        ),
      ).toBe(true);
    }

    const batchEvents = (await listStoredEvents(db)).filter(
      (event) => event.note === 'm7-bulk-complete',
    );
    expect(batchEvents).toHaveLength(1);
    expect(batchEvents[0]!.type).toBe('cards.bulk_updated');
    expect(batchEvents[0]!.cardId).toBeNull();
    expect(batchEvents[0]!.payload.actionSummary).toBe('completed');
    expect(stringArray(batchEvents[0]!.payload.cardIds)).toEqual([oneOffId, recurringId]);
    expect(stringArray(batchEvents[0]!.payload.completedCardIds)).toEqual([oneOffId]);
    expect(stringArray(batchEvents[0]!.payload.recurringResetCardIds)).toEqual([recurringId]);
    expect(batchEvents[0]!.payload.rescoreRequested).toBe(false);

    const perCardCompleted = (await listStoredEvents(db)).filter(
      (event) =>
        event.type === 'card.completed' &&
        (event.cardId === oneOffId || event.cardId === recurringId),
    );
    expect(perCardCompleted).toHaveLength(0);

    const replay = await apiRequest<{ cards: Card[] }>('/api/cards/bulk/complete', {
      method: 'POST',
      token: alexToken,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: { cardIds: [oneOffId, recurringId], note: 'm7-bulk-complete' },
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('x-idempotent-replay')).toBe('true');
    expect(replay.data.cards.find((card) => card.id === recurringId)?.updatedAt).toBe(
      resetCard?.updatedAt,
    );
    const eventsAfterReplay = (await listStoredEvents(db)).filter(
      (event) => event.note === 'm7-bulk-complete',
    );
    expect(eventsAfterReplay).toHaveLength(1);
  }, 30_000);

  it('rejects status done on a recurring card and leaves the batch unchanged', async () => {
    const recurring = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Recurring must use complete',
        assignedUserIds: ['user-alex'],
        awareUserIds: [],
        recurrence: { type: 'interval_after_completion', every: 14, unit: 'days' },
      },
    });
    const normal = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Normal status sibling',
        assignedUserIds: ['user-alex'],
        awareUserIds: [],
      },
    });
    expect(recurring.status).toBe(201);
    expect(normal.status).toBe(201);

    const rejected = await apiRequest<ApiErrorBody>('/api/cards/bulk', {
      method: 'PATCH',
      token: alexToken,
      body: {
        updates: [
          { cardId: normal.data.card.id, status: 'doing' },
          { cardId: recurring.data.card.id, status: 'done' },
        ],
      },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.data.error.message).toContain('POST /api/cards/bulk/complete');

    const recurringAfter = await apiRequest<{ card: Card }>(
      `/api/cards/${recurring.data.card.id}`,
      {
        token: alexToken,
      },
    );
    const normalAfter = await apiRequest<{ card: Card }>(`/api/cards/${normal.data.card.id}`, {
      token: alexToken,
    });
    expect(recurringAfter.data.card.status).toBe('todo');
    expect(recurringAfter.data.card.updatedAt).toBe(recurring.data.card.updatedAt);
    expect(normalAfter.data.card.status).toBe('todo');
    expect(normalAfter.data.card.updatedAt).toBe(normal.data.card.updatedAt);

    const allowed = await apiRequest<{ cards: Card[] }>('/api/cards/bulk', {
      method: 'PATCH',
      token: alexToken,
      body: {
        updates: [{ cardId: normal.data.card.id, status: 'done' }],
      },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.data.cards[0]!.status).toBe('done');
  });
});
