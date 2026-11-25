import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Activity, Card } from '@agent-kanban/shared';
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
    details?: unknown;
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

describe('Core Card CRUD, visibility, sorting, idempotency, preconditions & activity log (Emulator)', () => {
  let db: Firestore;
  let alexToken: string;
  let samToken: string;

  beforeAll(async () => {
    db = getTestFirestore();
    await clearFirestoreEmulator();
    await seedEmulator(db);
    alexToken = await getAuthToken('alex');
    samToken = await getAuthToken('sam');
  });

  it('enforces strict visibility isolation (404 on hidden card IDs, omitted from list/activity)', async () => {
    // Seeded card-seed-3 is private to user-alex
    const alexGet = await apiRequest<{ card: Card }>('/api/cards/card-seed-3', {
      token: alexToken,
    });
    expect(alexGet.status).toBe(200);
    expect(alexGet.data.card.id).toBe('card-seed-3');

    // Create a fresh private card owned by Alex with a note and Trello link
    const createdPrivate = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Alex private birthday gift plan',
        tags: ['private'],
        awareUserIds: [],
        trelloUrl: 'https://trello.com/c/Priv1234/gift-plan',
        note: 'Keep hidden from household feed',
      },
    });
    expect(createdPrivate.status).toBe(201);
    const privateCard = createdPrivate.data.card;
    expect(privateCard.assignedUserIds).toEqual(['user-alex']);
    expect(privateCard.visibleToUserIds).toEqual(['user-alex']);
    expect(privateCard.trelloShortLink).toBe('Priv1234');

    // Sam cannot read, patch, change status, archive, lookup by Trello, or view activity
    const samGet = await apiRequest<ApiErrorBody>(`/api/cards/${privateCard.id}`, {
      token: samToken,
    });
    expect(samGet.status).toBe(404);
    expect(samGet.data.error.code).toBe('CARD_NOT_FOUND');

    const samPatch = await apiRequest<ApiErrorBody>(`/api/cards/${privateCard.id}`, {
      method: 'PATCH',
      token: samToken,
      body: { title: 'Sneaky edit' },
    });
    expect(samPatch.status).toBe(404);

    const samStatus = await apiRequest<ApiErrorBody>(`/api/cards/${privateCard.id}/status`, {
      method: 'POST',
      token: samToken,
      body: { status: 'doing' },
    });
    expect(samStatus.status).toBe(404);

    const samArchive = await apiRequest<ApiErrorBody>(`/api/cards/${privateCard.id}/archive`, {
      method: 'POST',
      token: samToken,
      body: { archived: true },
    });
    expect(samArchive.status).toBe(404);

    const samCardActivity = await apiRequest<ApiErrorBody>(
      `/api/cards/${privateCard.id}/activity`,
      { token: samToken },
    );
    expect(samCardActivity.status).toBe(404);

    const samByTrello = await apiRequest<ApiErrorBody>('/api/cards/by-trello?shortLink=Priv1234', {
      token: samToken,
    });
    expect(samByTrello.status).toBe(404);

    // Omitted from Sam's card list and global activity feed
    const samList = await apiRequest<{ cards: Card[] }>('/api/cards', { token: samToken });
    expect(samList.status).toBe(200);
    expect(samList.data.cards.some((c) => c.id === privateCard.id)).toBe(false);
    expect(samList.data.cards.some((c) => c.id === 'card-seed-3')).toBe(false);

    const samGlobalActivity = await apiRequest<{ activity: Activity[]; nextCursor: string | null }>(
      '/api/activity',
      { token: samToken },
    );
    expect(samGlobalActivity.status).toBe(200);
    expect(samGlobalActivity.data.activity.some((a) => a.cardId === privateCard.id)).toBe(false);
  });

  it('grants full read/write access to both assignedUserIds and awareUserIds', async () => {
    const created = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Shared household pantry audit',
        assignedUserIds: ['user-alex'],
        awareUserIds: ['user-sam'],
        tags: ['groceries'],
      },
    });
    expect(created.status).toBe(201);
    const card = created.data.card;
    expect(card.visibleToUserIds).toEqual(['user-alex', 'user-sam']);

    // Sam (awareUserIds only) can read and edit the card
    const samRead = await apiRequest<{ card: Card }>(`/api/cards/${card.id}`, {
      token: samToken,
    });
    expect(samRead.status).toBe(200);

    const samEdit = await apiRequest<{ card: Card }>(`/api/cards/${card.id}`, {
      method: 'PATCH',
      token: samToken,
      body: {
        description: 'Added vinegar and olive oil to check list.',
        note: 'Sam updated as aware member',
      },
    });
    expect(samEdit.status).toBe(200);
    expect(samEdit.data.card.description).toBe('Added vinegar and olive oil to check list.');
  });

  it('orders todo cards by priorityScore DESC (nulls last), due ASC (nulls last), createdAt ASC and supports filters', async () => {
    // Create dedicated todo cards tagged "sort-check" to test deterministic ordering
    const baseCards = [
      {
        title: 'Sort unscored due later',
        priorityScore: null,
        due: '2026-08-10T23:59:59.000Z',
        tags: ['sort-check'],
      },
      {
        title: 'Sort score 80 due later',
        priorityScore: 80,
        due: '2026-08-05T23:59:59.000Z',
        tags: ['sort-check'],
      },
      {
        title: 'Sort score 95 no due',
        priorityScore: 95,
        due: null,
        tags: ['sort-check'],
      },
      {
        title: 'Sort score 80 due earlier',
        priorityScore: 80,
        due: '2026-08-02T23:59:59.000Z',
        tags: ['sort-check'],
      },
      {
        title: 'Sort unscored no due',
        priorityScore: null,
        due: null,
        tags: ['sort-check'],
      },
      {
        title: 'Sort unscored due earlier',
        priorityScore: null,
        due: '2026-08-03T23:59:59.000Z',
        tags: ['sort-check'],
      },
    ];

    for (const payload of baseCards) {
      const res = await apiRequest<{ card: Card }>('/api/cards', {
        method: 'POST',
        token: alexToken,
        body: {
          ...payload,
          awareUserIds: ['user-sam'],
        },
      });
      expect(res.status).toBe(201);
    }

    const sortedTodo = await apiRequest<{ cards: Card[] }>(
      '/api/cards?status=todo&tag=sort-check',
      { token: alexToken },
    );
    expect(sortedTodo.status).toBe(200);
    expect(sortedTodo.data.cards.map((c) => c.title)).toEqual([
      'Sort score 95 no due',
      'Sort score 80 due earlier',
      'Sort score 80 due later',
      'Sort unscored due earlier',
      'Sort unscored due later',
      'Sort unscored no due',
    ]);

    // Filter by dueBefore / dueAfter
    const dueRange = await apiRequest<{ cards: Card[] }>(
      '/api/cards?status=todo&tag=sort-check&dueAfter=2026-08-02&dueBefore=2026-08-05',
      { token: alexToken },
    );
    expect(dueRange.status).toBe(200);
    expect(dueRange.data.cards.map((c) => c.title)).toEqual([
      'Sort score 80 due earlier',
      'Sort score 80 due later',
      'Sort unscored due earlier',
    ]);

    // Filter by assignedTo / awareOf / updatedSince
    const awareFilter = await apiRequest<{ cards: Card[] }>(
      '/api/cards?status=todo&tag=sort-check&assignedTo=user-alex&awareOf=user-sam',
      { token: samToken },
    );
    expect(awareFilter.status).toBe(200);
    expect(awareFilter.data.cards).toHaveLength(6);

    const futureUpdated = await apiRequest<{ cards: Card[] }>(
      '/api/cards?updatedSince=2099-01-01T00:00:00.000Z',
      { token: alexToken },
    );
    expect(futureUpdated.status).toBe(200);
    expect(futureUpdated.data.cards).toHaveLength(0);
  });

  it('deduplicates POST /api/cards via Idempotency-Key and scopes keys per ownerUserId', async () => {
    const key = 'idem-card-create-001';
    const payload = {
      title: 'Order furnace filters',
      tags: ['home'],
      note: 'Initial idempotent create',
    };

    const first = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      headers: { 'Idempotency-Key': key },
      body: payload,
    });
    expect(first.status).toBe(201);
    expect(first.headers.get('x-idempotent-replay')).toBeNull();

    const replay = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      headers: { 'Idempotency-Key': key },
      body: payload,
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get('x-idempotent-replay')).toBe('true');
    expect(replay.data.card.id).toBe(first.data.card.id);

    // Confirm only 1 card and 1 activity entry were created for this card
    const activitySnap = await db
      .collection('activity')
      .where('cardId', '==', first.data.card.id)
      .get();
    expect(activitySnap.size).toBe(1);

    // Same key used by Sam creates Sam's own distinct card
    const samCreate = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: samToken,
      headers: { 'Idempotency-Key': key },
      body: { title: 'Sam separate idempotent card' },
    });
    expect(samCreate.status).toBe(201);
    expect(samCreate.headers.get('x-idempotent-replay')).toBeNull();
    expect(samCreate.data.card.id).not.toBe(first.data.card.id);
  });

  it('enforces ifUpdatedAt optimistic concurrency (409 Conflict) and resets due notification flags when due changes', async () => {
    const created = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Renew vehicle registration',
        due: '2026-09-01T23:59:59.000Z',
        dueFirm: true,
        awareUserIds: ['user-sam'],
      },
    });
    expect(created.status).toBe(201);
    const card = created.data.card;

    // Simulate scheduled notification timestamps on the card doc
    await db.collection('cards').doc(card.id).update({
      dueSoonNotifiedAt: '2026-08-30T10:00:00.000Z',
      overdueNotifiedAt: '2026-09-02T10:00:00.000Z',
    });

    // Non-due edit with matching ifUpdatedAt succeeds and preserves notification flags
    const nonDuePatch = await apiRequest<{ card: Card }>(`/api/cards/${card.id}`, {
      method: 'PATCH',
      token: alexToken,
      body: {
        title: 'Renew vehicle registration online',
        ifUpdatedAt: card.updatedAt,
        note: 'Clarified online renewal',
      },
    });
    expect(nonDuePatch.status).toBe(200);
    expect(nonDuePatch.data.card.dueSoonNotifiedAt).toBe('2026-08-30T10:00:00.000Z');
    expect(nonDuePatch.data.card.overdueNotifiedAt).toBe('2026-09-02T10:00:00.000Z');

    // Stale ifUpdatedAt returns 409 Conflict without mutating the card
    const stalePatch = await apiRequest<ApiErrorBody>(`/api/cards/${card.id}`, {
      method: 'PATCH',
      token: samToken,
      body: {
        title: 'Stale overwrite attempt',
        ifUpdatedAt: card.updatedAt,
      },
    });
    expect(stalePatch.status).toBe(409);
    expect(stalePatch.data.error.code).toBe('CONFLICT');

    // Changing due resets dueSoonNotifiedAt and overdueNotifiedAt
    const duePatch = await apiRequest<{ card: Card }>(`/api/cards/${card.id}`, {
      method: 'PATCH',
      token: alexToken,
      body: {
        due: '2026-09-15T23:59:59.000Z',
        ifUpdatedAt: nonDuePatch.data.card.updatedAt,
        note: 'Extended deadline',
      },
    });
    expect(duePatch.status).toBe(200);
    expect(duePatch.data.card.due).toBe('2026-09-15T23:59:59.000Z');
    expect(duePatch.data.card.dueSoonNotifiedAt).toBeNull();
    expect(duePatch.data.card.overdueNotifiedAt).toBeNull();
  });

  it('resolves legacy Trello links by trelloUrl and trelloShortLink within visible cards', async () => {
    const created = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Legacy Trello migrated task',
        awareUserIds: ['user-sam'],
        trelloUrl: 'https://trello.com/c/TrElLo99/legacy-board-card',
      },
    });
    expect(created.status).toBe(201);
    const card = created.data.card;
    expect(card.trelloShortLink).toBe('TrElLo99');

    const byUrl = await apiRequest<{ card: Card }>(
      `/api/cards/by-trello?url=${encodeURIComponent('https://trello.com/c/TrElLo99/legacy-board-card')}`,
      { token: samToken },
    );
    expect(byUrl.status).toBe(200);
    expect(byUrl.data.card.id).toBe(card.id);

    const byShortLink = await apiRequest<{ card: Card }>(
      '/api/cards/by-trello?shortLink=TrElLo99',
      { token: samToken },
    );
    expect(byShortLink.status).toBe(200);
    expect(byShortLink.data.card.id).toBe(card.id);
  });

  it('logs accurate activity diffs/notes across status, archive/unarchive, and paginates card & global activity', async () => {
    const created = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Paint hallway trim',
        awareUserIds: ['user-sam'],
        note: 'Initial creation note',
      },
    });
    expect(created.status).toBe(201);
    const c1 = created.data.card;

    // 1. Status transition: todo -> doing (updates enteredStatusAt)
    const doingRes = await apiRequest<{ card: Card }>(`/api/cards/${c1.id}/status`, {
      method: 'POST',
      token: alexToken,
      body: {
        status: 'doing',
        note: 'Taped baseboards',
      },
    });
    expect(doingRes.status).toBe(200);
    expect(doingRes.data.card.status).toBe('doing');
    expect(doingRes.data.card.enteredStatusAt).not.toBe(c1.enteredStatusAt);

    // 2. Idempotent same-status call keeps enteredStatusAt unchanged
    const sameStatusRes = await apiRequest<{ card: Card }>(`/api/cards/${c1.id}/status`, {
      method: 'POST',
      token: alexToken,
      body: {
        status: 'doing',
        note: 'Second coat check',
      },
    });
    expect(sameStatusRes.status).toBe(200);
    expect(sameStatusRes.data.card.enteredStatusAt).toBe(doingRes.data.card.enteredStatusAt);

    // 3. Archive & confirm excluded from default list, included when archived=true
    const archiveRes = await apiRequest<{ card: Card }>(`/api/cards/${c1.id}/archive`, {
      method: 'POST',
      token: samToken,
      body: {
        archived: true,
        note: 'Deferred until spring',
      },
    });
    expect(archiveRes.status).toBe(200);
    expect(archiveRes.data.card.archived).toBe(true);

    const defaultList = await apiRequest<{ cards: Card[] }>('/api/cards', { token: alexToken });
    expect(defaultList.data.cards.some((c) => c.id === c1.id)).toBe(false);

    const archivedList = await apiRequest<{ cards: Card[] }>('/api/cards?archived=true', {
      token: alexToken,
    });
    expect(archivedList.data.cards.some((c) => c.id === c1.id)).toBe(true);

    // 4. Unarchive
    const unarchiveRes = await apiRequest<{ card: Card }>(`/api/cards/${c1.id}/archive`, {
      method: 'POST',
      token: alexToken,
      body: {
        archived: false,
        note: 'Back on the weekend list',
      },
    });
    expect(unarchiveRes.status).toBe(200);
    expect(unarchiveRes.data.card.archived).toBe(false);

    // 5. Verify paginated card activity (5 total entries: create, status x2, archive, unarchive)
    const page1 = await apiRequest<{ activity: Activity[]; nextCursor: string | null }>(
      `/api/cards/${c1.id}/activity?limit=2`,
      { token: samToken },
    );
    expect(page1.status).toBe(200);
    expect(page1.data.activity).toHaveLength(2);
    expect(page1.data.nextCursor).toBeTruthy();

    const page2 = await apiRequest<{ activity: Activity[]; nextCursor: string | null }>(
      `/api/cards/${c1.id}/activity?limit=2&cursor=${encodeURIComponent(page1.data.nextCursor!)}`,
      { token: samToken },
    );
    expect(page2.status).toBe(200);
    expect(page2.data.activity).toHaveLength(2);
    expect(page2.data.nextCursor).toBeTruthy();

    const page3 = await apiRequest<{ activity: Activity[]; nextCursor: string | null }>(
      `/api/cards/${c1.id}/activity?limit=2&cursor=${encodeURIComponent(page2.data.nextCursor!)}`,
      { token: samToken },
    );
    expect(page3.status).toBe(200);
    expect(page3.data.activity).toHaveLength(1);
    expect(page3.data.nextCursor).toBeNull();

    const allEntries = [...page1.data.activity, ...page2.data.activity, ...page3.data.activity];
    expect(allEntries.map((a) => a.action)).toEqual([
      'card.unarchived',
      'card.archived',
      'card.status_changed',
      'card.status_changed',
      'card.created',
    ]);
    expect(allEntries[0]?.diff).toEqual({ archived: { from: true, to: false } });
    expect(allEntries[0]?.note).toBe('Back on the weekend list');
    expect(allEntries[1]?.diff).toEqual({ archived: { from: false, to: true } });
    expect(allEntries[1]?.actorId).toBe('user-sam');
    expect(allEntries[3]?.diff).toEqual({ status: { from: 'todo', to: 'doing' } });
    expect(allEntries[4]?.note).toBe('Initial creation note');

    // 6. Verify global activity pagination returns visible entries in descending order
    const globalPage1 = await apiRequest<{ activity: Activity[]; nextCursor: string | null }>(
      '/api/activity?limit=3',
      { token: samToken },
    );
    expect(globalPage1.status).toBe(200);
    expect(globalPage1.data.activity).toHaveLength(3);
    expect(globalPage1.data.nextCursor).toBeTruthy();
    expect(globalPage1.data.activity.every((a) => a.visibleToUserIds.includes('user-sam'))).toBe(
      true,
    );

    const globalPage2 = await apiRequest<{ activity: Activity[]; nextCursor: string | null }>(
      `/api/activity?limit=3&cursor=${encodeURIComponent(globalPage1.data.nextCursor!)}`,
      { token: samToken },
    );
    expect(globalPage2.status).toBe(200);
    expect(globalPage2.data.activity.length).toBeGreaterThan(0);
    const seenIds = new Set(globalPage1.data.activity.map((a) => a.id));
    expect(globalPage2.data.activity.some((a) => seenIds.has(a.id))).toBe(false);
  });
});
