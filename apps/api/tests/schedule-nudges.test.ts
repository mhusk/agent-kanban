import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  computeRecurrenceDeferUntil,
  type Activity,
  type AgentConnection,
  type Card,
  type Event,
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

interface ScheduleEntry {
  card: Card;
  nextOccurrences: string[];
  cadence: string;
  effectiveLeadDays: number;
}

interface SchedulePayload {
  generatedAt: string;
  timezone: string;
  horizonDays: number;
  recurring: ScheduleEntry[];
  deferredCards: Card[];
}

interface SnapshotPayload {
  counts: {
    todo: number;
    doing: number;
    blocked: number;
    done: number;
    open: number;
    deferred: number;
    recurring: number;
  };
  cards: Card[];
  deferredCards: Card[];
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
): Promise<{ status: number; data: T }> {
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
  return { status: res.status, data };
}

describe('Snooze, pinned sort, rescore, and recurring schedule (Emulator)', () => {
  let db: Firestore;
  let alexToken: string;
  let samToken: string;
  let alexApiKey: string;

  beforeAll(async () => {
    db = getTestFirestore();
    await clearFirestoreEmulator();
    await seedEmulator(db);
    alexToken = await getAuthToken('alex');
    samToken = await getAuthToken('sam');

    const connRes = await apiRequest<{ connection: AgentConnection; apiKey: string }>(
      '/api/agent-connections',
      {
        method: 'POST',
        token: alexToken,
        body: { platform: 'Schedule Bot' },
      },
    );
    expect(connRes.status).toBe(201);
    alexApiKey = connRes.data.apiKey;
  });

  it('sorts pinned cards above score 100 and hides deferred cards from the default To-Do list', async () => {
    const pinned = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Pinned unscored nudge',
        pinned: true,
        priorityScore: null,
        tags: ['nudge-sort'],
        awareUserIds: ['user-sam'],
      },
    });
    expect(pinned.status).toBe(201);
    expect(pinned.data.card.pinned).toBe(true);

    const topScore = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Score 100 nudge',
        pinned: false,
        priorityScore: 100,
        priorityReason: 'Highest numeric score',
        tags: ['nudge-sort'],
        awareUserIds: ['user-sam'],
      },
    });
    expect(topScore.status).toBe(201);

    const deferred = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Snoozed until spring',
        pinned: true,
        deferUntil: '2027-04-01T13:00:00.000Z',
        tags: ['snooze-check'],
        awareUserIds: ['user-sam'],
      },
    });
    expect(deferred.status).toBe(201);

    const todo = await apiRequest<{ cards: Card[] }>('/api/cards?status=todo&tag=nudge-sort', {
      token: alexToken,
    });
    expect(todo.status).toBe(200);
    expect(todo.data.cards.map((card) => card.title)).toEqual([
      'Pinned unscored nudge',
      'Score 100 nudge',
    ]);

    const hidden = await apiRequest<{ cards: Card[] }>('/api/cards?status=todo&tag=snooze-check', {
      token: alexToken,
    });
    expect(hidden.data.cards).toEqual([]);

    const included = await apiRequest<{ cards: Card[] }>(
      '/api/cards?status=todo&tag=snooze-check&includeDeferred=true',
      { token: alexToken },
    );
    expect(included.data.cards.map((card) => card.id)).toEqual([deferred.data.card.id]);

    const defaultList = await apiRequest<{ cards: Card[] }>('/api/cards?tag=snooze-check', {
      token: alexToken,
    });
    expect(defaultList.data.cards.map((card) => card.id)).toEqual([deferred.data.card.id]);
  });

  it('auto-defers recurring completions, clears pins, and drops deferral on archive', async () => {
    const monthly = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Replace furnace filter',
        pinned: true,
        priorityScore: 40,
        due: '2026-12-01T00:00:00.000Z',
        dueHasTime: false,
        recurrence: {
          type: 'interval_after_completion',
          every: 14,
          unit: 'days',
          timezone: 'America/New_York',
        },
      },
    });
    expect(monthly.status).toBe(201);

    const completed = await apiRequest<{ card: Card; recurringReset: boolean }>(
      `/api/cards/${monthly.data.card.id}/complete`,
      { method: 'POST', token: alexToken, body: { note: 'Filter swapped' } },
    );
    expect(completed.status).toBe(200);
    expect(completed.data.recurringReset).toBe(true);
    expect(completed.data.card.pinned).toBe(false);
    expect(completed.data.card.lastCompletedAt).toBe(completed.data.card.updatedAt);
    expect(completed.data.card.status).toBe('todo');
    expect(completed.data.card.deferUntil).toBe(
      computeRecurrenceDeferUntil(
        completed.data.card.recurrence!,
        completed.data.card.due!,
        completed.data.card.lastCompletedAt!,
        'UTC',
        { dueHasTime: completed.data.card.dueHasTime },
      ),
    );
    expect(completed.data.card.deferUntil).not.toBeNull();

    const explicit = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Water the fern',
        pinned: true,
        due: '2026-12-05T15:00:00.000Z',
        dueHasTime: true,
        recurrence: {
          type: 'interval_after_completion',
          every: 7,
          unit: 'days',
          timezone: 'America/New_York',
          leadDays: 1,
        },
      },
    });
    const explicitDone = await apiRequest<{ card: Card }>(
      `/api/cards/${explicit.data.card.id}/complete`,
      { method: 'POST', token: alexToken, body: {} },
    );
    expect(explicitDone.status).toBe(200);
    expect(explicitDone.data.card.pinned).toBe(false);
    expect(explicitDone.data.card.deferUntil).toBe(
      computeRecurrenceDeferUntil(
        explicitDone.data.card.recurrence!,
        explicitDone.data.card.due!,
        explicitDone.data.card.lastCompletedAt!,
        'UTC',
        { dueHasTime: true },
      ),
    );

    const neverHide = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Daily inbox sweep',
        pinned: true,
        deferUntil: '2027-01-01T00:00:00.000Z',
        due: '2026-12-02T00:00:00.000Z',
        recurrence: {
          type: 'interval_after_completion',
          every: 1,
          unit: 'days',
          timezone: 'UTC',
          autoDefer: false,
        },
      },
    });
    const stayedVisible = await apiRequest<{ card: Card }>(
      `/api/cards/${neverHide.data.card.id}/complete`,
      { method: 'POST', token: alexToken, body: {} },
    );
    expect(stayedVisible.status).toBe(200);
    expect(stayedVisible.data.card.deferUntil).toBeNull();
    expect(stayedVisible.data.card.pinned).toBe(false);
    expect(stayedVisible.data.card.lastCompletedAt).not.toBeNull();

    const oneOff = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'One-off pinned chore',
        pinned: true,
        deferUntil: '2027-02-01T00:00:00.000Z',
      },
    });
    const done = await apiRequest<{ card: Card; recurringReset: boolean }>(
      `/api/cards/${oneOff.data.card.id}/complete`,
      { method: 'POST', token: alexToken, body: {} },
    );
    expect(done.data.recurringReset).toBe(false);
    expect(done.data.card.status).toBe('done');
    expect(done.data.card.pinned).toBe(false);
    expect(done.data.card.deferUntil).toBeNull();
    expect(done.data.card.lastCompletedAt).toBe(done.data.card.updatedAt);

    const toArchive = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Pinned snoozed archive target',
        pinned: true,
        deferUntil: '2027-05-01T12:00:00.000Z',
      },
    });
    const archived = await apiRequest<{ card: Card }>(
      `/api/cards/${toArchive.data.card.id}/archive`,
      {
        method: 'POST',
        token: alexToken,
        body: {},
      },
    );
    expect(archived.status).toBe(200);
    expect(archived.data.card.archived).toBe(true);
    expect(archived.data.card.pinned).toBe(false);
    expect(archived.data.card.deferUntil).toBeNull();
  });

  it('separates deferred cards in the workspace snapshot and keeps pins through priority updates', async () => {
    const snoozed = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Snapshot snoozed card',
        pinned: true,
        deferUntil: '2027-06-01T12:00:00.000Z',
        awareUserIds: ['user-sam'],
      },
    });
    expect(snoozed.status).toBe(201);

    const pinnedOpen = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Snapshot pinned open card',
        pinned: true,
        priorityScore: 12,
        priorityReason: 'Keep this pin',
        awareUserIds: ['user-sam'],
      },
    });
    expect(pinnedOpen.status).toBe(201);

    const snapshot = await apiRequest<SnapshotPayload>('/api/workspace/snapshot', {
      token: alexToken,
    });
    expect(snapshot.status).toBe(200);
    expect(snapshot.data.counts.open).toBe(snapshot.data.cards.length);
    expect(snapshot.data.counts.deferred).toBe(snapshot.data.deferredCards.length);
    expect(snapshot.data.counts.deferred).toBeGreaterThanOrEqual(1);
    expect(snapshot.data.counts.recurring).toBeGreaterThanOrEqual(1);
    expect(snapshot.data.cards.some((card) => card.id === snoozed.data.card.id)).toBe(false);
    const deferredSnap = snapshot.data.deferredCards.find(
      (card) => card.id === snoozed.data.card.id,
    );
    expect(deferredSnap?.pinned).toBe(true);
    expect(deferredSnap?.deferUntil).toBe('2027-06-01T12:00:00.000Z');
    const openSnap = snapshot.data.cards.find((card) => card.id === pinnedOpen.data.card.id);
    expect(openSnap?.pinned).toBe(true);

    const rescored = await apiRequest<{ cards: Card[] }>('/api/cards/priorities', {
      method: 'PATCH',
      token: alexApiKey,
      headers: { 'X-Agent-Name': 'Schedule Bot' },
      body: {
        updates: [
          {
            cardId: pinnedOpen.data.card.id,
            priorityScore: 55,
            priorityReason: 'Agent score left the pin alone',
          },
        ],
      },
    });
    expect(rescored.status).toBe(200);
    expect(rescored.data.cards[0]!.priorityScore).toBe(55);
    expect(rescored.data.cards[0]!.pinned).toBe(true);
    expect(rescored.data.cards[0]!.deferUntil).toBeNull();
  });

  it('excludes deferred cards from stale To-Do queries and returns upcoming recurring cards', async () => {
    const stale = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Stale snoozed backlog item',
        deferUntil: '2027-07-01T12:00:00.000Z',
      },
    });
    expect(stale.status).toBe(201);
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await db.collection('cards').doc(stale.data.card.id).update({
      enteredStatusAt: twentyDaysAgo,
    });

    const hidden = await apiRequest<{ cards: Card[] }>(
      '/api/cards/smart?query=stale_in_todo_days&days=14',
      { token: alexToken },
    );
    expect(hidden.status).toBe(200);
    expect(hidden.data.cards.some((card) => card.id === stale.data.card.id)).toBe(false);

    const woken = await apiRequest<{ card: Card }>(`/api/cards/${stale.data.card.id}`, {
      method: 'PATCH',
      token: alexToken,
      body: { deferUntil: null },
    });
    expect(woken.status).toBe(200);

    const visible = await apiRequest<{ cards: Card[] }>(
      '/api/cards/smart?query=stale_in_todo_days&days=14',
      { token: alexToken },
    );
    expect(visible.data.cards.some((card) => card.id === stale.data.card.id)).toBe(true);

    const upcoming = await apiRequest<{ query: string; cards: Card[] }>(
      '/api/cards/smart?query=upcoming_recurring&days=60',
      { token: alexToken },
    );
    expect(upcoming.status).toBe(200);
    expect(upcoming.data.query).toBe('upcoming_recurring');
    expect(upcoming.data.cards.some((card) => card.recurrence !== null)).toBe(true);
    expect(upcoming.data.cards.some((card) => card.id === stale.data.card.id)).toBe(false);

    const onlyRecurring = await apiRequest<{ cards: Card[] }>('/api/cards?hasRecurrence=true', {
      token: alexToken,
    });
    expect(onlyRecurring.data.cards.every((card) => card.recurrence !== null)).toBe(true);
    expect(onlyRecurring.data.cards.some((card) => card.id === stale.data.card.id)).toBe(false);
  });

  it('returns recurring projections and deferred non-recurring cards from GET /api/cards/recurring', async () => {
    const recurring = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Saturday market run',
        due: '2026-12-05T12:00:00.000Z',
        dueHasTime: true,
        recurrence: {
          type: 'cron',
          expression: '0 9 * * 6',
          timezone: 'America/New_York',
          leadDays: 1,
        },
        awareUserIds: ['user-sam'],
      },
    });
    expect(recurring.status).toBe(201);

    const privateRecurring = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Alex private recurring note',
        assignedUserIds: ['user-alex'],
        awareUserIds: [],
        recurrence: {
          type: 'interval_after_completion',
          every: 7,
          unit: 'days',
          timezone: 'UTC',
          leadDays: 2,
        },
      },
    });
    expect(privateRecurring.status).toBe(201);

    const deferred = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Non-recurring snooze for schedule',
        deferUntil: '2027-08-01T09:00:00.000Z',
        awareUserIds: ['user-sam'],
      },
    });
    expect(deferred.status).toBe(201);

    const schedule = await apiRequest<SchedulePayload>('/api/cards/recurring', {
      token: alexToken,
    });
    expect(schedule.status).toBe(200);
    expect(schedule.data.horizonDays).toBe(60);

    const market = schedule.data.recurring.find(
      (entry) => entry.card.id === recurring.data.card.id,
    );
    expect(market?.cadence).toBe('0 9 * * 6');
    expect(market?.effectiveLeadDays).toBe(1);
    expect(market?.nextOccurrences.length).toBeGreaterThan(1);
    expect(market?.nextOccurrences.length).toBeLessThanOrEqual(10);
    for (const occurrence of market?.nextOccurrences ?? []) {
      expect(Date.parse(occurrence)).toBeLessThanOrEqual(Date.now() + 60 * 86_400_000);
    }

    expect(schedule.data.deferredCards.some((card) => card.id === deferred.data.card.id)).toBe(
      true,
    );
    expect(schedule.data.recurring.some((entry) => entry.card.id === deferred.data.card.id)).toBe(
      false,
    );
    expect(
      schedule.data.recurring.some((entry) => entry.card.id === privateRecurring.data.card.id),
    ).toBe(true);

    const samSchedule = await apiRequest<SchedulePayload>('/api/cards/recurring?horizonDays=30', {
      token: samToken,
    });
    expect(samSchedule.status).toBe(200);
    expect(samSchedule.data.horizonDays).toBe(30);
    expect(
      samSchedule.data.recurring.some((entry) => entry.card.id === privateRecurring.data.card.id),
    ).toBe(false);
    expect(samSchedule.data.deferredCards.some((card) => card.id === deferred.data.card.id)).toBe(
      true,
    );
  });

  it('emits card.rescore_requested for humans and suppresses it for agents', async () => {
    const cardRes = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Needs a fresh score',
        priorityScore: 80,
        priorityReason: 'Old score',
        assignedUserIds: ['user-alex'],
        awareUserIds: [],
      },
    });
    expect(cardRes.status).toBe(201);
    const cardId = cardRes.data.card.id;

    const conflict = await apiRequest<ApiErrorBody>(`/api/cards/${cardId}/rescore`, {
      method: 'POST',
      token: alexToken,
      body: { ifUpdatedAt: '2020-01-01T00:00:00.000Z' },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.data.error.code).toBe('CONFLICT');

    const samRescore = await apiRequest<ApiErrorBody>(`/api/cards/${cardId}/rescore`, {
      method: 'POST',
      token: samToken,
      body: {},
    });
    expect(samRescore.status).toBe(404);
    expect(samRescore.data.error.code).toBe('CARD_NOT_FOUND');

    const human = await apiRequest<{ card: Card }>(`/api/cards/${cardId}/rescore`, {
      method: 'POST',
      token: alexToken,
      body: { note: 'Please take another look' },
    });
    expect(human.status).toBe(200);
    expect(human.data.card.priorityScore).toBeNull();
    expect(human.data.card.priorityReason).toBeNull();

    const agent = await apiRequest<{ card: Card }>(`/api/cards/${cardId}/rescore`, {
      method: 'POST',
      token: alexApiKey,
      headers: { 'X-Agent-Name': 'Schedule Bot' },
      body: { note: 'Agent echo should not emit' },
    });
    expect(agent.status).toBe(200);
    expect(agent.data.card.priorityScore).toBeNull();

    const eventsSnap = await db.collection('events').where('cardId', '==', cardId).get();
    const rescoreEvents = eventsSnap.docs
      .map((doc) => doc.data() as Event)
      .filter((event) => event.type === 'card.rescore_requested');
    expect(rescoreEvents).toHaveLength(1);
    expect(rescoreEvents[0]!.actor.actorType).toBe('human');
    expect(rescoreEvents[0]!.note).toBe('Please take another look');

    const activity = await apiRequest<{ activity: Activity[] }>(`/api/cards/${cardId}/activity`, {
      token: alexToken,
    });
    const rescoreActivity = activity.data.activity.filter(
      (entry) => entry.action === 'card.rescore_requested',
    );
    expect(rescoreActivity).toHaveLength(2);
    expect(rescoreActivity.some((entry) => entry.actorType === 'human')).toBe(true);
    expect(rescoreActivity.some((entry) => entry.actorType === 'agent')).toBe(true);
  });
});
