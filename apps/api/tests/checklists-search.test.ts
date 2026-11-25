import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { beforeAll, describe, expect, it } from 'vitest';
import type {
  Activity,
  Card,
  Checklist,
  ChecklistItem,
  LinkAttachment,
} from '@agent-kanban/shared';
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
    details?: unknown;
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

describe('Checklists CRUD/toggle, link attachments & full-text token search (Emulator)', () => {
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

  it('supports checklist CRUD, item toggling, activity logging, and search token updates', async () => {
    const created = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Winterize outdoor faucet',
        description: 'Shut off interior valve and drain exterior spigot before freeze.',
        assignedUserIds: ['user-alex'],
        awareUserIds: ['user-sam'],
      },
    });
    expect(created.status).toBe(201);
    const cardId = created.data.card.id;

    // 1. Create checklist with initial items
    const addChecklist = await apiRequest<{ card: Card; checklist: Checklist }>(
      `/api/cards/${cardId}/checklists`,
      {
        method: 'POST',
        token: alexToken,
        body: {
          title: 'Shutoff Steps',
          items: [
            { text: 'Locate basement brass valve', checked: false },
            { text: 'Attach insulated foam cover', checked: true },
          ],
          note: 'Initial winterization checklist',
        },
      },
    );
    expect(addChecklist.status).toBe(201);
    const checklistId = addChecklist.data.checklist.id;
    expect(addChecklist.data.checklist.items).toHaveLength(2);
    expect(addChecklist.data.card.searchTokens).toContain('basement');
    expect(addChecklist.data.card.searchTokens).toContain('foam');

    // 2. Rename & replace items
    const existingItem = addChecklist.data.checklist.items[0]!;
    const renamed = await apiRequest<{ card: Card; checklist: Checklist }>(
      `/api/cards/${cardId}/checklists/${checklistId}`,
      {
        method: 'PATCH',
        token: samToken,
        body: {
          title: 'Basement Shutoff Steps',
          items: [
            { id: existingItem.id, text: 'Close basement brass ball valve', checked: false },
            { text: 'Open outdoor bleeder cap', checked: false },
          ],
          note: 'Clarified valve type',
        },
      },
    );
    expect(renamed.status).toBe(200);
    expect(renamed.data.checklist.title).toBe('Basement Shutoff Steps');
    expect(renamed.data.checklist.items).toHaveLength(2);
    expect(renamed.data.card.searchTokens).toContain('bleeder');

    // Stale ifUpdatedAt returns 409
    const staleUpdate = await apiRequest<ApiErrorBody>(
      `/api/cards/${cardId}/checklists/${checklistId}`,
      {
        method: 'PATCH',
        token: alexToken,
        body: {
          title: 'Stale overwrite',
          ifUpdatedAt: created.data.card.updatedAt,
        },
      },
    );
    expect(staleUpdate.status).toBe(409);
    expect(staleUpdate.data.error.code).toBe('CONFLICT');

    // 3. Add item
    const addedItem = await apiRequest<{ card: Card; item: ChecklistItem }>(
      `/api/cards/${cardId}/checklists/${checklistId}/items`,
      {
        method: 'POST',
        token: alexToken,
        body: {
          text: 'Store garden hose in shed',
          note: 'Prevent hose cracking',
        },
      },
    );
    expect(addedItem.status).toBe(201);
    const hoseItemId = addedItem.data.item.id;
    expect(addedItem.data.item.checked).toBe(false);
    expect(addedItem.data.card.searchTokens).toContain('garden');

    // Search finds word in newly added checklist item
    const searchGarden = await apiRequest<{ cards: Card[] }>('/api/cards/search?q=garden+hose', {
      token: samToken,
    });
    expect(searchGarden.status).toBe(200);
    expect(searchGarden.data.cards.map((c) => c.id)).toContain(cardId);

    // 4. Toggle item checked and edit text
    const toggledItem = await apiRequest<{ card: Card; item: ChecklistItem }>(
      `/api/cards/${cardId}/checklists/${checklistId}/items/${hoseItemId}`,
      {
        method: 'PATCH',
        token: samToken,
        body: {
          checked: true,
          text: 'Coil garden hose inside garage',
          note: 'Done after draining',
        },
      },
    );
    expect(toggledItem.status).toBe(200);
    expect(toggledItem.data.item.checked).toBe(true);
    expect(toggledItem.data.item.text).toBe('Coil garden hose inside garage');
    expect(toggledItem.data.card.searchTokens).toContain('coil');
    expect(toggledItem.data.card.searchTokens).not.toContain('shed');

    // 5. Delete item & verify search tokens update
    const deletedItem = await apiRequest<{ card: Card }>(
      `/api/cards/${cardId}/checklists/${checklistId}/items/${hoseItemId}`,
      {
        method: 'DELETE',
        token: alexToken,
        body: { note: 'Moved hose task elsewhere' },
      },
    );
    expect(deletedItem.status).toBe(200);
    expect(deletedItem.data.card.searchTokens).not.toContain('coil');

    const searchCoilAfterDelete = await apiRequest<{ cards: Card[] }>('/api/cards/search?q=coil', {
      token: alexToken,
    });
    expect(searchCoilAfterDelete.status).toBe(200);
    expect(searchCoilAfterDelete.data.cards.map((c) => c.id)).not.toContain(cardId);

    // 6. Delete checklist
    const deletedChecklist = await apiRequest<{ card: Card }>(
      `/api/cards/${cardId}/checklists/${checklistId}`,
      {
        method: 'DELETE',
        token: alexToken,
        body: { note: 'Checklist superseded' },
      },
    );
    expect(deletedChecklist.status).toBe(200);
    expect(deletedChecklist.data.card.checklists).toHaveLength(0);
    expect(deletedChecklist.data.card.searchTokens).not.toContain('bleeder');

    // Verify activity entries recorded all checklist actions
    const activityRes = await apiRequest<{ activity: Activity[] }>(
      `/api/cards/${cardId}/activity?limit=20`,
      { token: alexToken },
    );
    expect(activityRes.status).toBe(200);
    const actions = activityRes.data.activity.map((entry) => entry.action);
    expect(actions).toContain('card.checklist_created');
    expect(actions).toContain('card.checklist_updated');
    expect(actions).toContain('card.checklist_item_added');
    expect(actions).toContain('card.checklist_item_updated');
    expect(actions).toContain('card.checklist_item_deleted');
    expect(actions).toContain('card.checklist_deleted');
  });

  it('adds and deletes valid link attachments, rejects invalid protocols, and enforces visibility', async () => {
    const privateCardRes = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Private espresso grinder research',
        description: 'Compare conical burr grinders with quiet motors.',
        assignedUserIds: ['user-alex'],
        awareUserIds: [],
        checklists: [
          {
            title: 'Models',
            items: [{ text: 'Check Niche Zero warranty' }],
          },
        ],
      },
    });
    expect(privateCardRes.status).toBe(201);
    const privateId = privateCardRes.data.card.id;

    // Invalid URL protocols rejected with 400
    const badProto = await apiRequest<ApiErrorBody>(`/api/cards/${privateId}/links`, {
      method: 'POST',
      token: alexToken,
      body: { url: 'javascript:alert(1)', label: 'Bad' },
    });
    expect(badProto.status).toBe(400);

    const ftpProto = await apiRequest<ApiErrorBody>(`/api/cards/${privateId}/links`, {
      method: 'POST',
      token: alexToken,
      body: { url: 'ftp://example.test/manual.pdf' },
    });
    expect(ftpProto.status).toBe(400);

    // Valid link attachment succeeds & logs activity
    const addedLink = await apiRequest<{ card: Card; link: LinkAttachment }>(
      `/api/cards/${privateId}/links`,
      {
        method: 'POST',
        token: alexToken,
        body: {
          url: 'https://example.test/grinder-review',
          label: 'Grinder review',
          note: 'Reference benchmark',
        },
      },
    );
    expect(addedLink.status).toBe(201);
    const linkId = addedLink.data.link.id;
    expect(addedLink.data.card.links).toHaveLength(1);

    // Sam gets 404 on Alex's private card checklists & links
    const samChecklist = await apiRequest<ApiErrorBody>(`/api/cards/${privateId}/checklists`, {
      method: 'POST',
      token: samToken,
      body: { title: 'Unauthorized' },
    });
    expect(samChecklist.status).toBe(404);

    const samLink = await apiRequest<ApiErrorBody>(`/api/cards/${privateId}/links`, {
      method: 'POST',
      token: samToken,
      body: { url: 'https://example.test/sneaky' },
    });
    expect(samLink.status).toBe(404);

    const samDeleteLink = await apiRequest<ApiErrorBody>(
      `/api/cards/${privateId}/links/${linkId}`,
      {
        method: 'DELETE',
        token: samToken,
      },
    );
    expect(samDeleteLink.status).toBe(404);

    // Alex deletes link cleanly
    const removedLink = await apiRequest<{ card: Card }>(
      `/api/cards/${privateId}/links/${linkId}`,
      {
        method: 'DELETE',
        token: alexToken,
        body: { note: 'Outdated link' },
      },
    );
    expect(removedLink.status).toBe(200);
    expect(removedLink.data.card.links).toHaveLength(0);

    const activityRes = await apiRequest<{ activity: Activity[] }>(
      `/api/cards/${privateId}/activity`,
      { token: alexToken },
    );
    const actions = activityRes.data.activity.map((entry) => entry.action);
    expect(actions).toContain('card.link_added');
    expect(actions).toContain('card.link_removed');
  });

  it('searches across title, description, and checklist items with prefix & multi-term matching and visibility isolation', async () => {
    // Search across title ("HVAC") + description ("filter") + checklist ("vent") on seeded card-seed-1
    const multiTerm = await apiRequest<{ cards: Card[] }>('/api/cards/search?q=hvac+filter+vent', {
      token: samToken,
    });
    expect(multiTerm.status).toBe(200);
    expect(multiTerm.data.cards.map((c) => c.id)).toContain('card-seed-1');

    // Prefix search ("maint" -> "maintenance")
    const prefixSearch = await apiRequest<{ cards: Card[] }>('/api/cards/search?q=maint', {
      token: samToken,
    });
    expect(prefixSearch.status).toBe(200);
    expect(prefixSearch.data.cards.map((c) => c.id)).toContain('card-seed-1');

    // Multi-word AND semantics: adding an unmatched term excludes the card
    const partialMismatch = await apiRequest<{ cards: Card[] }>(
      '/api/cards/search?q=hvac+xylophone',
      { token: alexToken },
    );
    expect(partialMismatch.status).toBe(200);
    expect(partialMismatch.data.cards).toHaveLength(0);

    // Visibility isolation: Alex finds his private "espresso" / "burr" / "warranty" card; Sam does not
    const alexPrivateSearch = await apiRequest<{ cards: Card[] }>(
      '/api/cards/search?q=espresso+warranty',
      { token: alexToken },
    );
    expect(alexPrivateSearch.status).toBe(200);
    expect(alexPrivateSearch.data.cards.some((c) => c.title.includes('espresso'))).toBe(true);

    const samPrivateSearch = await apiRequest<{ cards: Card[] }>(
      '/api/cards/search?q=espresso+warranty',
      { token: samToken },
    );
    expect(samPrivateSearch.status).toBe(200);
    expect(samPrivateSearch.data.cards).toHaveLength(0);

    // Archived filtering on search
    const archivedCreate = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Old archived telescope calibration',
        awareUserIds: ['user-sam'],
      },
    });
    expect(archivedCreate.status).toBe(201);
    const archivedId = archivedCreate.data.card.id;

    await apiRequest(`/api/cards/${archivedId}/archive`, {
      method: 'POST',
      token: alexToken,
      body: { archived: true },
    });

    const defaultSearch = await apiRequest<{ cards: Card[] }>('/api/cards/search?q=telescope', {
      token: samToken,
    });
    expect(defaultSearch.status).toBe(200);
    expect(defaultSearch.data.cards.map((c) => c.id)).not.toContain(archivedId);

    const archivedOnlySearch = await apiRequest<{ cards: Card[] }>(
      '/api/cards/search?q=telescope&archived=true',
      { token: samToken },
    );
    expect(archivedOnlySearch.status).toBe(200);
    expect(archivedOnlySearch.data.cards.map((c) => c.id)).toContain(archivedId);

    const allSearch = await apiRequest<{ cards: Card[] }>(
      '/api/cards/search?q=telescope&archived=all',
      { token: samToken },
    );
    expect(allSearch.status).toBe(200);
    expect(allSearch.data.cards.map((c) => c.id)).toContain(archivedId);

    // Empty q rejected with 400
    const emptyQ = await apiRequest<ApiErrorBody>('/api/cards/search?q=', {
      token: alexToken,
    });
    expect(emptyQ.status).toBe(400);
  });
});
