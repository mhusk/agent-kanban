import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import type { AgentConnection, Card, Event } from '@agent-kanban/shared';
import { seedEmulator } from '../../../scripts/seed-emulator.js';

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

describe('Domain event pipeline, agent loop suppression & GET /api/events polling (Emulator)', () => {
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
        body: { platform: 'Automation Bot' },
      },
    );
    expect(connRes.status).toBe(201);
    alexApiKey = connRes.data.apiKey;
  });

  it('emits events for human actions, suppresses all API-key & MCP agent writes, and paginates GET /api/events with visibility isolation', async () => {
    // 1. Human creates a shared card -> card.created
    const createdShared = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Shared event test card',
        awareUserIds: ['user-sam'],
        note: 'Created by Alex',
      },
    });
    expect(createdShared.status).toBe(201);
    const sharedId = createdShared.data.card.id;

    // 2. Human updates the card -> card.updated
    const updatedShared = await apiRequest<{ card: Card }>(`/api/cards/${sharedId}`, {
      method: 'PATCH',
      token: alexToken,
      body: { description: 'Updated description', note: 'Added context' },
    });
    expect(updatedShared.status).toBe(200);

    // 3. Human changes status -> card.status_changed
    const statusShared = await apiRequest<{ card: Card }>(`/api/cards/${sharedId}/status`, {
      method: 'POST',
      token: alexToken,
      body: { status: 'doing' },
    });
    expect(statusShared.status).toBe(200);

    // 4. Human comments with @sam -> card.commented (with mentions)
    const commentShared = await apiRequest(`/api/cards/${sharedId}/comments`, {
      method: 'POST',
      token: alexToken,
      body: { text: 'Ping @sam to check this' },
    });
    expect(commentShared.status).toBe(201);

    // 5. Human completes the card -> card.completed
    const completeShared = await apiRequest(`/api/cards/${sharedId}/complete`, {
      method: 'POST',
      token: alexToken,
      body: {},
    });
    expect(completeShared.status).toBe(200);

    // 6. Human creates an Alex-only private card -> must NOT be visible in Sam's poll
    const createdPrivate = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Alex private event card',
        assignedUserIds: ['user-alex'],
        awareUserIds: [],
      },
    });
    expect(createdPrivate.status).toBe(201);
    const privateId = createdPrivate.data.card.id;

    const eventsAfterHumanSnap = await db.collection('events').get();
    const humanEventCount = eventsAfterHumanSnap.size;
    expect(humanEventCount).toBe(6);

    // 7. Perform identical operations via API key -> must emit ZERO events
    const agentCreate = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexApiKey,
      headers: { 'X-Agent-Name': 'Chief of Staff' },
      body: { title: 'Agent API card', awareUserIds: ['user-sam'] },
    });
    expect(agentCreate.status).toBe(201);
    const agentCardId = agentCreate.data.card.id;

    await apiRequest(`/api/cards/${agentCardId}`, {
      method: 'PATCH',
      token: alexApiKey,
      body: { description: 'Agent update' },
    });
    await apiRequest(`/api/cards/${agentCardId}/status`, {
      method: 'POST',
      token: alexApiKey,
      body: { status: 'doing' },
    });
    await apiRequest(`/api/cards/${agentCardId}/comments`, {
      method: 'POST',
      token: alexApiKey,
      body: { text: 'Agent comment @sam' },
    });
    await apiRequest(`/api/cards/${agentCardId}/complete`, {
      method: 'POST',
      token: alexApiKey,
      body: {},
    });

    // 8. Perform operations via /mcp (both JWT OAuth path and API key path) -> ZERO events
    const jwtMcpClient = new Client({ name: 'loop-guard-jwt', version: '1.0.0' });
    await jwtMcpClient.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${alexToken}` } },
      }),
    );
    await jwtMcpClient.callTool({
      name: 'create_card',
      arguments: { title: 'MCP JWT card', awareUserIds: ['user-sam'], agentName: 'Claude' },
    });
    await jwtMcpClient.callTool({
      name: 'update_card',
      arguments: { cardId: sharedId, description: 'Updated via MCP JWT', agentName: 'Claude' },
    });
    await jwtMcpClient.close();

    const keyMcpClient = new Client({ name: 'loop-guard-key', version: '1.0.0' });
    await keyMcpClient.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${alexApiKey}` } },
      }),
    );
    await keyMcpClient.callTool({
      name: 'add_comment',
      arguments: { cardId: sharedId, text: 'Comment via MCP key @sam' },
    });
    await keyMcpClient.close();

    const eventsAfterAgentSnap = await db.collection('events').get();
    expect(eventsAfterAgentSnap.size).toBe(humanEventCount);

    // 9. Sam polls GET /api/events incrementally (limit=2) -> sees only the 5 shared events, never privateId
    const page1 = await apiRequest<{
      events: Event[];
      nextCursor: string | null;
      hasMore: boolean;
    }>('/api/events?limit=2', { token: samToken });
    expect(page1.status).toBe(200);
    expect(page1.data.events).toHaveLength(2);
    expect(page1.data.hasMore).toBe(true);
    expect(page1.data.nextCursor).toBe(page1.data.events[1]!.id);

    const page2 = await apiRequest<{
      events: Event[];
      nextCursor: string | null;
      hasMore: boolean;
    }>(`/api/events?since=${encodeURIComponent(page1.data.nextCursor!)}&limit=2`, {
      token: samToken,
    });
    expect(page2.status).toBe(200);
    expect(page2.data.events).toHaveLength(2);
    expect(page2.data.hasMore).toBe(true);

    const page3 = await apiRequest<{
      events: Event[];
      nextCursor: string | null;
      hasMore: boolean;
    }>(`/api/events?since=${encodeURIComponent(page2.data.nextCursor!)}&limit=2`, {
      token: samToken,
    });
    expect(page3.status).toBe(200);
    expect(page3.data.events).toHaveLength(1);
    expect(page3.data.hasMore).toBe(false);

    const allSamEvents = [...page1.data.events, ...page2.data.events, ...page3.data.events];
    expect(allSamEvents.map((e) => e.type)).toEqual([
      'card.created',
      'card.updated',
      'card.status_changed',
      'card.commented',
      'card.completed',
    ]);
    expect(allSamEvents.some((e) => e.cardId === privateId)).toBe(false);
    const commentedEvt = allSamEvents.find((e) => e.type === 'card.commented');
    expect(commentedEvt?.payload.mentions).toEqual(['user-sam']);

    // Polling again with final cursor returns [] and preserves cursor
    const page4 = await apiRequest<{
      events: Event[];
      nextCursor: string | null;
      hasMore: boolean;
    }>(`/api/events?since=${encodeURIComponent(page3.data.nextCursor!)}&limit=2`, {
      token: samToken,
    });
    expect(page4.status).toBe(200);
    expect(page4.data.events).toHaveLength(0);
    expect(page4.data.nextCursor).toBe(page3.data.nextCursor);

    // New human action shows up on next incremental poll
    await apiRequest(`/api/cards/${sharedId}/status`, {
      method: 'POST',
      token: samToken,
      body: { status: 'todo' },
    });
    const page5 = await apiRequest<{
      events: Event[];
      nextCursor: string | null;
      hasMore: boolean;
    }>(`/api/events?since=${encodeURIComponent(page4.data.nextCursor!)}&limit=10`, {
      token: samToken,
    });
    expect(page5.status).toBe(200);
    expect(page5.data.events).toHaveLength(1);
    expect(page5.data.events[0]!.type).toBe('card.status_changed');
  });
});
