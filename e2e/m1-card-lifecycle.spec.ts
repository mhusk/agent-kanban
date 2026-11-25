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

test.describe('M1.6 PWA Quick-Add (FAB + household sharing) & Card Detail Lifecycle', () => {
  test.beforeAll(async () => {
    await clearAndSeedUsers();
  });

  test('supports shared/private Quick-Add, checklists, links, comments, status changes, recurrence reset, and activity log across reloads', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    // 1. Alex creates a card via FAB with default "Share with household" ON
    await page.getByRole('button', { name: /Sign in as Alex \(@alex\)/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'To-Do' })).toBeVisible();

    await page.getByRole('button', { name: 'New card' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'New card' })).toBeVisible();

    const shareCheckbox = page.getByLabel('Share with household');
    await expect(shareCheckbox).toBeChecked();

    await page.getByLabel('Title').fill('Plan weekend hike');
    await page.getByLabel('Tags (comma-separated)').fill('outdoors');
    await page.getByRole('button', { name: 'Create card' }).click();

    await expect(page.getByText('Plan weekend hike')).toBeVisible();

    // 2. Alex creates a private card with "Share with household" OFF
    await page.getByRole('button', { name: 'New card' }).click();
    await page.getByLabel('Share with household').uncheck();
    await page.getByLabel('Title').fill('Alex secret surprise gift');
    await page.getByRole('button', { name: 'Create card' }).click();
    await expect(page.getByText('Alex secret surprise gift')).toBeVisible();

    // 3. Switch to Sam: sees shared card, does NOT see private card
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: /Sign in as Sam \(@sam\)/i }).click();
    await expect(page.getByText('Plan weekend hike')).toBeVisible();
    await expect(page.getByText('Alex secret surprise gift')).toHaveCount(0);

    // Search also does not leak private card
    await page.getByRole('searchbox', { name: 'Search cards' }).fill('surprise');
    await expect(page.getByText('No To-Do cards match your current filters.')).toBeVisible();
    await page.getByRole('button', { name: 'Clear search' }).click();

    // 4. Open shared card detail as Sam and edit description
    await page.getByRole('link', { name: /Plan weekend hike/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Plan weekend hike' })).toBeVisible();

    // Mobile overflow check on Card Detail
    expect(await hasHorizontalOverflow(page)).toBe(false);

    const main = page.locator('main');
    await main.getByLabel('Description').fill('Check trailhead parking and weather.');
    await main.getByRole('button', { name: 'Save changes' }).click();
    await expect(main.getByText('Changes saved.')).toBeVisible();

    // Add checklist + item + toggle checked
    await main.getByLabel('New checklist title').fill('Gear');
    await main.getByRole('button', { name: 'Add checklist' }).click();
    await expect(main.getByRole('heading', { name: /Gear/ })).toBeVisible();

    await main.getByLabel('Add item to Gear').fill('Pack water bottles');
    await main.getByRole('button', { name: 'Add', exact: true }).click();
    const itemCheckbox = main.getByRole('checkbox', { name: 'Pack water bottles' });
    await expect(itemCheckbox).toBeVisible();
    await itemCheckbox.check();
    await expect(itemCheckbox).toBeChecked();

    // Add link
    await main.getByLabel('Link URL').fill('https://example.test/trail-map');
    await main.getByLabel('Link label').fill('Trail map');
    await main.getByRole('button', { name: 'Add link' }).click();
    await expect(main.getByRole('link', { name: 'Trail map' })).toBeVisible();

    // Post @mention comment
    await main.getByLabel('Add a comment').fill('Hey @sam bring sunscreen');
    await main.getByRole('button', { name: 'Post comment' }).click();
    await expect(main.getByText('Hey @sam bring sunscreen')).toBeVisible();

    // Change status to Doing
    await main.getByRole('button', { name: 'Doing' }).click();
    await expect(main.getByRole('button', { name: 'Doing' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Reload page and confirm persistence
    await page.reload();
    await expect(main.getByLabel('Description')).toHaveValue(
      'Check trailhead parking and weather.',
    );
    await expect(main.getByRole('checkbox', { name: 'Pack water bottles' })).toBeChecked();
    await expect(main.getByRole('link', { name: 'Trail map' })).toBeVisible();
    await expect(main.getByText('Hey @sam bring sunscreen')).toBeVisible();
    await expect(main.getByRole('button', { name: 'Doing' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    // Configure recurrence and save
    await main.getByLabel('Recurrence').selectOption('interval_after_completion');
    await main.getByLabel('Every').fill('7');
    await main.getByLabel('Unit').selectOption('days');
    await main.getByRole('button', { name: 'Save changes' }).click();
    await expect(main.getByText('Changes saved.')).toBeVisible();

    // Complete & Reset recurring card
    const completeBtn = main.getByRole('button', { name: 'Complete & Reset' });
    await expect(completeBtn).toBeVisible();
    await completeBtn.click();
    await expect(main.getByText('Completed and reset for the next occurrence.')).toBeVisible();

    // Reload and verify reset state + preserved comment/link + Activity Log
    await page.reload();
    await expect(main.getByRole('button', { name: 'To-Do' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(main.getByRole('checkbox', { name: 'Pack water bottles' })).not.toBeChecked();
    await expect(main.getByLabel('Due date')).not.toHaveValue('');
    await expect(main.getByRole('link', { name: 'Trail map' })).toBeVisible();
    await expect(main.getByText('Hey @sam bring sunscreen')).toBeVisible();

    await main.getByText(/Activity Log \(/).click();
    await expect(main.locator('details')).toContainText('card.completed');
    await expect(main.locator('details')).toContainText('card.commented');
  });
});
