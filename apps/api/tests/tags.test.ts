import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CardSchema,
  buildSearchTokens,
  type Activity,
  type AgentConnection,
  type Card,
} from '@agent-kanban/shared';
import { seedEmulator } from '../../../scripts/seed-emulator.js';

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'demo-agent-kanban';
const REGION = 'us-central1';
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST ?? '127.0.0.1:5001';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const BASE_URL = `http://${FUNCTIONS_HOST}/${PROJECT_ID}/${REGION}/api`;

interface TagSummary {
  tag: string;
  openCount: number;
  totalCount: number;
  lastUsedAt: string;
}

interface SnapshotPayload {
  tags: Array<{ tag: string; openCount: number }>;
  cards: Card[];
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

function buildLegacyCard(
  overrides: Partial<Card> &
    Pick<Card, 'id' | 'title' | 'tags' | 'assignedUserIds' | 'visibleToUserIds'>,
): Card {
  const nowIso = '2026-06-15T12:00:00.000Z';
  return CardSchema.parse({
    description: 'Legacy mixed-case tag card',
    status: 'todo',
    awareUserIds: [],
    priorityScore: null,
    priorityReason: null,
    due: null,
    dueFirm: false,
    dueHasTime: false,
    recurrence: null,
    links: [],
    checklists: [],
    commentCount: 0,
    archived: false,
    enteredStatusAt: nowIso,
    lastTouchedAt: nowIso,
    createdBy: overrides.assignedUserIds[0],
    createdAt: nowIso,
    updatedAt: nowIso,
    searchTokens: buildSearchTokens({
      title: overrides.title,
      description: 'Legacy mixed-case tag card',
    }),
    trelloUrl: null,
    trelloShortLink: null,
    dueSoonNotifiedAt: null,
    overdueNotifiedAt: null,
    ...overrides,
  });
}

function findTag(tags: readonly TagSummary[], tag: string): TagSummary {
  const match = tags.find((summary) => summary.tag === tag);
  if (!match) {
    throw new Error(`Expected tag "${tag}" in vocabulary`);
  }
  return match;
}

describe('Tag normalization, vocabulary, rename & MCP list_tags (Emulator)', () => {
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

    const connection = await apiRequest<{ connection: AgentConnection; apiKey: string }>(
      '/api/agent-connections',
      {
        method: 'POST',
        token: alexToken,
        body: { platform: 'Tag Bot' },
      },
    );
    expect(connection.status).toBe(201);
    alexApiKey = connection.data.apiKey;
  });

