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

async function clearAndSeedUsers(): Promise<void> {
  const res = await fetch(
    `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    throw new Error(`Failed to clear Firestore emulator: HTTP ${res.status}`);
  }

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

async function openQuickAdd(page: Page) {
  await page.getByRole('button', { name: 'New card' }).click();
  const dialog = page.getByRole('dialog', { name: 'New card' });
  await expect(dialog.getByRole('heading', { name: 'New card' })).toBeVisible();
  return dialog;
}

test.describe('M5.2 shared tags, TagPicker, and Settings tag manager', () => {
  test.beforeAll(async () => {
    await clearAndSeedUsers();
  });

  test('reuses #groceries from TagPicker and merges it from Settings without horizontal overflow', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: /Sign in as Alex \(@alex\)/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'To-Do' })).toBeVisible();

    const firstCard = await openQuickAdd(page);
    await firstCard.getByLabel('Title').fill('Buy oat milk');
    const firstTags = firstCard.getByRole('combobox', { name: 'Tags' });
    await firstTags.fill('groceries');
    await firstTags.press('Enter');
    await expect(firstCard.getByRole('button', { name: 'Remove tag groceries' })).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);
    await firstCard.getByRole('button', { name: 'Create card' }).click();
    await expect(firstCard).toBeHidden();
    await expect(page.getByRole('link', { name: /Buy oat milk/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '#groceries' })).toBeVisible();

    const secondCard = await openQuickAdd(page);
    await secondCard.getByLabel('Title').fill('Buy bread');
    const secondTags = secondCard.getByRole('combobox', { name: 'Tags' });
    await secondTags.fill('gro');
    await expect(secondCard.getByRole('option', { name: /groceries/i })).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);
    await secondTags.press('ArrowDown');
    await secondTags.press('Enter');
    await expect(secondCard.getByRole('button', { name: 'Remove tag groceries' })).toBeVisible();
    await secondCard.getByRole('button', { name: 'Create card' }).click();
    await expect(secondCard).toBeHidden();
    await expect(page.getByRole('link', { name: /Buy bread/ })).toBeVisible();

    const thirdCard = await openQuickAdd(page);
    await thirdCard.getByLabel('Title').fill('Pack pantry');
    await thirdCard.getByRole('button', { name: 'Create card' }).click();
    await expect(thirdCard).toBeHidden();
    await page.getByRole('link', { name: /Pack pantry/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Pack pantry' })).toBeVisible();

    const detailTags = page.locator('main').getByRole('combobox', { name: 'Tags' });
    await detailTags.fill('gro');
    const detailSuggestion = page.locator('main').getByRole('option', { name: /groceries/i });
    await expect(detailSuggestion).toBeVisible();
    await detailSuggestion.click();
    await expect(page.getByRole('button', { name: 'Remove tag groceries' })).toBeVisible();
    await page.locator('main').getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('main').getByText('Changes saved.')).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);

    await page.getByRole('link', { name: 'To-Do' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'To-Do' })).toBeVisible();

    const fourthCard = await openQuickAdd(page);
    await fourthCard.getByLabel('Title').fill('Restock snacks');
    const fourthTags = fourthCard.getByRole('combobox', { name: 'Tags' });
    await fourthTags.fill('shopping');
    await fourthTags.press('Enter');
    await expect(fourthCard.getByRole('button', { name: 'Remove tag shopping' })).toBeVisible();
    await fourthCard.getByRole('button', { name: 'Create card' }).click();
    await expect(fourthCard).toBeHidden();
    await expect(page.getByRole('link', { name: /Restock snacks/ })).toBeVisible();

    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Tags' })).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);

    const groceriesRow = page.getByRole('listitem').filter({ hasText: '#groceries' });
    await expect(groceriesRow).toContainText('3 open');
    await expect(groceriesRow).toContainText('3 total');
    await groceriesRow.getByRole('button', { name: 'Rename / Merge' }).click();
    await page.getByLabel('New tag name').fill('shopping');
    await page.getByRole('button', { name: 'Confirm rename' }).click();
    await expect(page.getByRole('status')).toContainText(
      'Merged #groceries into #shopping on 3 cards.',
    );
    await expect(page.getByRole('listitem').filter({ hasText: '#groceries' })).toHaveCount(0);
    const shoppingRow = page.getByRole('listitem').filter({ hasText: '#shopping' });
    await expect(shoppingRow).toContainText('4 open');
    await expect(shoppingRow).toContainText('4 total');
    expect(await hasHorizontalOverflow(page)).toBe(false);

    await page.getByRole('link', { name: 'To-Do' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'To-Do' })).toBeVisible();
    await expect(page.getByRole('button', { name: '#groceries' })).toHaveCount(0);
    await page.getByRole('button', { name: '#shopping' }).click();
    for (const title of ['Buy oat milk', 'Buy bread', 'Pack pantry', 'Restock snacks']) {
      await expect(page.getByRole('link', { name: new RegExp(title) })).toBeVisible();
    }
    expect(await hasHorizontalOverflow(page)).toBe(false);

    await page.getByRole('link', { name: /Buy oat milk/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Buy oat milk' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove tag shopping' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove tag groceries' })).toHaveCount(0);
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });
});
