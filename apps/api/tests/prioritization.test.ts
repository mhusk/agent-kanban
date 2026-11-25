import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Activity, AgentConnection, Card, Comment, User } from '@agent-kanban/shared';
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

interface SnapshotPayload {
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
  };
  cards: Array<
    Card & {
      isOverdue: boolean;
      isDueSoon: boolean;
      checklistCounts: { checked: number; total: number };
      linkCount: number;
      latestComment: Comment | null;
    }
  >;
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

describe('Bulk priority/field updates, smart queries & workspace snapshot (Emulator)', () => {
  let db: Firestore;
  let alexToken: string;
  let samToken: string;
  let samApiKey: string;

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
        token: samToken,
        body: { platform: 'Automation Bot' },
      },
    );
    expect(connRes.status).toBe(201);
    samApiKey = connRes.data.apiKey;
  });

  it('runs a full Chief of Staff pass: snapshot -> bulk priorities -> idempotent replay -> bulk card update -> smart queries -> atomic visibility rejection', async () => {
    // Seed an Alex-only private card that Sam's agent must never see or mutate
    const alexPrivate = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Alex secret private note',
        assignedUserIds: ['user-alex'],
        awareUserIds: [],
      },
    });
    expect(alexPrivate.status).toBe(201);
    const privateCardId = alexPrivate.data.card.id;

    // Seed a comment on card-seed-1 so snapshot returns latestComment
    const commentRes = await apiRequest<{ comment: Comment }>('/api/cards/card-seed-1/comments', {
      method: 'POST',
      token: alexToken,
      body: { text: 'Waiting on callback @sam' },
    });
    expect(commentRes.status).toBe(201);

    // Seed an overdue card and a stale in-todo card visible to Sam
    const pastDueIso = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const overdueRes = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: samToken,
      body: {
        title: 'Submit quarterly water meter reading',
        due: pastDueIso,
        dueFirm: true,
        dueHasTime: false,
        tags: ['utilities'],
      },
    });
    expect(overdueRes.status).toBe(201);
    const overdueCardId = overdueRes.data.card.id;

    const staleRes = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: samToken,
      body: {
        title: 'Sort attic storage boxes',
        tags: ['home'],
      },
    });
    expect(staleRes.status).toBe(201);
    const staleCardId = staleRes.data.card.id;
    const twentyDaysAgoIso = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await db.collection('cards').doc(staleCardId).update({
      enteredStatusAt: twentyDaysAgoIso,
    });

    // 1. Chief of Staff fetches GET /api/workspace/snapshot via API key
    const snapshot = await apiRequest<SnapshotPayload>('/api/workspace/snapshot', {
      token: samApiKey,
      headers: { 'X-Agent-Name': 'Chief of Staff' },
    });
    expect(snapshot.status).toBe(200);
    expect(snapshot.data.ownerUserId).toBe('user-sam');
    expect(snapshot.data.users.length).toBeGreaterThanOrEqual(2);
    expect(snapshot.data.counts.done).toBeGreaterThanOrEqual(1);
    expect(snapshot.data.counts.open).toBe(snapshot.data.cards.length);
    // Private card excluded
    expect(snapshot.data.cards.some((c) => c.id === privateCardId)).toBe(false);
    // Done card excluded from open cards list
    expect(snapshot.data.cards.some((c) => c.status === 'done')).toBe(false);

    const seed1Snap = snapshot.data.cards.find((c) => c.id === 'card-seed-1');
    expect(seed1Snap?.checklistCounts).toEqual({ checked: 1, total: 2 });
    expect(seed1Snap?.isDueSoon).toBe(true);
    expect(seed1Snap?.latestComment?.text).toBe('Waiting on callback @sam');

    const overdueSnap = snapshot.data.cards.find((c) => c.id === overdueCardId);
    expect(overdueSnap?.isOverdue).toBe(true);

    // 2. Chief of Staff runs PATCH /api/cards/priorities with Idempotency-Key + note
    const prioIdemKey = 'cos-prio-run-001';
    const prioRes = await apiRequest<{ cards: Card[] }>('/api/cards/priorities', {
      method: 'PATCH',
      token: samApiKey,
      headers: {
        'X-Agent-Name': 'Chief of Staff',
        'Idempotency-Key': prioIdemKey,
      },
      body: {
        updates: [
          {
            cardId: 'card-seed-2',
            priorityScore: 99,
            priorityReason: 'Elevated to top priority for morning run',
          },
          {
            cardId: 'card-seed-1',
            priorityScore: 40,
            priorityReason: 'Deferred until afternoon callback',
          },
        ],
        note: 'Morning reprioritization pass',
      },
    });
    expect(prioRes.status).toBe(200);
    expect(prioRes.headers.get('x-idempotent-replay')).toBeNull();

    // GET /api/cards?status=todo reflects new ranking
    const todoList = await apiRequest<{ cards: Card[] }>('/api/cards?status=todo', {
      token: samToken,
    });
    expect(todoList.status).toBe(200);
    const todoIds = todoList.data.cards.map((c) => c.id);
    expect(todoIds.indexOf('card-seed-2')).toBeLessThan(todoIds.indexOf('card-seed-1'));

    // Replaying Idempotency-Key returns X-Idempotent-Replay: true and creates zero extra activity
    const actBeforeReplay = await apiRequest<{ activity: Activity[] }>(
      '/api/cards/card-seed-2/activity',
      { token: samToken },
    );
    const replayPrio = await apiRequest<{ cards: Card[] }>('/api/cards/priorities', {
      method: 'PATCH',
      token: samApiKey,
      headers: {
        'X-Agent-Name': 'Chief of Staff',
        'Idempotency-Key': prioIdemKey,
      },
      body: {
        updates: [{ cardId: 'card-seed-2', priorityScore: 10 }],
      },
    });
    expect(replayPrio.status).toBe(200);
    expect(replayPrio.headers.get('x-idempotent-replay')).toBe('true');
    expect(replayPrio.data.cards[0]!.priorityScore).toBe(99);

    const actAfterReplay = await apiRequest<{ activity: Activity[] }>(
      '/api/cards/card-seed-2/activity',
      { token: samToken },
    );
    expect(actAfterReplay.data.activity.length).toBe(actBeforeReplay.data.activity.length);
    const prioEntry = actAfterReplay.data.activity.find((a) => a.action === 'card.prioritized');
    expect(prioEntry?.actorType).toBe('agent');
    expect(prioEntry?.agentName).toBe('Chief of Staff');
    expect(prioEntry?.note).toBe('Morning reprioritization pass');

    // 3. Atomic rejection: bulk payload containing an invisible card ID fails with 404 & leaves visible cards unchanged
    const atomicFailPrio = await apiRequest<ApiErrorBody>('/api/cards/priorities', {
      method: 'PATCH',
      token: samApiKey,
      body: {
        updates: [
          { cardId: 'card-seed-2', priorityScore: 1, priorityReason: 'Should roll back' },
          { cardId: privateCardId, priorityScore: 50, priorityReason: 'Unauthorized' },
        ],
      },
    });
    expect(atomicFailPrio.status).toBe(404);

    const verifyUnchanged = await apiRequest<{ card: Card }>('/api/cards/card-seed-2', {
      token: samToken,
    });
    expect(verifyUnchanged.data.card.priorityScore).toBe(99);

    // 4. Bulk card update (status, addTags/removeTags, due) + atomic rejection
    const bulkFail = await apiRequest<ApiErrorBody>('/api/cards/bulk', {
      method: 'PATCH',
      token: samApiKey,
      body: {
        updates: [
          { cardId: staleCardId, addTags: ['should-not-apply'] },
          { cardId: privateCardId, status: 'done' },
        ],
      },
    });
    expect(bulkFail.status).toBe(404);

    const bulkOk = await apiRequest<{ cards: Card[] }>('/api/cards/bulk', {
      method: 'PATCH',
      token: samApiKey,
      headers: {
        'X-Agent-Name': 'Chief of Staff',
        'Idempotency-Key': 'cos-bulk-001',
      },
      body: {
        updates: [
          {
            cardId: staleCardId,
            addTags: ['declutter'],
            removeTags: ['home'],
          },
        ],
        note: 'Retagged during backlog triage',
      },
    });
    expect(bulkOk.status).toBe(200);
    expect(bulkOk.data.cards[0]!.tags).toEqual(['declutter']);

    // 5. Smart queries
    const dueWithin3 = await apiRequest<{
      query: string;
      days: number;
      cards: Card[];
    }>('/api/cards/smart?query=overdue_or_due_within_days&days=3', {
      token: samApiKey,
    });
    expect(dueWithin3.status).toBe(200);
    const dueIds = dueWithin3.data.cards.map((c) => c.id);
    expect(dueIds).toContain(overdueCardId);
    expect(dueIds).toContain('card-seed-1');
    expect(dueIds).not.toContain(privateCardId);

    const staleQuery = await apiRequest<{
      query: string;
      days: number;
      cards: Card[];
    }>('/api/cards/smart?query=stale_in_todo_days&days=14', {
      token: samApiKey,
    });
    expect(staleQuery.status).toBe(200);
    const staleIds = staleQuery.data.cards.map((c) => c.id);
    expect(staleIds).toContain(staleCardId);
    expect(staleIds).not.toContain('card-seed-1');
  });
});
