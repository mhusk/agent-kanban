import { onRequest } from 'firebase-functions/v2/https';
import { createApp } from './app.js';
import { getConfig } from './config.js';

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
