import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'demo-agent-kanban';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:5050';

const RECURRING_TITLE = 'M6 Recurring linen change';
const PIN_TITLE = 'M6 Pin candidate';
const HIGH_SCORE_TITLE = 'M6 High score task';

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const win = globalThis as unknown as {
      innerWidth: number;
      document: { documentElement: { scrollWidth: number } };
    };
    return win.document.documentElement.scrollWidth > win.innerWidth;
  });
}

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

async function signInAsAlex(page: Page): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: /Sign in as Alex \(@alex\)/i }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'To-Do' })).toBeVisible();
}

test.describe('M6.4 Schedule tab, snooze, pin, and rescore', () => {
  test.beforeAll(async () => {
    await clearFirestore();
    await seedUsersViaFirestoreRest();
    const alexToken = await getDevToken('alex');

    await createCardViaApi(alexToken, {
      title: HIGH_SCORE_TITLE,
      priorityScore: 100,
      priorityReason: 'Baseline score that pin should outrank',
      assignedUserIds: ['user-alex'],
      awareUserIds: ['user-sam'],
    });
    await createCardViaApi(alexToken, {
      title: RECURRING_TITLE,
      priorityScore: 80,
      priorityReason: 'Repeats every two weeks',
      recurrence: { type: 'interval_after_completion', every: 14, unit: 'days' },
      assignedUserIds: ['user-alex'],
      awareUserIds: ['user-sam'],
    });
    await createCardViaApi(alexToken, {
      title: PIN_TITLE,
      priorityScore: 10,
      priorityReason: 'Should jump when pinned',
      assignedUserIds: ['user-alex'],
      awareUserIds: ['user-sam'],
    });
  });

  test('shows 5 tabs at 390x844 with no horizontal overflow', async ({ page }) => {
    await signInAsAlex(page);
    expect(await hasHorizontalOverflow(page)).toBe(false);

    const nav = page.getByRole('navigation', { name: 'Primary' });
    const navLinks = nav.getByRole('link');
    expect(await navLinks.count()).toBe(5);
    for (let index = 0; index < 5; index += 1) {
      const box = await navLinks.nth(index).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    const tabs = [
      { name: 'To-Do', heading: 'To-Do' },
      { name: 'Active', heading: 'Active' },
      { name: 'Schedule', heading: 'Schedule' },
      { name: 'Done', heading: 'Done' },
      { name: 'Settings', heading: 'Settings' },
    ] as const;

    for (const tab of tabs) {
      await nav.getByRole('link', { name: tab.name }).click();
      await expect(page.getByRole('heading', { level: 1, name: tab.heading })).toBeVisible();
      expect(await hasHorizontalOverflow(page)).toBe(false);
    }
  });

  test('moves a completed recurring card onto Schedule and wakes it back to To-Do', async ({
    page,
  }) => {
    await signInAsAlex(page);
    await expect(page.getByRole('link', { name: RECURRING_TITLE })).toBeVisible();

    await page.getByRole('link', { name: RECURRING_TITLE }).click();
    await page.getByRole('button', { name: 'Complete & Reset' }).click();
    await expect(page.getByText('Completed and reset for the next occurrence.')).toBeVisible();

    const nav = page.getByRole('navigation', { name: 'Primary' });
    await nav.getByRole('link', { name: 'To-Do' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'To-Do' })).toBeVisible();
    await expect(page.getByRole('link', { name: RECURRING_TITLE })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /snoozed in Schedule/ })).toBeVisible();

    await nav.getByRole('link', { name: 'Schedule' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Schedule' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upcoming' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByText(/Wakes in \d+d/)).toBeVisible();
    await expect(page.getByText(/Snoozed until /)).toBeVisible();
    await expect(page.getByRole('link', { name: RECURRING_TITLE }).first()).toBeVisible();

    await page.getByRole('button', { name: 'All Recurring' }).click();
    await expect(page.getByText('every 14 days')).toBeVisible();
    await expect(page.getByText(/^Last completed /)).toBeVisible();
    await expect(page.getByText(/Wakes \d+ days? before due/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Complete & Reset' })).toBeVisible();

    await page.getByRole('button', { name: 'Upcoming' }).click();
    await page.getByRole('button', { name: 'Wake now' }).click();
    await expect(page.getByText(/It is back on To-Do/)).toBeVisible();

    await nav.getByRole('link', { name: 'To-Do', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'To-Do' })).toBeVisible();
    await expect(page.locator('main').getByRole('link', { name: RECURRING_TITLE })).toBeVisible();
    await expect(page.getByRole('link', { name: /snoozed in Schedule/ })).toHaveCount(0);
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });

  test('pins a lower-scored card above a score of 100', async ({ page }) => {
    await signInAsAlex(page);
    await page.getByRole('link', { name: PIN_TITLE }).click();
    await page.getByRole('button', { name: 'Pin', exact: true }).click();
    await expect(page.getByText('Pinned to the top of To-Do.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Unpin', exact: true })).toBeVisible();

    await page
      .getByRole('navigation', { name: 'Primary' })
      .getByRole('link', { name: 'To-Do', exact: true })
      .click();
    await expect(page.getByRole('heading', { level: 1, name: 'To-Do' })).toBeVisible();
    await expect(page.getByText('Pinned', { exact: true })).toBeVisible();
    const mainText = await page.locator('main').innerText();
    expect(mainText.indexOf(PIN_TITLE)).toBeGreaterThanOrEqual(0);
    expect(mainText.indexOf(PIN_TITLE)).toBeLessThan(mainText.indexOf(HIGH_SCORE_TITLE));
  });

  test('requesting an AI rescore clears the score and shows feedback', async ({ page }) => {
    await signInAsAlex(page);
    await page.getByRole('link', { name: HIGH_SCORE_TITLE }).click();
    await expect(page.getByText('Priority 100')).toBeVisible();

    await page.getByRole('button', { name: 'Request AI Rescore' }).click();
    await expect(
      page.getByText('AI rescore requested. The priority score was cleared.'),
    ).toBeVisible();
    await expect(page.getByText('Unscored')).toBeVisible();
    await expect(page.getByText('Priority 100')).toHaveCount(0);

    await page.getByText(/Activity Log/).click();
    await expect(page.getByText('requested an AI rescore')).toBeVisible();
  });
});
