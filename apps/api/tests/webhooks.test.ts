import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentConnection, Card, Subscription } from '@agent-kanban/shared';
import { seedEmulator } from '../../../scripts/seed-emulator.js';
import {
  computeHmacSignature,
  processDueWebhookRetries,
} from '../src/services/webhookDispatcher.js';

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'demo-agent-kanban';
const REGION = 'us-central1';
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST ?? '127.0.0.1:5001';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const BASE_URL = `http://${FUNCTIONS_HOST}/${PROJECT_ID}/${REGION}/api`;

interface CapturedWebhookRequest {
  path: string;
  headers: http.IncomingHttpHeaders;
  rawBody: string;
  body: {
    id: string;
    eventId: string;
    type: string;
    cardId: string;
    actor: { actorType: string; actorId: string };
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

async function waitFor<T>(
  check: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs = 10_000,
  intervalMs = 150,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await check();
    if (val !== null && val !== undefined) {
      return val;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for webhook/condition`);
}

describe('Filtered webhook subscriptions, AES-GCM encryption, signed delivery & retries (Emulator)', () => {
  let db: Firestore;
  let alexToken: string;
  let samToken: string;
  let alexApiKey: string;
  let server: http.Server;
  let receiverBaseUrl: string;
  let captured: CapturedWebhookRequest[] = [];
  const failPathsOnce = new Set<string>();

  beforeAll(async () => {
    process.env.FUNCTIONS_EMULATOR = 'true';
    db = getTestFirestore();
    await clearFirestoreEmulator();
    await seedEmulator(db);

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const path = req.url ?? '/';
        captured.push({
          path,
          headers: req.headers,
          rawBody,
          body: JSON.parse(rawBody) as CapturedWebhookRequest['body'],
        });

        if (failPathsOnce.has(path)) {
          failPathsOnce.delete(path);
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Simulated transient error' }));
          return;
        }

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

    const connRes = await apiRequest<{ connection: AgentConnection; apiKey: string }>(
      '/api/agent-connections',
      {
        method: 'POST',
        token: alexToken,
        body: { platform: 'Webhook Runner' },
      },
    );
    expect(connRes.status).toBe(201);
    alexApiKey = connRes.data.apiKey;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('encrypts secrets at rest, enforces visibility and filters, verifies Bearer/HMAC signatures, suppresses agent loops, and retries 500s with the same eventId', async () => {
    const hmacSecret = 'hmac-secret-test-value-abcdef123456';
    const bearerSecret = 'bearer-secret-test-value-987654321';
    const samSecret = 'sam-secret-test-value-1122334455';
    const retrySecret = 'retry-secret-test-value-6677889900';

    // 1. Create Alex HMAC subscription filtered to groceries + status todo + created/commented
    const subHmacRes = await apiRequest<{ subscription: Subscription }>('/api/subscriptions', {
      method: 'POST',
      token: alexToken,
      body: {
        webhookUrl: `${receiverBaseUrl}/alex-hmac`,
        authType: 'hmac',
        secret: hmacSecret,
        filters: {
          eventTypes: ['card.created', 'card.commented'],
          tags: ['groceries'],
          statuses: ['todo'],
        },
      },
    });
    expect(subHmacRes.status).toBe(201);
    const subHmac = subHmacRes.data.subscription;
    expect(JSON.stringify(subHmacRes.data)).not.toContain(hmacSecret);

    // 2. Verify Firestore doc stores AES-256-GCM ciphertext and NEVER raw secret
    const subHmacDoc = await db.collection('subscriptions').doc(subHmac.id).get();
    const rawDocData = subHmacDoc.data() ?? {};
    expect(typeof rawDocData.encryptedSecret).toBe('string');
    expect(String(rawDocData.encryptedSecret)).toMatch(/^v1:/);
    expect(rawDocData.secret).toBeUndefined();
    expect(JSON.stringify(rawDocData)).not.toContain(hmacSecret);

    // 3. Create Alex Bearer subscription filtered to assignedUserIds=['user-alex'] + mentionedUserIds=['user-sam']
    const subBearerRes = await apiRequest<{ subscription: Subscription }>('/api/subscriptions', {
      method: 'POST',
      token: alexToken,
      body: {
        webhookUrl: `${receiverBaseUrl}/alex-bearer`,
        authType: 'bearer',
        secret: bearerSecret,
        filters: {
          eventTypes: ['card.commented'],
          assignedUserIds: ['user-alex'],
          mentionedUserIds: ['user-sam'],
        },
      },
    });
    expect(subBearerRes.status).toBe(201);
    const subBearer = subBearerRes.data.subscription;

    // 4. Create Sam subscription for card.created (Sam must never see Alex-only cards)
    const subSamRes = await apiRequest<{ subscription: Subscription }>('/api/subscriptions', {
      method: 'POST',
      token: samToken,
      body: {
        webhookUrl: `${receiverBaseUrl}/sam-hook`,
        authType: 'bearer',
        secret: samSecret,
        filters: {
          eventTypes: ['card.created'],
        },
      },
    });
    expect(subSamRes.status).toBe(201);
    const subSam = subSamRes.data.subscription;

    // List endpoint is owner-scoped and hides secrets
    const alexList = await apiRequest<{ subscriptions: Subscription[] }>('/api/subscriptions', {
      token: alexToken,
    });
    expect(alexList.status).toBe(200);
    expect(alexList.data.subscriptions.map((s) => s.id)).toEqual(
      expect.arrayContaining([subHmac.id, subBearer.id]),
    );
    expect(alexList.data.subscriptions.map((s) => s.id)).not.toContain(subSam.id);
    expect(JSON.stringify(alexList.data)).not.toContain(hmacSecret);
    expect(JSON.stringify(alexList.data)).not.toContain(bearerSecret);

    // Cross-user PATCH/DELETE returns 404
    const crossUpdate = await apiRequest('/api/subscriptions/' + subSam.id, {
      method: 'PATCH',
      token: alexToken,
      body: { active: false },
    });
    expect(crossUpdate.status).toBe(404);

    // 5. Alex creates an ALEX-ONLY groceries card -> matches subHmac only (NOT subBearer, NOT subSam)
    captured = [];
    const privateGroceries = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Buy oat milk',
        tags: ['groceries'],
        assignedUserIds: ['user-alex'],
        awareUserIds: [],
      },
    });
    expect(privateGroceries.status).toBe(201);
    const groceriesCardId = privateGroceries.data.card.id;

    const hmacCreatedReq = await waitFor(() =>
      captured.find((c) => c.path === '/alex-hmac' && c.body.cardId === groceriesCardId),
    );
    // Give any stray deliveries a brief window to surface, then assert none arrived for Sam or Bearer
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(captured.filter((c) => c.path === '/sam-hook')).toHaveLength(0);
    expect(captured.filter((c) => c.path === '/alex-bearer')).toHaveLength(0);

    // Verify HMAC signature cryptographically
    const eventId = hmacCreatedReq.headers['x-agent-kanban-event-id'];
    const eventType = hmacCreatedReq.headers['x-agent-kanban-event-type'];
    const tsHeader = hmacCreatedReq.headers['x-agent-kanban-timestamp'];
    const sigHeader = hmacCreatedReq.headers['x-agent-kanban-signature'];
    expect(typeof eventId).toBe('string');
    expect(eventType).toBe('card.created');
    expect(typeof tsHeader).toBe('string');
    expect(sigHeader).toBe(
      computeHmacSignature(hmacSecret, tsHeader as string, hmacCreatedReq.rawBody),
    );

    // Non-matching tag card for Alex + Sam -> Sam receives, Alex HMAC does NOT receive
    captured = [];
    const nonGroceriesShared = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Fix porch light',
        tags: ['home'],
        assignedUserIds: ['user-alex'],
        awareUserIds: ['user-sam'],
      },
    });
    expect(nonGroceriesShared.status).toBe(201);
    const sharedCardId = nonGroceriesShared.data.card.id;

    const samReq = await waitFor(() =>
      captured.find((c) => c.path === '/sam-hook' && c.body.cardId === sharedCardId),
    );
    expect(samReq.headers.authorization).toBe(`Bearer ${samSecret}`);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(captured.filter((c) => c.path === '/alex-hmac')).toHaveLength(0);

    // Human comments on sharedCardId mentioning @sam -> matches subBearer (NOT subHmac since tag!=groceries)
    captured = [];
    const commentRes = await apiRequest('/api/cards/' + sharedCardId + '/comments', {
      method: 'POST',
      token: alexToken,
      body: { text: 'Hey @sam please grab outdoor bulbs' },
    });
    expect(commentRes.status).toBe(201);

    const bearerReq = await waitFor(() =>
      captured.find((c) => c.path === '/alex-bearer' && c.body.cardId === sharedCardId),
    );
    expect(bearerReq.headers.authorization).toBe(`Bearer ${bearerSecret}`);
    expect(bearerReq.body.type).toBe('card.commented');

    // 6. Agent writes (API key + MCP) trigger ZERO webhook deliveries, and MCP manage_subscriptions works
    captured = [];
    const agentCreate = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexApiKey,
      body: {
        title: 'Agent groceries item',
        tags: ['groceries'],
        awareUserIds: ['user-sam'],
      },
    });
    expect(agentCreate.status).toBe(201);

    const mcpClient = new Client({ name: 'webhook-test-mcp', version: '1.0.0' });
    const mcpTransport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
      requestInit: {
        headers: {
          authorization: `Bearer ${alexToken}`,
          'x-agent-name': 'Webhook Agent',
        },
      },
    });
    await mcpClient.connect(mcpTransport);

    const mcpCreateCard = await mcpClient.callTool({
      name: 'create_card',
      arguments: {
        title: 'MCP groceries item',
        tags: ['groceries'],
        awareUserIds: ['user-sam'],
      },
    });
    expect(mcpCreateCard.isError).toBeFalsy();

    // Also exercise MCP manage_subscriptions tool #20
    const mcpSubList = await mcpClient.callTool({
      name: 'manage_subscriptions',
      arguments: { action: 'list' },
    });
    expect(mcpSubList.isError).toBeFalsy();
    const parsedMcpSubs = JSON.parse(
      (mcpSubList.content as Array<{ text?: string }>)[0]?.text ?? '{}',
    ) as { subscriptions: Subscription[] };
    expect(parsedMcpSubs.subscriptions.length).toBeGreaterThanOrEqual(2);

    await mcpClient.close();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(captured).toHaveLength(0);

    // 7. Pause old hooks and verify retry flow: 500 on attempt 1 -> pending -> processDueWebhookRetries -> succeeded with SAME eventId
    await apiRequest(`/api/subscriptions/${subHmac.id}`, {
      method: 'PATCH',
      token: alexToken,
      body: { active: false },
    });
    await apiRequest(`/api/subscriptions/${subBearer.id}`, {
      method: 'PATCH',
      token: alexToken,
      body: { active: false },
    });
    await apiRequest(`/api/subscriptions/${subSam.id}`, {
      method: 'PATCH',
      token: samToken,
      body: { active: false },
    });

    const retrySubRes = await apiRequest<{ subscription: Subscription }>('/api/subscriptions', {
      method: 'POST',
      token: alexToken,
      body: {
        webhookUrl: `${receiverBaseUrl}/retry-once`,
        authType: 'hmac',
        secret: retrySecret,
        filters: {
          eventTypes: ['card.created'],
        },
      },
    });
    expect(retrySubRes.status).toBe(201);
    const retrySub = retrySubRes.data.subscription;

    captured = [];
    failPathsOnce.add('/retry-once');

    const retryCardRes = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: { title: 'Retry delivery verification card' },
    });
    expect(retryCardRes.status).toBe(201);
    const retryCardId = retryCardRes.data.card.id;

    const firstAttempt = await waitFor(() =>
      captured.find((c) => c.path === '/retry-once' && c.body.cardId === retryCardId),
    );
    const retryEventId = firstAttempt.body.eventId;
    const deliveryDocId = `${retryEventId}_${retrySub.id}`;

    const pendingDelivery = await waitFor(async () => {
      const snap = await db.collection('webhookDeliveries').doc(deliveryDocId).get();
      if (!snap.exists) {
        return null;
      }
      const data = snap.data() as {
        status?: string;
        attemptCount?: number;
        nextAttemptAt?: string | null;
      };
      return data.status === 'pending' ? data : null;
    });

    expect(pendingDelivery.attemptCount).toBe(1);
    expect(typeof pendingDelivery.nextAttemptAt).toBe('string');

    // Run retry processor after the 1-minute backoff window elapses
    const afterBackoff = new Date(Date.parse(pendingDelivery.nextAttemptAt!) + 1000);
    const retrySummary = await processDueWebhookRetries(afterBackoff, { db });
    expect(retrySummary.processed).toBeGreaterThanOrEqual(1);
    expect(retrySummary.succeeded).toBeGreaterThanOrEqual(1);

    const retryRequests = captured.filter((c) => c.path === '/retry-once');
    expect(retryRequests).toHaveLength(2);
    expect(retryRequests[1]!.body.eventId).toBe(retryEventId);
    expect(retryRequests[1]!.headers['x-agent-kanban-event-id']).toBe(retryEventId);

    const finalDeliverySnap = await db.collection('webhookDeliveries').doc(deliveryDocId).get();
    const finalDelivery = finalDeliverySnap.data() as {
      status: string;
      attemptCount: number;
      nextAttemptAt: string | null;
      lastError: string | null;
    };
    expect(finalDelivery.status).toBe('succeeded');
    expect(finalDelivery.attemptCount).toBe(2);
    expect(finalDelivery.nextAttemptAt).toBeNull();
    expect(finalDelivery.lastError).toBeNull();

    const eventSnap = await db.collection('events').doc(retryEventId).get();
    const eventDeliveries = (eventSnap.data()?.deliveries ?? {}) as Record<
      string,
      { status: string; attemptCount: number }
    >;
    expect(eventDeliveries[retrySub.id]?.status).toBe('succeeded');
    expect(eventDeliveries[retrySub.id]?.attemptCount).toBe(2);

    // Delete subscription works cleanly
    const delRes = await apiRequest<{ deleted: boolean; id: string }>(
      `/api/subscriptions/${retrySub.id}`,
      {
        method: 'DELETE',
        token: alexToken,
      },
    );
    expect(delRes.status).toBe(200);
    expect(delRes.data).toEqual({ deleted: true, id: retrySub.id });
  });
});
