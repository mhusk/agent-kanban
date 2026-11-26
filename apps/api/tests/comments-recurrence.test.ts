import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Activity, Card, Comment } from '@agent-kanban/shared';
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

describe('Comments with @mentions & in-place recurring card resets (Emulator)', () => {
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

  it('creates comments resolving @mentions, ignores emails/unknown handles, lists chronologically, and enforces visibility', async () => {
    const privateRes = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Private anniversary trip notes',
        assignedUserIds: ['user-alex'],
        awareUserIds: [],
      },
    });
    expect(privateRes.status).toBe(201);
    const privateCardId = privateRes.data.card.id;

    // Sam cannot read or post comments on Alex's private card (404)
    const samGetPrivate = await apiRequest<ApiErrorBody>(`/api/cards/${privateCardId}/comments`, {
      token: samToken,
    });
    expect(samGetPrivate.status).toBe(404);

    const samPostPrivate = await apiRequest<ApiErrorBody>(`/api/cards/${privateCardId}/comments`, {
      method: 'POST',
      token: samToken,
      body: { text: 'Can I see this?' },
    });
    expect(samPostPrivate.status).toBe(404);

    // Shared card comment mention resolution
    const sharedRes = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Coordinate pantry restock',
        assignedUserIds: ['user-alex'],
        awareUserIds: ['user-sam'],
      },
    });
    expect(sharedRes.status).toBe(201);
    const sharedCard = sharedRes.data.card;
    expect(sharedCard.commentCount).toBe(0);

    const firstComment = await apiRequest<{ comment: Comment; card: Card }>(
      `/api/cards/${sharedCard.id}/comments`,
      {
        method: 'POST',
        token: alexToken,
        body: {
          text: 'Hey @sam please verify email not-a-mention@example.test and ping @nobody too.',
          note: 'Requested confirmation from household member',
        },
      },
    );
    expect(firstComment.status).toBe(201);
    expect(firstComment.data.comment.mentions).toEqual(['user-sam']);
    expect(firstComment.data.comment.actorType).toBe('human');
    expect(firstComment.data.comment.actorId).toBe('user-alex');
    expect(firstComment.data.card.commentCount).toBe(1);
    expect(Date.parse(firstComment.data.card.lastTouchedAt)).toBeGreaterThan(
      Date.parse(sharedCard.lastTouchedAt),
    );
    // Commenting does not invalidate updatedAt precondition
    expect(firstComment.data.card.updatedAt).toBe(sharedCard.updatedAt);

    const secondComment = await apiRequest<{ comment: Comment; card: Card }>(
      `/api/cards/${sharedCard.id}/comments`,
      {
        method: 'POST',
        token: samToken,
        body: {
          text: 'Confirmed with @alex and @sam — ready to order.',
        },
      },
    );
    expect(secondComment.status).toBe(201);
    expect(secondComment.data.comment.mentions).toEqual(['user-alex', 'user-sam']);
    expect(secondComment.data.card.commentCount).toBe(2);

    const fetchedCardRes = await apiRequest<{ card: Card }>(`/api/cards/${sharedCard.id}`, {
      token: alexToken,
    });
    expect(fetchedCardRes.status).toBe(200);
    expect(fetchedCardRes.data.card.commentCount).toBe(2);

    const listComments = await apiRequest<{ comments: Comment[] }>(
      `/api/cards/${sharedCard.id}/comments`,
      { token: samToken },
    );
    expect(listComments.status).toBe(200);
    expect(listComments.data.comments.map((c) => c.id)).toEqual([
      firstComment.data.comment.id,
      secondComment.data.comment.id,
    ]);

    const activityRes = await apiRequest<{ activity: Activity[] }>(
      `/api/cards/${sharedCard.id}/activity`,
      { token: alexToken },
    );
    expect(activityRes.status).toBe(200);
    const commentActivities = activityRes.data.activity.filter(
      (entry) => entry.action === 'card.commented',
    );
    expect(commentActivities).toHaveLength(2);
    expect(
      commentActivities.some(
        (entry) => entry.note === 'Requested confirmation from household member',
      ),
    ).toBe(true);
  });

  it('resets a recurring cron card in-place while preserving ID, comments, and links', async () => {
    const initialDue = '2026-05-02T11:00:00.000Z';
    const created = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Saturday morning yard check',
        status: 'doing',
        assignedUserIds: ['user-alex'],
        awareUserIds: ['user-sam'],
        priorityScore: 88,
        priorityReason: 'High priority weekend routine',
        due: initialDue,
        dueFirm: true,
        dueHasTime: true,
        recurrence: {
          type: 'cron',
          expression: '0 7 * * 6',
          timezone: 'America/New_York',
        },
        links: [{ url: 'https://example.test/yard-checklist', label: 'Seasonal guide' }],
        checklists: [
          {
            title: 'Weekly Walkaround',
            items: [
              { text: 'Check irrigation timer', checked: true },
              { text: 'Clear downspout strainers', checked: true },
            ],
          },
          {
            title: 'Compost',
            items: [{ text: 'Turn compost bin', checked: true }],
          },
        ],
      },
    });
    expect(created.status).toBe(201);
    const cardId = created.data.card.id;

    // Add a comment that must remain attached after reset
    const commentRes = await apiRequest<{ comment: Comment }>(`/api/cards/${cardId}/comments`, {
      method: 'POST',
      token: samToken,
      body: { text: 'Checked back gate latch too @alex' },
    });
    expect(commentRes.status).toBe(201);

    // Simulate scheduled notification timestamps on the card doc before completion
    await db.collection('cards').doc(cardId).update({
      dueSoonNotifiedAt: '2026-05-01T12:00:00.000Z',
      overdueNotifiedAt: '2026-05-02T12:00:00.000Z',
    });

    // Complete the recurring card
    const beforeCompleteMs = Date.now();
    const completed = await apiRequest<{ card: Card; recurringReset: boolean }>(
      `/api/cards/${cardId}/complete`,
      {
        method: 'POST',
        token: alexToken,
        body: {
          note: 'Finished Saturday rounds',
        },
      },
    );
    expect(completed.status).toBe(200);
    expect(completed.data.recurringReset).toBe(true);

    const resetCard = completed.data.card;
    expect(resetCard.id).toBe(cardId);
    expect(resetCard.status).toBe('todo');
    expect(resetCard.priorityScore).toBeNull();
    expect(resetCard.priorityReason).toBeNull();
    expect(resetCard.dueSoonNotifiedAt).toBeNull();
    expect(resetCard.overdueNotifiedAt).toBeNull();
    expect(resetCard.links).toHaveLength(1);
    expect(resetCard.checklists).toHaveLength(2);
    for (const chk of resetCard.checklists) {
      for (const item of chk.items) {
        expect(item.checked).toBe(false);
      }
    }

    // Next due must be strictly in the future and fall on a Saturday 07:00 America/New_York
    expect(resetCard.due).not.toBeNull();
    expect(Date.parse(resetCard.due!)).toBeGreaterThan(beforeCompleteMs);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(resetCard.due!));
    const weekday = parts.find((p) => p.type === 'weekday')?.value;
    const hour = parts.find((p) => p.type === 'hour')?.value;
    const minute = parts.find((p) => p.type === 'minute')?.value;
    expect(weekday).toBe('Sat');
    expect(hour).toBe('07');
    expect(minute).toBe('00');

    // Comments preserved on the same card ID
    const commentsAfter = await apiRequest<{ comments: Comment[] }>(
      `/api/cards/${cardId}/comments`,
      { token: alexToken },
    );
    expect(commentsAfter.status).toBe(200);
    expect(commentsAfter.data.comments).toHaveLength(1);
    expect(commentsAfter.data.comments[0]!.id).toBe(commentRes.data.comment.id);

    // Activity entry records card.completed with due.from -> due.to and note
    const activityRes = await apiRequest<{ activity: Activity[] }>(
      `/api/cards/${cardId}/activity`,
      { token: alexToken },
    );
    expect(activityRes.status).toBe(200);
    const completedAct = activityRes.data.activity.find((a) => a.action === 'card.completed');
    expect(completedAct).toBeDefined();
    expect(completedAct?.note).toBe('Finished Saturday rounds');
    expect(completedAct?.diff.due).toEqual({
      from: initialDue,
      to: resetCard.due,
    });
  });

  it('computes interval_after_completion accurately (days & months)', async () => {
    const thirtyDaysCard = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Replace kitchen water filter',
        due: '2026-01-01T00:00:00.000Z',
        dueHasTime: false,
        recurrence: {
          type: 'interval_after_completion',
          every: 30,
          unit: 'days',
          timezone: 'UTC',
        },
      },
    });
    expect(thirtyDaysCard.status).toBe(201);

    const completed30d = await apiRequest<{ card: Card; recurringReset: boolean }>(
      `/api/cards/${thirtyDaysCard.data.card.id}/complete`,
      {
        method: 'POST',
        token: alexToken,
        body: {},
      },
    );
    expect(completed30d.status).toBe(200);
    expect(completed30d.data.recurringReset).toBe(true);
    const expected30d = new Date(Date.parse(completed30d.data.card.updatedAt) + 30 * 86400_000);
    expect(completed30d.data.card.due).toBe(
      new Date(
        Date.UTC(
          expected30d.getUTCFullYear(),
          expected30d.getUTCMonth(),
          expected30d.getUTCDate(),
          0,
          0,
          0,
          0,
        ),
      ).toISOString(),
    );

    const oneMonthCard = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: samToken,
      body: {
        title: 'Clean dishwasher trap',
        due: '2026-02-15T15:30:00.000Z',
        dueHasTime: true,
        recurrence: {
          type: 'interval_after_completion',
          every: 1,
          unit: 'months',
          timezone: 'UTC',
        },
      },
    });
    expect(oneMonthCard.status).toBe(201);

    const completed1m = await apiRequest<{ card: Card; recurringReset: boolean }>(
      `/api/cards/${oneMonthCard.data.card.id}/complete`,
      {
        method: 'POST',
        token: samToken,
        body: {},
      },
    );
    expect(completed1m.status).toBe(200);
    expect(completed1m.data.recurringReset).toBe(true);
    const nextDue1m = new Date(completed1m.data.card.due!);
    expect(nextDue1m.getUTCHours()).toBe(15);
    expect(nextDue1m.getUTCMinutes()).toBe(30);
  });

  it('completes non-recurring cards to done, allows reopening, and enforces visibility & ifUpdatedAt', async () => {
    const created = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Mail tax extension form',
        assignedUserIds: ['user-alex'],
        awareUserIds: [],
      },
    });
    expect(created.status).toBe(201);
    const cardId = created.data.card.id;

    // Sam gets 404 attempting to complete Alex's private card
    const samComplete = await apiRequest<ApiErrorBody>(`/api/cards/${cardId}/complete`, {
      method: 'POST',
      token: samToken,
      body: {},
    });
    expect(samComplete.status).toBe(404);

    // Stale ifUpdatedAt returns 409
    const staleComplete = await apiRequest<ApiErrorBody>(`/api/cards/${cardId}/complete`, {
      method: 'POST',
      token: alexToken,
      body: { ifUpdatedAt: '2020-01-01T00:00:00.000Z' },
    });
    expect(staleComplete.status).toBe(409);
    expect(staleComplete.data.error.code).toBe('CONFLICT');

    // Valid completion moves non-recurring card to done
    const completed = await apiRequest<{ card: Card; recurringReset: boolean }>(
      `/api/cards/${cardId}/complete`,
      {
        method: 'POST',
        token: alexToken,
        body: {
          ifUpdatedAt: created.data.card.updatedAt,
          note: 'Dropped at post office',
        },
      },
    );
    expect(completed.status).toBe(200);
    expect(completed.data.recurringReset).toBe(false);
    expect(completed.data.card.status).toBe('done');

    // Reopen done -> todo
    const reopened = await apiRequest<{ card: Card }>(`/api/cards/${cardId}/status`, {
      method: 'POST',
      token: alexToken,
      body: { status: 'todo', note: 'Need receipt scan' },
    });
    expect(reopened.status).toBe(200);
    expect(reopened.data.card.status).toBe('todo');
  });
});
