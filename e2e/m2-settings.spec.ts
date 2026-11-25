import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'demo-agent-kanban';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';

async function hasHorizontalOverflow(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const win = globalThis as unknown as {
      innerWidth: number;
      document: { documentElement: { scrollWidth: number } };
    };
    return win.document.documentElement.scrollWidth > win.innerWidth;
  });
}

async function seedUsersAndSampleCard(): Promise<void> {
  const res = await fetch(
    `http://${FIRESTORE_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    throw new Error(`Failed to clear Firestore emulator: HTTP ${res.status}`);
  }

  const { getApp, getApps, initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const { seedEmulator } = await import('../scripts/seed-emulator.js');

  process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST;
  const app = getApps().length > 0 ? getApp() : initializeApp({ projectId: PROJECT_ID });
  const db = getFirestore(app);
  await seedEmulator(db);
}

test.describe('M2.3 PWA Settings: Household Roster & Agent Connection API Keys', () => {
  test.beforeAll(async () => {
    await seedUsersAndSampleCard();
  });

  test('manages household roster, creates copy-once API key, verifies /api/workspace/snapshot access, reloads hidden, and revokes key', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    // Sign in as Alex (admin) and navigate to Settings
    await page.getByRole('button', { name: /Sign in as Alex \(@alex\)/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'To-Do' })).toBeVisible();
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);

    // Household roster lists Alex & Sam; admin adds Taylor Rivera
    await expect(page.getByText('Sam Rivera')).toBeVisible();
    await page.getByLabel('Display name').fill('Taylor Rivera');
    await page.getByLabel('Email').fill('taylor@example.test');
    await page.getByLabel('Handle').fill('taylor');
    await page.getByRole('button', { name: 'Add member' }).click();
    await expect(page.getByText('Added Taylor Rivera (@taylor).')).toBeVisible();
    await expect(page.getByText('taylor@example.test')).toBeVisible();

    // Create Automation Bot API key and capture copy-once secret
    await page.getByLabel('Platform name').fill('Automation Bot');
    await page.getByRole('button', { name: 'Create API key' }).click();

    const revealedCode = page.getByTestId('revealed-api-key');
    await expect(revealedCode).toBeVisible();
    const apiKey = (await revealedCode.innerText()).trim();
    expect(apiKey.startsWith('ak_')).toBe(true);

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(revealedCode).toHaveCount(0);

    // Use captured ak_... key directly against GET /api/workspace/snapshot -> 200
    const snapshotOk = await request.get('/api/workspace/snapshot', {
      headers: {
        authorization: `Bearer ${apiKey}`,
        'x-agent-name': 'Chief of Staff',
      },
    });
    expect(snapshotOk.status()).toBe(200);
    const snapshotBody = (await snapshotOk.json()) as {
      ownerUserId: string;
      cards: unknown[];
    };
    expect(snapshotBody.ownerUserId).toBe('user-alex');
    expect(snapshotBody.cards.length).toBeGreaterThan(0);

    // Reload Settings -> secret is hidden, Automation Bot & prefix still displayed
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    await expect(page.getByText('Automation Bot')).toBeVisible();
    const pageTextAfterReload = await page.locator('body').innerText();
    expect(pageTextAfterReload).not.toContain(apiKey);
    expect(await hasHorizontalOverflow(page)).toBe(false);

    // Revoke key -> connection marked Revoked -> snapshot returns 401
    await page.getByRole('button', { name: 'Revoke' }).click();
    await page.getByRole('button', { name: 'Confirm revoke' }).click();
    await expect(page.getByText('Revoked')).toBeVisible();

    const snapshotRevoked = await request.get('/api/workspace/snapshot', {
      headers: {
        authorization: `Bearer ${apiKey}`,
        'x-agent-name': 'Chief of Staff',
      },
    });
    expect(snapshotRevoked.status()).toBe(401);
  });
});
