import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Card, Event } from '@agent-kanban/shared';
import { seedEmulator } from '../../../scripts/seed-emulator.js';
import { runDailyMaintenance } from '../src/jobs/dailyMaintenance.js';
import { runDueScanner } from '../src/jobs/dueScanner.js';

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'demo-agent-kanban';
const REGION = 'us-central1';
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST ?? '127.0.0.1:5001';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const BASE_URL = `http://${FUNCTIONS_HOST}/${PROJECT_ID}/${REGION}/api`;

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
  },
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${options.token}`,
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = (await res.json()) as T;
  return { status: res.status, data };
}

describe('Scheduled jobs: due_soon/overdue scanner & daily maintenance (Emulator)', () => {
  let db: Firestore;
  let alexToken: string;

  beforeAll(async () => {
    db = getTestFirestore();
    await clearFirestoreEmulator();
    await seedEmulator(db);
    // Keep seeded users while clearing sample cards so scanner counts are deterministic.
    const existingCards = await db.collection('cards').get();
    await Promise.all(existingCards.docs.map((doc) => doc.ref.delete()));
    alexToken = await getAuthToken('alex');
  });

  it('emits card.due_soon and card.overdue once without duplicates, resets flags on due edit and recurring complete, and respects timezone', async () => {
    // Freeze reference time at 2026-07-10T18:00:00.000Z (14:00 EDT in America/New_York)
    const scanNow = new Date('2026-07-10T18:00:00.000Z');

    // Card 1: date-only due 2026-07-12 (within 2 calendar days -> due_soon)
    const dueSoonRes = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Due soon test card',
        due: '2026-07-12T00:00:00.000Z',
        dueHasTime: false,
      },
    });
    expect(dueSoonRes.status).toBe(201);
    const dueSoonCardId = dueSoonRes.data.card.id;

    // Card 2: timed due already past -> overdue
    const overdueRes = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Overdue test card',
        due: '2026-07-10T17:00:00.000Z',
        dueHasTime: true,
      },
    });
    expect(overdueRes.status).toBe(201);
    const overdueCardId = overdueRes.data.card.id;

    // Card 3: recurring card (every 2 days)
    const recurringRes = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Recurring scanner card',
        due: '2026-07-11T00:00:00.000Z',
        dueHasTime: false,
        recurrence: {
          type: 'interval_after_completion',
          every: 2,
          unit: 'days',
          timezone: 'America/New_York',
        },
      },
    });
    expect(recurringRes.status).toBe(201);
    const recurringCardId = recurringRes.data.card.id;

    // Card 4: already done -> never notifies
    const doneRes = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Completed due card',
        status: 'done',
        due: '2026-07-09T00:00:00.000Z',
        dueHasTime: false,
      },
    });
    expect(doneRes.status).toBe(201);
    const doneCardId = doneRes.data.card.id;

    // Run 1 -> emits due_soon for Card 1 & 3, overdue for Card 2, zero for Card 4
    const pass1 = await runDueScanner(scanNow, 'America/New_York', { db });
    expect(pass1.dueSoonEmitted).toBe(2);
    expect(pass1.overdueEmitted).toBe(1);

    // Run 2 -> zero duplicates
    const pass2 = await runDueScanner(scanNow, 'America/New_York', { db });
    expect(pass2.dueSoonEmitted).toBe(0);
    expect(pass2.overdueEmitted).toBe(0);

    // Editing `due` on Card 1 clears dedup flags so scanner notifies again when due
    const patchDue = await apiRequest<{ card: Card }>(`/api/cards/${dueSoonCardId}`, {
      method: 'PATCH',
      token: alexToken,
      body: { due: '2026-07-11T00:00:00.000Z' },
    });
    expect(patchDue.status).toBe(200);
    expect(patchDue.data.card.dueSoonNotifiedAt).toBeNull();
    expect(patchDue.data.card.overdueNotifiedAt).toBeNull();

    const pass3 = await runDueScanner(scanNow, 'America/New_York', { db });
    expect(pass3.dueSoonEmitted).toBe(1);
    expect(pass3.overdueEmitted).toBe(0);

    // Completing recurring Card 3 resets dedup flags and advances due -> notifies on next cycle
    const completedRecurring = await apiRequest<{ card: Card; recurringReset: boolean }>(
      `/api/cards/${recurringCardId}/complete`,
      {
        method: 'POST',
        token: alexToken,
        body: {},
      },
    );
    expect(completedRecurring.status).toBe(200);
    expect(completedRecurring.data.recurringReset).toBe(true);
    expect(completedRecurring.data.card.dueSoonNotifiedAt).toBeNull();
    expect(completedRecurring.data.card.due).not.toBeNull();

    const nextCycleScanNow = new Date(
      Date.parse(completedRecurring.data.card.due!) - 12 * 3600_000,
    );
    await runDueScanner(nextCycleScanNow, 'America/New_York', { db });
    const pass4Repeat = await runDueScanner(nextCycleScanNow, 'America/New_York', { db });
    expect(pass4Repeat.dueSoonEmitted).toBe(0);

    // Verify stored events match expectations
    const eventsSnap = await db.collection('events').get();
    const events = eventsSnap.docs.map((d) => d.data() as Event);

    const recurringDueSoon = events.filter(
      (e) => e.cardId === recurringCardId && e.type === 'card.due_soon',
    );
    expect(recurringDueSoon).toHaveLength(2);

    const card1DueSoon = events.filter(
      (e) => e.cardId === dueSoonCardId && e.type === 'card.due_soon',
    );
    expect(card1DueSoon).toHaveLength(2);
    expect(card1DueSoon[0]!.actor.actorType).toBe('system');

    const card2Overdue = events.filter(
      (e) => e.cardId === overdueCardId && e.type === 'card.overdue',
    );
    expect(card2Overdue).toHaveLength(1);

    const doneDueEvents = events.filter(
      (e) => e.cardId === doneCardId && (e.type === 'card.due_soon' || e.type === 'card.overdue'),
    );
    expect(doneDueEvents).toHaveLength(0);
  });

  it('auto-archives 31-day-old non-recurring done cards, prunes 31-day-old events & completed deliveries, and triggers backup when configured', async () => {
    const maintenanceNow = new Date('2026-08-20T08:00:00.000Z');
    const thirtyOneDaysAgo = new Date(maintenanceNow.getTime() - 31 * 86_400_000).toISOString();
    const twentyNineDaysAgo = new Date(maintenanceNow.getTime() - 29 * 86_400_000).toISOString();
    const oneDayAgo = new Date(maintenanceNow.getTime() - 86_400_000).toISOString();

    const createCard = async (body: Record<string, unknown>) => {
      const res = await apiRequest<{ card: Card }>('/api/cards', {
        method: 'POST',
        token: alexToken,
        body,
      });
      expect(res.status).toBe(201);
      return res.data.card;
    };

    const staleDoneCard = await createCard({
      title: 'Old completed chore',
      status: 'done',
    });
    const recentDoneCard = await createCard({
      title: 'Fresh completed chore',
      status: 'done',
    });
    const staleRecurringDoneCard = await createCard({
      title: 'Old recurring card marked done',
      status: 'done',
      recurrence: {
        type: 'interval_after_completion',
        every: 7,
        unit: 'days',
        timezone: 'UTC',
      },
    });

    // Backdate enteredStatusAt directly in Firestore for test setup
    await db
      .collection('cards')
      .doc(staleDoneCard.id)
      .update({ enteredStatusAt: thirtyOneDaysAgo });
    await db
      .collection('cards')
      .doc(recentDoneCard.id)
      .update({ enteredStatusAt: twentyNineDaysAgo });
    await db
      .collection('cards')
      .doc(staleRecurringDoneCard.id)
      .update({ enteredStatusAt: thirtyOneDaysAgo });

    // Seed old/recent events and completed/pending webhookDeliveries
    const oldEventId = 'evt-old-prune-1';
    const recentEventId = 'evt-recent-keep-1';
    await db
      .collection('events')
      .doc(oldEventId)
      .set({
        id: oldEventId,
        type: 'card.created',
        cardId: staleDoneCard.id,
        visibleToUserIds: ['user-alex'],
        actor: { actorType: 'human', actorId: 'user-alex', agentName: null, platform: null },
        note: null,
        payload: {},
        createdAt: thirtyOneDaysAgo,
        deliveries: {},
      });
    await db
      .collection('events')
      .doc(recentEventId)
      .set({
        id: recentEventId,
        type: 'card.created',
        cardId: recentDoneCard.id,
        visibleToUserIds: ['user-alex'],
        actor: { actorType: 'human', actorId: 'user-alex', agentName: null, platform: null },
        note: null,
        payload: {},
        createdAt: oneDayAgo,
        deliveries: {},
      });

    await db.collection('webhookDeliveries').doc('del-old-succeeded').set({
      id: 'del-old-succeeded',
      eventId: oldEventId,
      subscriptionId: 'sub-1',
      ownerUserId: 'user-alex',
      status: 'succeeded',
      attemptCount: 1,
      lastAttemptAt: thirtyOneDaysAgo,
      nextAttemptAt: null,
      lastError: null,
      createdAt: thirtyOneDaysAgo,
      updatedAt: thirtyOneDaysAgo,
    });
    await db.collection('webhookDeliveries').doc('del-old-pending').set({
      id: 'del-old-pending',
      eventId: oldEventId,
      subscriptionId: 'sub-2',
      ownerUserId: 'user-alex',
      status: 'pending',
      attemptCount: 2,
      lastAttemptAt: thirtyOneDaysAgo,
      nextAttemptAt: oneDayAgo,
      lastError: 'HTTP 500',
      createdAt: thirtyOneDaysAgo,
      updatedAt: thirtyOneDaysAgo,
    });

    const exportedPrefixes: string[] = [];
    const summary = await runDailyMaintenance(maintenanceNow, {
      db,
      autoArchiveDays: 30,
      backupBucket: 'gs://example-agent-kanban-backups',
      exportBackupFn: async (prefix) => {
        exportedPrefixes.push(prefix);
      },
    });

    expect(summary.archivedCount).toBe(1);
    expect(summary.prunedEventsCount).toBeGreaterThanOrEqual(1);
    expect(summary.prunedDeliveriesCount).toBe(1);
    expect(summary.backupOutputUri).toBe('gs://example-agent-kanban-backups/firestore/2026-08-20');
    expect(exportedPrefixes).toEqual(['gs://example-agent-kanban-backups/firestore/2026-08-20']);

    // Verify card archive outcomes
    const [staleAfter, recentAfter, recurringAfter] = await Promise.all([
      db.collection('cards').doc(staleDoneCard.id).get(),
      db.collection('cards').doc(recentDoneCard.id).get(),
      db.collection('cards').doc(staleRecurringDoneCard.id).get(),
    ]);
    expect(staleAfter.data()?.archived).toBe(true);
    expect(recentAfter.data()?.archived).toBe(false);
    expect(recurringAfter.data()?.archived).toBe(false);

    // Verify card.auto_archived activity logged
    const archiveAct = await db
      .collection('activity')
      .where('cardId', '==', staleDoneCard.id)
      .where('action', '==', 'card.auto_archived')
      .get();
    expect(archiveAct.size).toBe(1);
    expect(archiveAct.docs[0]!.data().actorType).toBe('system');

    // Verify pruning outcomes
    expect((await db.collection('events').doc(oldEventId).get()).exists).toBe(false);
    expect((await db.collection('events').doc(recentEventId).get()).exists).toBe(true);
    expect((await db.collection('webhookDeliveries').doc('del-old-succeeded').get()).exists).toBe(
      false,
    );
    expect((await db.collection('webhookDeliveries').doc('del-old-pending').get()).exists).toBe(
      true,
    );

    // Running without backupBucket skips backup cleanly
    const noBackupSummary = await runDailyMaintenance(maintenanceNow, {
      db,
      autoArchiveDays: 30,
      backupBucket: null,
    });
    expect(noBackupSummary.archivedCount).toBe(0);
    expect(noBackupSummary.backupOutputUri).toBeNull();
  });
});
