import { expect, test, type Page } from '@playwright/test';

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const win = globalThis as unknown as {
      innerWidth: number;
      document: { documentElement: { scrollWidth: number } };
    };
    return win.document.documentElement.scrollWidth > win.innerWidth;
  });
}

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'demo-agent-kanban';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5050';

async function clearFirestore(): Promise<void> {
  const res = await fetch(
    `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    throw new Error(`Failed to clear Firestore emulator: HTTP ${res.status}`);
  }
}

async function seedUsersViaFirestoreRest(): Promise<void> {
  // Dynamically import seedEmulator to keep user & card setup aligned with emulator scripts
  const { getApp, getApps, initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { SEED_USERS } = await import('../scripts/seed-emulator.js');

  process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST;
  const app = getApps().length > 0 ? getApp() : initializeApp({ projectId: PROJECT_ID });
  const db = getFirestore(app);
  for (const user of SEED_USERS) {
    await db.collection('users').doc(user.id).set(user);
  }
}

async function getDevToken(handle: 'alex' | 'sam'): Promise<string> {
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

async function createCardViaApi(token: string, body: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/cards`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Failed to create card: HTTP ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { card: { id: string } };
  return data.card.id;
}

test.describe('M1.5 PWA Views, Top 5 To-Do, Active, Done, Search & Filters', () => {
  test.beforeAll(async () => {
    await clearFirestore();
    await seedUsersViaFirestoreRest();

    const alexToken = await getDevToken('alex');
    const samToken = await getDevToken('sam');

    const todoFixtures = [
      {
        title: 'Todo Priority 1 — Confirm HVAC inspection',
        priorityScore: 96,
        priorityReason: 'Time-sensitive seasonal maintenance',
        tags: ['home'],
        assignedUserIds: ['user-alex'],
        awareUserIds: ['user-sam'],
        due: '2026-12-01T00:00:00.000Z',
        dueFirm: true,
        checklists: [
          {
            title: 'Prep',
            items: [
              { text: 'Measure filter', checked: true },
              { text: 'Call office', checked: false },
            ],
          },
        ],
        recurrence: { type: 'interval_after_completion', every: 30, unit: 'days' },
      },
      {
        title: 'Todo Priority 2 — File quarterly estimated taxes',
        priorityScore: 91,
        priorityReason: 'Firm tax filing deadline',
        tags: ['finance'],
        assignedUserIds: ['user-sam'],
        awareUserIds: ['user-alex'],
        due: '2026-12-05T00:00:00.000Z',
        dueFirm: true,
      },
      {
        title: 'Todo Priority 3 — Restock pantry coffee beans',
        priorityScore: 84,
        priorityReason: 'Running low before weekend',
        tags: ['errands'],
        assignedUserIds: ['user-alex'],
        awareUserIds: ['user-sam'],
      },
      {
        title: 'Todo Priority 4 — Clean gutters before rain',
        priorityScore: 77,
        priorityReason: 'Storm forecast later this week',
        tags: ['home'],
        assignedUserIds: ['user-sam'],
        awareUserIds: ['user-alex'],
      },
      {
        title: 'Todo Priority 5 — Update emergency contact card',
        priorityScore: 70,
        priorityReason: 'Annual family checkup',
        tags: ['home'],
        assignedUserIds: ['user-alex'],
        awareUserIds: ['user-sam'],
      },
      {
        title: 'Todo Priority 6 — Order spare vacuum bags',
        priorityScore: 62,
        priorityReason: 'Low priority household supply',
        tags: ['errands'],
        assignedUserIds: ['user-alex'],
        awareUserIds: ['user-sam'],
      },
      {
        title: 'Todo Priority 7 — Review internet bill promo rate',
        priorityScore: 55,
        priorityReason: 'Upcoming monthly billing cycle',
        tags: ['finance'],
        assignedUserIds: ['user-sam'],
        awareUserIds: ['user-alex'],
      },
      {
        title: 'Todo Priority 8 — Label garage storage totes',
        priorityScore: 48,
        priorityReason: 'Nice-to-have weekend organizing',
        tags: ['home'],
        assignedUserIds: ['user-alex'],
        awareUserIds: ['user-sam'],
      },
    ];

    for (const fixture of todoFixtures) {
      await createCardViaApi(alexToken, fixture);
    }

    await createCardViaApi(alexToken, {
      title: 'Doing Card — Paint hallway trim',
      status: 'doing',
      tags: ['home'],
      assignedUserIds: ['user-alex'],
      awareUserIds: ['user-sam'],
    });

    await createCardViaApi(samToken, {
      title: 'Blocked Card — Waiting for patio chair cushions',
      status: 'blocked',
      tags: ['home'],
      assignedUserIds: ['user-sam'],
      awareUserIds: ['user-alex'],
    });

    await createCardViaApi(alexToken, {
      title: 'Done Card — Drop off charity donation box',
      status: 'done',
      tags: ['errands'],
      assignedUserIds: ['user-alex'],
      awareUserIds: ['user-sam'],
    });

    const archivedDoneId = await createCardViaApi(alexToken, {
      title: 'Archived Done Card — Old winter salt bag',
      status: 'done',
      tags: ['home'],
      assignedUserIds: ['user-alex'],
      awareUserIds: ['user-sam'],
    });
    const archiveRes = await fetch(`${BASE_URL}/api/cards/${archivedDoneId}/archive`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${alexToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ archived: true }),
    });
    if (!archiveRes.ok) {
      throw new Error(`Failed to archive card: HTTP ${archiveRes.status}`);
    }

    const archivedTodoId = await createCardViaApi(alexToken, {
      title: 'Archived Todo Card — Cancelled spring mulch order',
      status: 'todo',
      tags: ['home'],
      assignedUserIds: ['user-alex'],
      awareUserIds: ['user-sam'],
    });
    const archiveTodoRes = await fetch(`${BASE_URL}/api/cards/${archivedTodoId}/archive`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${alexToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ archived: true }),
    });
    if (!archiveTodoRes.ok) {
      throw new Error(`Failed to archive todo card: HTTP ${archiveTodoRes.status}`);
    }
  });

  test('renders Top 5 To-Do with Show 3 more, Active/Done views, filters, search, and zero mobile overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    // Sign in as Alex
    await page.getByRole('button', { name: /Sign in as Alex \(@alex\)/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'To-Do' })).toBeVisible();

    // Top 5 visible by default, cards 6-8 hidden behind "Show 3 more"
    await expect(page.getByText('Todo Priority 1 — Confirm HVAC inspection')).toBeVisible();
    await expect(page.getByText('Todo Priority 5 — Update emergency contact card')).toBeVisible();
    await expect(page.getByText('Todo Priority 6 — Order spare vacuum bags')).toHaveCount(0);
    await expect(page.getByText('Archived Todo Card — Cancelled spring mulch order')).toHaveCount(
      0,
    );
    await expect(page.getByText('☑ 1/2')).toBeVisible();
    await expect(page.getByText('↻ Recurring')).toBeVisible();

    // Verify priority order: Priority 1 appears before Priority 5
    const mainText = await page.locator('main').innerText();
    expect(mainText.indexOf('Todo Priority 1')).toBeLessThan(mainText.indexOf('Todo Priority 5'));

    // Expand remaining 3
    const showMoreBtn = page.getByRole('button', { name: 'Show 3 more' });
    await expect(showMoreBtn).toBeVisible();
    await showMoreBtn.click();
    await expect(page.getByText('Todo Priority 6 — Order spare vacuum bags')).toBeVisible();
    await expect(page.getByText('Todo Priority 8 — Label garage storage totes')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Hide 3 more' })).toBeVisible();

    // Mobile horizontal overflow check on To-Do
    expect(await hasHorizontalOverflow(page)).toBe(false);

    // Filter by #finance tag -> narrows to Priority 2 and Priority 7
    await page.getByRole('button', { name: '#finance' }).click();
    await expect(page.getByText('Todo Priority 2 — File quarterly estimated taxes')).toBeVisible();
    await expect(page.getByText('Todo Priority 7 — Review internet bill promo rate')).toBeVisible();
    await expect(page.getByText('Todo Priority 1 — Confirm HVAC inspection')).toHaveCount(0);

    // Reset tag filter via "All"
    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(page.getByText('Todo Priority 1 — Confirm HVAC inspection')).toBeVisible();

    // Person filter: Assigned to me (Alex) -> hides Sam's cards
    await page.getByLabel('Filter by person').selectOption('me');
    await expect(page.getByText('Todo Priority 1 — Confirm HVAC inspection')).toBeVisible();
    await expect(page.getByText('Todo Priority 2 — File quarterly estimated taxes')).toHaveCount(0);

    // Reset person filter and test debounced search
    await page.getByLabel('Filter by person').selectOption('all');
    const searchInput = page.getByRole('searchbox', { name: 'Search cards' });
    await searchInput.fill('gutters');
    await expect(page.getByText('Todo Priority 4 — Clean gutters before rain')).toBeVisible();
    await expect(page.getByText('Todo Priority 1 — Confirm HVAC inspection')).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.getByText('Todo Priority 1 — Confirm HVAC inspection')).toBeVisible();

    // Active tab: Doing and Blocked sections
    await page.getByRole('link', { name: 'Active' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Active' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /Doing \(1\)/ })).toBeVisible();
    await expect(page.getByText('Doing Card — Paint hallway trim')).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: /Blocked \(1\)/ })).toBeVisible();
    await expect(page.getByText('Blocked Card — Waiting for patio chair cushions')).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);

    // Done tab: non-archived visible, archived hidden until toggled
    await page.getByRole('link', { name: 'Done' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Done' })).toBeVisible();
    await expect(page.getByText('Done Card — Drop off charity donation box')).toBeVisible();
    await expect(page.getByText('Archived Done Card — Old winter salt bag')).toHaveCount(0);
    await expect(page.getByText('Archived Todo Card — Cancelled spring mulch order')).toHaveCount(
      0,
    );

    await page.getByLabel('Include archived').check();
    await expect(page.getByText('Archived Done Card — Old winter salt bag')).toBeVisible();
    await expect(page.getByText('Archived Todo Card — Cancelled spring mulch order')).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);

    // Settings tab: zero overflow
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });
});
