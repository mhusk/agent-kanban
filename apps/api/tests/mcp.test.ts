import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Activity, AgentConnection, Card } from '@agent-kanban/shared';
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

async function connectMcpClient(
  token: string,
  extraHeaders: Record<string, string> = {},
): Promise<Client> {
  const client = new Client({ name: 'test-mcp-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
    requestInit: {
      headers: {
        authorization: `Bearer ${token}`,
        ...extraHeaders,
      },
    },
  });
  await client.connect(transport);
  return client;
}

function parseToolText<T>(result: unknown): T {
  const res = result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  const text = res.content[0]?.text ?? '';
  return JSON.parse(text) as T;
}

describe('Stateless Streamable HTTP /mcp & RFC 9728 OAuth metadata (Emulator)', () => {
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

    const connRes = await fetch(`${BASE_URL}/api/agent-connections`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${samToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ platform: 'MCP Bot' }),
    });
    expect(connRes.status).toBe(201);
    const connData = (await connRes.json()) as { connection: AgentConnection; apiKey: string };
    samApiKey = connData.apiKey;
  });

  it('serves RFC 9728 OAuth metadata, enforces 401 WWW-Authenticate on unauthenticated /mcp, and returns 405 for GET/DELETE', async () => {
    const wellKnown = await fetch(`${BASE_URL}/.well-known/oauth-protected-resource`);
    expect(wellKnown.status).toBe(200);
    const metadata = (await wellKnown.json()) as {
      resource: string;
      authorization_servers: string[];
      bearer_methods_supported: string[];
      scopes_supported: string[];
    };
    expect(metadata.resource).toMatch(/\/mcp$/);
    expect(metadata.authorization_servers.length).toBeGreaterThan(0);
    expect(metadata.bearer_methods_supported).toEqual(['header']);
    expect(metadata.scopes_supported).toEqual(['openid', 'profile', 'email']);

    const unauthPost = await fetch(`${BASE_URL}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(unauthPost.status).toBe(401);
    const wwwAuth = unauthPost.headers.get('www-authenticate');
    expect(wwwAuth).toContain('Bearer');
    expect(wwwAuth).toContain('/.well-known/oauth-protected-resource');

    const getRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'GET',
      headers: { authorization: `Bearer ${alexToken}` },
    });
    expect(getRes.status).toBe(405);

    const deleteRes = await fetch(`${BASE_URL}/mcp`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${alexToken}` },
    });
    expect(deleteRes.status).toBe(405);
  });

  it('authenticates via JWT (OAuth path) and API key, lists 21 tools, enforces visibility, and stamps actorType: agent', async () => {
    // 1. JWT path (Alex)
    const alexClient = await connectMcpClient(alexToken);
    const toolsList = await alexClient.listTools();
    const toolNames = toolsList.tools.map((t) => t.name);
    expect(toolNames).toHaveLength(21);
    for (const expected of [
      'list_cards',
      'list_tags',
      'get_card',
      'get_card_by_trello',
      'search_cards',
      'get_workspace_snapshot',
      'smart_query_cards',
      'get_activity',
      'create_card',
      'update_card',
      'change_card_status',
      'complete_card',
      'archive_card',
      'bulk_update_priorities',
      'bulk_update_cards',
      'add_comment',
      'manage_checklist',
      'toggle_checklist_item',
      'manage_link',
      'list_events',
      'manage_subscriptions',
    ]) {
      expect(toolNames).toContain(expected);
    }

    // Create private Alex card via MCP JWT with agentName
    const createdPrivate = await alexClient.callTool({
      name: 'create_card',
      arguments: {
        title: 'MCP JWT private card',
        assignedUserIds: ['user-alex'],
        awareUserIds: [],
        agentName: 'Claude Desktop',
        note: 'Created via MCP',
      },
    });
    const privateCardPayload = parseToolText<{ card: Card }>(createdPrivate);
    const privateCardId = privateCardPayload.card.id;

    // Bulk reprioritize via MCP JWT
    const bulkPrio = await alexClient.callTool({
      name: 'bulk_update_priorities',
      arguments: {
        updates: [
          {
            cardId: privateCardId,
            priorityScore: 95,
            priorityReason: 'Top MCP item',
          },
        ],
        agentName: 'Claude Desktop',
        note: 'Scored via MCP',
      },
    });
    const bulkPayload = parseToolText<{ cards: Card[] }>(bulkPrio);
    expect(bulkPayload.cards[0]!.priorityScore).toBe(95);

    // Workspace snapshot via MCP JWT
    const snapRes = await alexClient.callTool({
      name: 'get_workspace_snapshot',
      arguments: {},
    });
    const snap = parseToolText<{ cards: Card[] }>(snapRes);
    expect(snap.cards.some((c) => c.id === privateCardId)).toBe(true);

    // Activity logs must attribute actorType: 'agent' even for JWT caller
    const actRes = await alexClient.callTool({
      name: 'get_activity',
      arguments: { cardId: privateCardId },
    });
    const actPayload = parseToolText<{ activity: Activity[] }>(actRes);
    const createAct = actPayload.activity.find((a) => a.action === 'card.created');
    expect(createAct?.actorType).toBe('agent');
    expect(createAct?.agentName).toBe('Claude Desktop');

    await alexClient.close();

    // 2. API key path (Sam)
    const samClient = await connectMcpClient(samApiKey, {
      'X-Agent-Name': 'Sam MCP Harness',
    });

    // Visibility isolation: Sam cannot read Alex's private card
    const samGetPrivate = await samClient.callTool({
      name: 'get_card',
      arguments: { cardId: privateCardId },
    });
    expect((samGetPrivate as { isError?: boolean }).isError).toBe(true);
    const errBody = parseToolText<{ error: { code: string } }>(samGetPrivate);
    expect(errBody.error.code).toBe('CARD_NOT_FOUND');

    // Sam's snapshot omits Alex's private card
    const samSnapRes = await samClient.callTool({
      name: 'get_workspace_snapshot',
      arguments: {},
    });
    const samSnap = parseToolText<{ cards: Card[] }>(samSnapRes);
    expect(samSnap.cards.some((c) => c.id === privateCardId)).toBe(false);

    // Sam creates a shared card via MCP API key
    const samCreated = await samClient.callTool({
      name: 'create_card',
      arguments: {
        title: 'Sam MCP shared card',
        awareUserIds: ['user-alex'],
        note: 'Created by Sam MCP',
      },
    });
    const samCard = parseToolText<{ card: Card }>(samCreated).card;
    const samActRes = await samClient.callTool({
      name: 'get_activity',
      arguments: { cardId: samCard.id },
    });
    const samAct = parseToolText<{ activity: Activity[] }>(samActRes).activity[0];
    expect(samAct?.actorType).toBe('agent');
    expect(samAct?.agentName).toBe('Sam MCP Harness');
    expect(samAct?.platform).toBe('MCP Bot');

    await samClient.close();
  });
});
