import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Activity, AgentConnection, Card, Comment } from '@agent-kanban/shared';
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

describe('User-owned Agent Connections, Hashed API Keys & X-Agent-Name Attribution (Emulator)', () => {
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

  it('creates connections returning secret once, stores only SHA-256 hash, and enforces owner isolation', async () => {
    const created = await apiRequest<{ connection: AgentConnection; apiKey: string }>(
      '/api/agent-connections',
      {
        method: 'POST',
        token: alexToken,
        body: { platform: 'Automation Bot' },
      },
    );
    expect(created.status).toBe(201);
    expect(created.data.connection.platform).toBe('Automation Bot');
    expect(created.data.connection.ownerUserId).toBe('user-alex');
    expect(created.data.connection.authType).toBe('api_key');
    expect(created.data.connection.revoked).toBe(false);
    expect(created.data.apiKey.startsWith(`${created.data.connection.keyPrefix}_`)).toBe(true);

    // Firestore doc never contains plaintext key and stores a 64-char sha256 hex hash
    const rawDoc = await db.collection('agentConnections').doc(created.data.connection.id).get();
    const rawData = rawDoc.data() ?? {};
    expect(rawData.hashedKey).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rawData)).not.toContain(created.data.apiKey);

    // GET /api/agent-connections never returns apiKey or hashedKey
    const listed = await apiRequest<{ connections: Array<Record<string, unknown>> }>(
      '/api/agent-connections',
      { token: alexToken },
    );
    expect(listed.status).toBe(200);
    expect(listed.data.connections).toHaveLength(1);
    expect(listed.data.connections[0]!.hashedKey).toBeUndefined();
    expect(listed.data.connections[0]!.apiKey).toBeUndefined();

    // Sam cannot see, rotate, or revoke Alex's connection
    const samList = await apiRequest<{ connections: AgentConnection[] }>('/api/agent-connections', {
      token: samToken,
    });
    expect(samList.status).toBe(200);
    expect(samList.data.connections).toHaveLength(0);

    const samRotate = await apiRequest<ApiErrorBody>(
      `/api/agent-connections/${created.data.connection.id}/rotate`,
      { method: 'POST', token: samToken },
    );
    expect(samRotate.status).toBe(404);

    const samRevoke = await apiRequest<ApiErrorBody>(
      `/api/agent-connections/${created.data.connection.id}`,
      { method: 'DELETE', token: samToken },
    );
    expect(samRevoke.status).toBe(404);
  });

  it('attributes agent writes with X-Agent-Name and inherits owner card visibility', async () => {
    const alexConn = await apiRequest<{ connection: AgentConnection; apiKey: string }>(
      '/api/agent-connections',
      {
        method: 'POST',
        token: alexToken,
        body: { platform: 'Automation Bot' },
      },
    );
    expect(alexConn.status).toBe(201);
    const alexApiKey = alexConn.data.apiKey;

    const samConn = await apiRequest<{ connection: AgentConnection; apiKey: string }>(
      '/api/agent-connections',
      {
        method: 'POST',
        token: samToken,
        body: { platform: 'Kitchen Assistant' },
      },
    );
    expect(samConn.status).toBe(201);
    const samApiKey = samConn.data.apiKey;

    // Alex's agent creates a private card with X-Agent-Name: Chief of Staff
    const createdCard = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexApiKey,
      headers: { 'X-Agent-Name': 'Chief of Staff' },
      body: {
        title: 'Agent-created private brief',
        assignedUserIds: ['user-alex'],
        awareUserIds: [],
        note: 'Generated from daily calendar check',
      },
    });
    expect(createdCard.status).toBe(201);
    const privateCardId = createdCard.data.card.id;

    // Alex's agent comments (omitting X-Agent-Name falls back to platform)
    const commentRes = await apiRequest<{ comment: Comment }>(
      `/api/cards/${privateCardId}/comments`,
      {
        method: 'POST',
        token: alexApiKey,
        body: { text: 'Morning triage note added.' },
      },
    );
    expect(commentRes.status).toBe(201);
    expect(commentRes.data.comment.actorType).toBe('agent');
    expect(commentRes.data.comment.actorId).toBe('user-alex');
    expect(commentRes.data.comment.agentName).toBe('Automation Bot');
    expect(commentRes.data.comment.platform).toBe('Automation Bot');

    // Verify activity entry for card creation carries X-Agent-Name: Chief of Staff
    const activityRes = await apiRequest<{ activity: Activity[] }>(
      `/api/cards/${privateCardId}/activity`,
      { token: alexToken },
    );
    expect(activityRes.status).toBe(200);
    const createActivity = activityRes.data.activity.find((a) => a.action === 'card.created');
    expect(createActivity?.actorType).toBe('agent');
    expect(createActivity?.actorId).toBe('user-alex');
    expect(createActivity?.agentName).toBe('Chief of Staff');
    expect(createActivity?.platform).toBe('Automation Bot');

    // Sam's API key strictly inherits Sam's visibility -> 404 on Alex's private card
    const samRead = await apiRequest<ApiErrorBody>(`/api/cards/${privateCardId}`, {
      token: samApiKey,
    });
    expect(samRead.status).toBe(404);

    // Agent API keys cannot create new connections or add household users (403)
    const agentCreateConn = await apiRequest<ApiErrorBody>('/api/agent-connections', {
      method: 'POST',
      token: alexApiKey,
      body: { platform: 'Self-Escalation' },
    });
    expect(agentCreateConn.status).toBe(403);

    const agentAddUser = await apiRequest<ApiErrorBody>('/api/admin/users', {
      method: 'POST',
      token: alexApiKey,
      body: { email: 'extra@example.test', displayName: 'Extra User', handle: 'extra' },
    });
    expect(agentAddUser.status).toBe(403);
  });

  it('rejects rotated-out, revoked, and malformed API keys with 401 immediately', async () => {
    const bogusKey = ['ak', 'deadbeef', 'a'.repeat(43)].join('_');
    const bogusRes = await apiRequest<ApiErrorBody>('/api/me', { token: bogusKey });
    expect(bogusRes.status).toBe(401);

    const created = await apiRequest<{ connection: AgentConnection; apiKey: string }>(
      '/api/agent-connections',
      {
        method: 'POST',
        token: samToken,
        body: { platform: 'Meal Bot' },
      },
    );
    expect(created.status).toBe(201);
    const connId = created.data.connection.id;
    const oldKey = created.data.apiKey;

    const okBeforeRotate = await apiRequest<{ cards: Card[] }>('/api/cards', { token: oldKey });
    expect(okBeforeRotate.status).toBe(200);

    // Rotate key -> old key immediately returns 401, new key returns 200
    const rotated = await apiRequest<{ connection: AgentConnection; apiKey: string }>(
      `/api/agent-connections/${connId}/rotate`,
      { method: 'POST', token: samToken },
    );
    expect(rotated.status).toBe(200);
    expect(rotated.data.connection.rotatedAt).not.toBeNull();
    const newKey = rotated.data.apiKey;
    expect(newKey).not.toBe(oldKey);

    const oldAfterRotate = await apiRequest<ApiErrorBody>('/api/cards', { token: oldKey });
    expect(oldAfterRotate.status).toBe(401);

    const newAfterRotate = await apiRequest<{ cards: Card[] }>('/api/cards', { token: newKey });
    expect(newAfterRotate.status).toBe(200);

    // Revoke key -> new key immediately returns 401, rotating revoked returns 400
    const revoked = await apiRequest<{ connection: AgentConnection }>(
      `/api/agent-connections/${connId}`,
      { method: 'DELETE', token: samToken },
    );
    expect(revoked.status).toBe(200);
    expect(revoked.data.connection.revoked).toBe(true);

    const afterRevoke = await apiRequest<ApiErrorBody>('/api/cards', { token: newKey });
    expect(afterRevoke.status).toBe(401);

    const rotateRevoked = await apiRequest<ApiErrorBody>(
      `/api/agent-connections/${connId}/rotate`,
      { method: 'POST', token: samToken },
    );
    expect(rotateRevoked.status).toBe(400);

    const patchRevoked = await apiRequest<ApiErrorBody>(`/api/agent-connections/${connId}`, {
      method: 'PATCH',
      token: samToken,
      body: { platform: 'Renamed Bot' },
    });
    expect(patchRevoked.status).toBe(400);
    expect(patchRevoked.data.error.code).toBe('CONNECTION_REVOKED');
  });

  it('supports defaultAgentName on create, PATCH updates without rotating key, and preserves owner/human guards', async () => {
    // 1. Create connection with defaultAgentName
    const created = await apiRequest<{ connection: AgentConnection; apiKey: string }>(
      '/api/agent-connections',
      {
        method: 'POST',
        token: alexToken,
        body: { platform: 'Automation Bot', defaultAgentName: 'Chief of Staff' },
      },
    );
    expect(created.status).toBe(201);
    expect(created.data.connection.platform).toBe('Automation Bot');
    expect(created.data.connection.defaultAgentName).toBe('Chief of Staff');
    const connId = created.data.connection.id;
    const apiKey = created.data.apiKey;

    const cardRes = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: apiKey,
      body: { title: 'Connection metadata test card' },
    });
    expect(cardRes.status).toBe(201);
    const cardId = cardRes.data.card.id;

    // Comment omitting X-Agent-Name uses connection defaultAgentName
    const c1 = await apiRequest<{ comment: Comment }>(`/api/cards/${cardId}/comments`, {
      method: 'POST',
      token: apiKey,
      body: { text: 'Comment using default agent name' },
    });
    expect(c1.status).toBe(201);
    expect(c1.data.comment.agentName).toBe('Chief of Staff');
    expect(c1.data.comment.platform).toBe('Automation Bot');

    // Explicit X-Agent-Name overrides defaultAgentName
    const c2 = await apiRequest<{ comment: Comment }>(`/api/cards/${cardId}/comments`, {
      method: 'POST',
      token: apiKey,
      headers: { 'X-Agent-Name': 'Calendar Specialist' },
      body: { text: 'Comment overriding agent name' },
    });
    expect(c2.status).toBe(201);
    expect(c2.data.comment.agentName).toBe('Calendar Specialist');
    expect(c2.data.comment.platform).toBe('Automation Bot');

    // 2. PATCH updates platform & defaultAgentName while keeping existing apiKey valid
    const patched = await apiRequest<{ connection: AgentConnection }>(
      `/api/agent-connections/${connId}`,
      {
        method: 'PATCH',
        token: alexToken,
        body: { platform: 'Relay Bot', defaultAgentName: 'Operations Lead' },
      },
    );
    expect(patched.status).toBe(200);
    expect(patched.data.connection.platform).toBe('Relay Bot');
    expect(patched.data.connection.defaultAgentName).toBe('Operations Lead');

    const c3 = await apiRequest<{ comment: Comment }>(`/api/cards/${cardId}/comments`, {
      method: 'POST',
      token: apiKey,
      body: { text: 'Comment after connection rename' },
    });
    expect(c3.status).toBe(201);
    expect(c3.data.comment.agentName).toBe('Operations Lead');
    expect(c3.data.comment.platform).toBe('Relay Bot');

    // 3. Clearing defaultAgentName via null falls back to updated platform
    const cleared = await apiRequest<{ connection: AgentConnection }>(
      `/api/agent-connections/${connId}`,
      {
        method: 'PATCH',
        token: alexToken,
        body: { defaultAgentName: null },
      },
    );
    expect(cleared.status).toBe(200);
    expect(cleared.data.connection.defaultAgentName).toBeNull();

    const c4 = await apiRequest<{ comment: Comment }>(`/api/cards/${cardId}/comments`, {
      method: 'POST',
      token: apiKey,
      body: { text: 'Comment after clearing default agent name' },
    });
    expect(c4.status).toBe(201);
    expect(c4.data.comment.agentName).toBe('Relay Bot');
    expect(c4.data.comment.platform).toBe('Relay Bot');

    // 4. Non-owner gets 404; agent API key gets 403
    const samPatch = await apiRequest<ApiErrorBody>(`/api/agent-connections/${connId}`, {
      method: 'PATCH',
      token: samToken,
      body: { platform: 'Hijack Bot' },
    });
    expect(samPatch.status).toBe(404);

    const agentPatch = await apiRequest<ApiErrorBody>(`/api/agent-connections/${connId}`, {
      method: 'PATCH',
      token: apiKey,
      body: { platform: 'Self-Rename' },
    });
    expect(agentPatch.status).toBe(403);
  });
});
