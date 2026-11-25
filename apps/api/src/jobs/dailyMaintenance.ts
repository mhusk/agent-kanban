import { applicationDefault } from 'firebase-admin/app';
import type { DocumentReference, Firestore } from 'firebase-admin/firestore';
import { CardSchema, type Card } from '@agent-kanban/shared';
import { getConfig } from '../config.js';
import { AppError } from '../lib/errors.js';
import { getDb, getFirebaseApp } from '../lib/firebase.js';
import { buildActivityEntry, writeActivityInTransaction } from '../services/activity.js';

const MS_PER_DAY = 86_400_000;
const RETENTION_DAYS = 30;
const DELETE_BATCH_LIMIT = 400;

const SYSTEM_AUTH = {
  actorType: 'system' as const,
  userId: 'system',
};

export interface DailyMaintenanceDeps {
  db?: Firestore;
  autoArchiveDays?: number;
  backupBucket?: string | null;
  exportBackupFn?: (outputUriPrefix: string) => Promise<void>;
}

export interface DailyMaintenanceResult {
  archivedCount: number;
  prunedEventsCount: number;
  prunedDeliveriesCount: number;
  backupOutputUri: string | null;
}

function parseStoredCard(id: string, rawData: Record<string, unknown>): Card {
  const parsed = CardSchema.safeParse({
    ...rawData,
    id,
  });
  if (!parsed.success) {
    throw new AppError(
      500,
      'INVALID_CARD_RECORD',
      `Stored card "${id}" failed schema validation during daily maintenance`,
    );
  }
  return parsed.data;
}

function normalizeBucketUri(rawBucket: string): string {
  const trimmed = rawBucket.trim().replace(/\/+$/, '');
  return trimmed.startsWith('gs://') ? trimmed : `gs://${trimmed}`;
}

async function batchDeleteRefs(db: Firestore, refs: readonly DocumentReference[]): Promise<number> {
  for (let i = 0; i < refs.length; i += DELETE_BATCH_LIMIT) {
    const batch = db.batch();
    const chunk = refs.slice(i, i + DELETE_BATCH_LIMIT);
    for (const ref of chunk) {
      batch.delete(ref);
    }
    await batch.commit();
  }
  return refs.length;
}

async function defaultExportFirestoreBackup(outputUriPrefix: string): Promise<void> {
  const app = getFirebaseApp();
  const projectId =
    (typeof app.options.projectId === 'string' && app.options.projectId) ||
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT;

  if (!projectId) {
    throw new Error('Cannot determine GCP projectId for Firestore managed backup export');
  }

  const credential = applicationDefault();
  const token = await credential.getAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default):exportDocuments`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ outputUriPrefix }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(`Firestore exportDocuments failed (HTTP ${response.status}): ${bodyText}`);
  }
}

/**
 * Performs daily housekeeping:
 * 1. Auto-archives non-recurring `done` cards older than `AUTO_ARCHIVE_DAYS` (default 30).
 * 2. Prunes `events` and completed `webhookDeliveries` older than 30 days.
 * 3. Triggers Firestore managed export to `gs://<BACKUP_BUCKET>/firestore/<YYYY-MM-DD>` if configured.
 */
export async function runDailyMaintenance(
  now: Date = new Date(),
  deps: DailyMaintenanceDeps = {},
): Promise<DailyMaintenanceResult> {
  const db = deps.db ?? getDb();
  const config = getConfig();
  const autoArchiveDays = deps.autoArchiveDays ?? config.autoArchiveDays;
  const backupBucket = deps.backupBucket !== undefined ? deps.backupBucket : config.backupBucket;

  const nowIso = now.toISOString();
  const archiveCutoffIso = new Date(now.getTime() - autoArchiveDays * MS_PER_DAY).toISOString();
  const retentionCutoffIso = new Date(now.getTime() - RETENTION_DAYS * MS_PER_DAY).toISOString();

  // 1. Auto-archive stale non-recurring done cards
  const doneSnap = await db
    .collection('cards')
    .where('status', '==', 'done')
    .where('archived', '==', false)
    .where('enteredStatusAt', '<', archiveCutoffIso)
    .get();

  let archivedCount = 0;
  for (const doc of doneSnap.docs) {
    const candidate = parseStoredCard(doc.id, doc.data());
    if (candidate.recurrence !== null) {
      continue;
    }

    const cardRef = db.collection('cards').doc(doc.id);
    const didArchive = await db.runTransaction(async (tx) => {
      const snap = await tx.get(cardRef);
      if (!snap.exists) {
        return false;
      }
      const latest = parseStoredCard(snap.id, snap.data() ?? {});
      if (
        latest.archived ||
        latest.status !== 'done' ||
        latest.recurrence !== null ||
        latest.enteredStatusAt >= archiveCutoffIso
      ) {
        return false;
      }

      const activity = buildActivityEntry({
        cardId: latest.id,
        visibleToUserIds: latest.visibleToUserIds,
        auth: SYSTEM_AUTH,
        action: 'card.auto_archived',
        diff: {
          archived: { from: false, to: true },
        },
        note: `Auto-archived after ${autoArchiveDays} days in Done`,
        createdAt: nowIso,
      });

      tx.update(cardRef, {
        archived: true,
        updatedAt: nowIso,
      });
      writeActivityInTransaction(tx, db, activity);
      return true;
    });

    if (didArchive) {
      archivedCount += 1;
    }
  }

  // 2. Prune events > 30 days old and completed webhookDeliveries > 30 days old
  const oldEventsSnap = await db
    .collection('events')
    .where('createdAt', '<', retentionCutoffIso)
    .get();
  const prunedEventsCount = await batchDeleteRefs(
    db,
    oldEventsSnap.docs.map((doc) => doc.ref),
  );

  const oldDeliveriesSnap = await db
    .collection('webhookDeliveries')
    .where('updatedAt', '<', retentionCutoffIso)
    .get();
  const completedDeliveryRefs = oldDeliveriesSnap.docs
    .filter((doc) => {
      const status = doc.data().status;
      return status === 'succeeded' || status === 'failed';
    })
    .map((doc) => doc.ref);
  const prunedDeliveriesCount = await batchDeleteRefs(db, completedDeliveryRefs);

  // 3. Managed Firestore export when BACKUP_BUCKET is configured
  let backupOutputUri: string | null = null;
  if (backupBucket !== null && backupBucket.trim().length > 0) {
    const dateStamp = nowIso.slice(0, 10);
    backupOutputUri = `${normalizeBucketUri(backupBucket)}/firestore/${dateStamp}`;
    const exportFn = deps.exportBackupFn ?? defaultExportFirestoreBackup;
    await exportFn(backupOutputUri);
  }

  return {
    archivedCount,
    prunedEventsCount,
    prunedDeliveriesCount,
    backupOutputUri,
  };
}