  it('normalizes writes, matches filters case-insensitively, and lists only visible tags', async () => {
    const created = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Paint the fence',
        tags: ['M5-Create', ' m5-create ', 'M5-Other'],
        awareUserIds: [],
      },
    });
    expect(created.status).toBe(201);
    expect(created.data.card.tags).toEqual(['m5-create', 'm5-other']);

    const legacy = buildLegacyCard({
      id: 'card-m5-legacy-alex',
      title: 'Legacy grocery list',
      tags: ['M5-Legacy', 'm5-legacy', 'M5-Keep'],
      assignedUserIds: ['user-alex'],
      visibleToUserIds: ['user-alex'],
      updatedAt: '2026-06-15T15:00:00.000Z',
    });
    const samLegacy = buildLegacyCard({
      id: 'card-m5-legacy-sam',
      title: 'Sam private legacy list',
      tags: ['M5-Legacy'],
      assignedUserIds: ['user-sam'],
      visibleToUserIds: ['user-sam'],
      createdBy: 'user-sam',
    });
    await db.collection('cards').doc(legacy.id).set(legacy);
    await db.collection('cards').doc(samLegacy.id).set(samLegacy);

    const filtered = await apiRequest<{ cards: Card[] }>('/api/cards?tag=M5-LEGACY', {
      token: alexToken,
    });
    expect(filtered.status).toBe(200);
    expect(filtered.data.cards.map((card) => card.id)).toEqual(['card-m5-legacy-alex']);

    const done = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Finished m5 errand',
        tags: ['m5-done'],
        awareUserIds: [],
      },
    });
    expect(done.status).toBe(201);
    const markedDone = await apiRequest<{ card: Card }>(`/api/cards/${done.data.card.id}/status`, {
      method: 'POST',
      token: alexToken,
      body: { status: 'done' },
    });
    expect(markedDone.status).toBe(200);

    const archived = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Archived m5 tag',
        tags: ['m5-archived'],
        awareUserIds: [],
      },
    });
    expect(archived.status).toBe(201);
    const archivedResult = await apiRequest<{ card: Card }>(
      `/api/cards/${archived.data.card.id}/archive`,
      {
        method: 'POST',
        token: alexToken,
        body: { archived: true },
      },
    );
    expect(archivedResult.status).toBe(200);

    const alexTags = await apiRequest<{ tags: TagSummary[] }>('/api/tags', { token: alexToken });
    expect(alexTags.status).toBe(200);
    const legacySummary = findTag(alexTags.data.tags, 'm5-legacy');
    expect(legacySummary).toMatchObject({ openCount: 1, totalCount: 1 });
    expect(legacySummary.lastUsedAt).toBe('2026-06-15T15:00:00.000Z');
    expect(findTag(alexTags.data.tags, 'm5-done')).toMatchObject({ openCount: 0, totalCount: 1 });
    expect(alexTags.data.tags.some((summary) => summary.tag === 'm5-archived')).toBe(false);

    const withArchived = await apiRequest<{ tags: TagSummary[] }>(
      '/api/tags?includeArchived=true',
      { token: alexToken },
    );
    expect(findTag(withArchived.data.tags, 'm5-archived')).toMatchObject({
      openCount: 0,
      totalCount: 1,
    });

    const samTags = await apiRequest<{ tags: TagSummary[] }>('/api/tags', { token: samToken });
    expect(samTags.status).toBe(200);
    expect(samTags.data.tags.some((summary) => summary.tag === 'm5-create')).toBe(false);
    expect(findTag(samTags.data.tags, 'm5-legacy')).toMatchObject({
      openCount: 1,
      totalCount: 1,
    });

    const highA = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: { title: 'High A', tags: ['m5-high', 'm5-low'], awareUserIds: [] },
    });
    const highB = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: { title: 'High B', tags: ['m5-high'], awareUserIds: [] },
    });
    const highC = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: { title: 'High C', tags: ['m5-high', 'm5-mid'], awareUserIds: [] },
    });
    expect(highA.status).toBe(201);
    expect(highB.status).toBe(201);
    expect(highC.status).toBe(201);
    const midDone = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: { title: 'Mid done', tags: ['m5-mid'], awareUserIds: [] },
    });
    expect(midDone.status).toBe(201);
    expect(
      (
        await apiRequest(`/api/cards/${midDone.data.card.id}/status`, {
          method: 'POST',
          token: alexToken,
          body: { status: 'done' },
        })
      ).status,
    ).toBe(200);

    const sorted = await apiRequest<{ tags: TagSummary[] }>('/api/tags', { token: alexToken });
    const tags = sorted.data.tags.map((summary) => summary.tag);
    expect(tags.indexOf('m5-high')).toBeLessThan(tags.indexOf('m5-mid'));
    expect(tags.indexOf('m5-mid')).toBeLessThan(tags.indexOf('m5-low'));
    expect(findTag(sorted.data.tags, 'm5-high').openCount).toBe(3);
    expect(findTag(sorted.data.tags, 'm5-mid')).toMatchObject({ openCount: 1, totalCount: 2 });
    expect(findTag(sorted.data.tags, 'm5-low')).toMatchObject({ openCount: 1, totalCount: 1 });

    const bulk = await apiRequest<{ cards: Card[] }>('/api/cards/bulk', {
      method: 'PATCH',
      token: alexToken,
      body: {
        updates: [
          {
            cardId: legacy.id,
            addTags: ['M5-Added'],
            removeTags: ['M5-KEEP'],
          },
        ],
      },
    });
    expect(bulk.status).toBe(200);
    expect(bulk.data.cards[0]?.tags).toEqual(['m5-legacy', 'm5-added']);
  });

  it('renames and deletes tags across visible cards, refreshes search tokens, and replays idempotency', async () => {
    const shared = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Paint the fence',
        description: 'Sand and prime before sunset',
        tags: ['m5-rename'],
        awareUserIds: ['user-sam'],
        note: 'Shared rename target',
      },
    });
    expect(shared.status).toBe(201);
    const sharedId = shared.data.card.id;

    const alexPrivate = buildLegacyCard({
      id: 'card-m5-rename-alex',
      title: 'Alex rename private',
      tags: ['M5-Rename', 'KeepMe'],
      assignedUserIds: ['user-alex'],
      visibleToUserIds: ['user-alex'],
    });
    const samPrivate = buildLegacyCard({
      id: 'card-m5-rename-sam',
      title: 'Sam rename private',
      tags: ['M5-Rename'],
      assignedUserIds: ['user-sam'],
      visibleToUserIds: ['user-sam'],
      createdBy: 'user-sam',
    });
    await db.collection('cards').doc(alexPrivate.id).set(alexPrivate);
    await db.collection('cards').doc(samPrivate.id).set(samPrivate);

    const idempotencyKey = 'm5-rename-paint-001';
    const renamed = await apiRequest<{
      fromTag: string;
      toTag: string | null;
      updatedCount: number;
      cards: Card[];
    }>('/api/tags/rename', {
      method: 'POST',
      token: alexToken,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: { fromTag: 'M5-RENAME', toTag: 'm5-painting', note: 'Merge paint tags' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.headers.get('x-idempotent-replay')).toBeNull();
    expect(renamed.data.fromTag).toBe('m5-rename');
    expect(renamed.data.toTag).toBe('m5-painting');
    expect(renamed.data.updatedCount).toBe(2);
    expect(renamed.data.cards.map((card) => card.id).sort()).toEqual(
      [sharedId, alexPrivate.id].sort(),
    );

    const sharedAfter = renamed.data.cards.find((card) => card.id === sharedId);
    expect(sharedAfter?.tags).toEqual(['m5-painting']);
    expect(sharedAfter?.searchTokens).toEqual(
      buildSearchTokens({
        title: 'Paint the fence',
        description: 'Sand and prime before sunset',
        checklists: [],
      }),
    );
    const privateAfter = renamed.data.cards.find((card) => card.id === alexPrivate.id);
    expect(privateAfter?.tags).toEqual(['m5-painting', 'KeepMe']);

    const samStillPrivate = await apiRequest<{ card: Card }>(`/api/cards/${samPrivate.id}`, {
      token: samToken,
    });
    expect(samStillPrivate.status).toBe(200);
    expect(samStillPrivate.data.card.tags).toEqual(['M5-Rename']);

    const alexActivity = await apiRequest<{ activity: Activity[] }>(
      `/api/cards/${sharedId}/activity`,
      { token: alexToken },
    );
    expect(
      alexActivity.data.activity.some(
        (entry) =>
          entry.action === 'card.updated' &&
          entry.actorType === 'human' &&
          entry.note === 'Merge paint tags',
      ),
    ).toBe(true);

    const events = await db.collection('events').where('cardId', '==', sharedId).get();
    expect(events.docs.some((doc) => doc.data().type === 'card.updated')).toBe(true);

    const replay = await apiRequest<{ updatedCount: number; cards: Card[] }>('/api/tags/rename', {
      method: 'POST',
      token: alexToken,
      headers: { 'Idempotency-Key': idempotencyKey },
      body: { fromTag: 'm5-rename', toTag: 'm5-painting', note: 'Merge paint tags' },
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('x-idempotent-replay')).toBe('true');
    expect(replay.data.cards.find((card) => card.id === sharedId)?.updatedAt).toBe(
      sharedAfter?.updatedAt,
    );

    const removed = await apiRequest<{ updatedCount: number; cards: Card[] }>('/api/tags/rename', {
      method: 'POST',
      token: alexToken,
      body: { fromTag: 'm5-painting', toTag: null },
    });
    expect(removed.status).toBe(200);
    expect(removed.data.updatedCount).toBe(2);
    expect(removed.data.cards.find((card) => card.id === sharedId)?.tags).toEqual([]);
    expect(removed.data.cards.find((card) => card.id === alexPrivate.id)?.tags).toEqual(['KeepMe']);

    const samAfterDelete = await db.collection('cards').doc(samPrivate.id).get();
    expect(samAfterDelete.data()?.tags).toEqual(['M5-Rename']);
  });

  it('suppresses agent rename events and returns matching MCP list_tags and snapshot counts', async () => {
    const created = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Agent tag source',
        tags: ['m5-agent'],
        awareUserIds: ['user-sam'],
      },
    });
    expect(created.status).toBe(201);
    const cardId = created.data.card.id;
    const eventsBefore = await db.collection('events').where('cardId', '==', cardId).get();

    const renamed = await apiRequest<{ cards: Card[] }>('/api/tags/rename', {
      method: 'POST',
      token: alexApiKey,
      headers: { 'X-Agent-Name': 'Tag Bot' },
      body: { fromTag: 'M5-Agent', toTag: 'm5-agent-renamed' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.data.cards.find((card) => card.id === cardId)?.tags).toEqual([
      'm5-agent-renamed',
    ]);

    const eventsAfter = await db.collection('events').where('cardId', '==', cardId).get();
    expect(eventsAfter.size).toBe(eventsBefore.size);
    expect(eventsAfter.docs.some((doc) => doc.data().actor?.actorType === 'agent')).toBe(false);

    const activity = await db.collection('activity').where('cardId', '==', cardId).get();
    expect(
      activity.docs.some(
        (doc) => doc.data().actorType === 'agent' && doc.data().agentName === 'Tag Bot',
      ),
    ).toBe(true);

    const client = new Client({ name: 'test-tags-mcp-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${alexToken}` } },
    });
    await client.connect(transport);

    const listed = await client.callTool({ name: 'list_tags', arguments: {} });
    const listedText = (listed as { content: Array<{ text?: string }> }).content[0]?.text ?? '';
    const vocabulary = JSON.parse(listedText) as { tags: TagSummary[] };
    const agentTag = findTag(vocabulary.tags, 'm5-agent-renamed');
    expect(agentTag.openCount).toBeGreaterThanOrEqual(1);

    const snapshotResult = await client.callTool({
      name: 'get_workspace_snapshot',
      arguments: {},
    });
    const snapshotText =
      (snapshotResult as { content: Array<{ text?: string }> }).content[0]?.text ?? '';
    const snapshot = JSON.parse(snapshotText) as SnapshotPayload;
    expect(snapshot.tags.find((summary) => summary.tag === 'm5-agent-renamed')?.openCount).toBe(
      agentTag.openCount,
    );
    expect(snapshot.cards.some((card) => card.id === cardId)).toBe(true);

    await client.close();
  });
});
