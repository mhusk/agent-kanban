import { defineSecret } from 'firebase-functions/params';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { EventSchema } from '@agent-kanban/shared';
import { createApp } from './app.js';
import { getConfig } from './config.js';
import { runDailyMaintenance } from './jobs/dailyMaintenance.js';
import { runDueScanner } from './jobs/dueScanner.js';
import { dispatchEventWebhooks, processDueWebhookRetries } from './services/webhookDispatcher.js';

const webhookEncryptionKey = defineSecret('WEBHOOK_ENCRYPTION_KEY');

// Validate environment configuration & strict emulator auth guard at startup.
getConfig();

const app = createApp();

export const api = onRequest(
  {
    region: 'us-central1',
    memory: '512MiB',
    secrets: [webhookEncryptionKey],
  },
  app,
);

export const onEventCreated = onDocumentCreated(
  {
    document: 'events/{eventId}',
    region: 'us-central1',
    memory: '256MiB',
    secrets: [webhookEncryptionKey],
  },
  async (snapEvent) => {
    const rawData = snapEvent.data?.data();
    if (!rawData) {
      return;
    }
    const parsed = EventSchema.safeParse({
      ...rawData,
      id: snapEvent.params.eventId,
    });
    if (!parsed.success) {
      console.error(`Invalid event doc "${snapEvent.params.eventId}":`, parsed.error.flatten());
      return;
    }
    await dispatchEventWebhooks(parsed.data);
  },
);

export const retryWebhooks = onSchedule(
  {
    schedule: 'every 1 minutes',
    region: 'us-central1',
    memory: '256MiB',
    secrets: [webhookEncryptionKey],
  },
  async () => {
    await processDueWebhookRetries(new Date());
  },
);

export const scanDueCards = onSchedule(
  {
    schedule: 'every 15 minutes',
    region: 'us-central1',
    memory: '256MiB',
  },
  async () => {
    await runDueScanner(new Date());
  },
);

export const dailyMaintenance = onSchedule(
  {
    schedule: '0 8 * * *',
    region: 'us-central1',
    memory: '256MiB',
  },
  async () => {
    await runDailyMaintenance(new Date());
  },
);
