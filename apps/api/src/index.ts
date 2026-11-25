import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { EventSchema } from '@agent-kanban/shared';
import { createApp } from './app.js';
import { getConfig } from './config.js';
import { dispatchEventWebhooks, processDueWebhookRetries } from './services/webhookDispatcher.js';

// Validate environment configuration & strict emulator auth guard at startup.
getConfig();

const app = createApp();

export const api = onRequest(
  {
    region: 'us-central1',
    memory: '512MiB',
  },
  app,
);

export const onEventCreated = onDocumentCreated(
  {
    document: 'events/{eventId}',
    region: 'us-central1',
    memory: '256MiB',
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
  },
  async () => {
    await processDueWebhookRetries(new Date());
  },
);
