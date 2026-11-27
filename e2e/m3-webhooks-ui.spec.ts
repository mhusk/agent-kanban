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

async function seedCleanHousehold(): Promise<void> {
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

test.describe('M3.4 PWA Settings: Webhook Subscriptions Panel', () => {
  test.beforeAll(async () => {
    await seedCleanHousehold();
  });

  test('lists owner webhook subscriptions, hides secrets, creates/toggles active/deletes across reload at 390x844', async ({
    page,
    request,
  }) => {
    const alexSecret = 'alex-webhook-secret-token-999999';
    const samSecret = 'sam-webhook-secret-token-888888';

    // Obtain dev tokens to pre-seed one subscription for Sam (must NOT appear for Alex)
    const samTokenRes = await request.post('/api/dev/token', {
      data: { handle: 'sam' },
    });
    expect(samTokenRes.ok()).toBe(true);
    const { token: samToken } = (await samTokenRes.json()) as { token: string };

    const samSubRes = await request.post('/api/subscriptions', {
      headers: { authorization: `Bearer ${samToken}` },
      data: {
        webhookUrl: 'https://sam-hooks.example.test/events',
        authType: 'bearer',
        secret: samSecret,
        filters: {
          eventTypes: ['card.created'],
          tags: ['private'],
        },
      },
    });
    expect(samSubRes.status()).toBe(201);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    // Sign in as Alex and open Settings
    await page.getByRole('button', { name: /Sign in as Alex \(@alex\)/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'To-Do' })).toBeVisible();
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);

    const webhooksSection = page.getByRole('region', { name: 'Webhook Subscriptions' });
    await expect(webhooksSection).toBeVisible();
    await expect(webhooksSection).not.toContainText('sam-hooks.example.test');

    // Create a filtered HMAC webhook subscription in the Settings UI
    await webhooksSection.getByRole('button', { name: 'Add webhook' }).click();
    await webhooksSection.getByLabel('Webhook URL').fill('https://alex-hooks.example.test/kanban');
    await webhooksSection.getByLabel('Signing secret').fill(alexSecret);
    await webhooksSection.getByLabel('Tags (optional, comma-separated)').fill('groceries, home');
    await webhooksSection.getByLabel('card.due_soon').check();
    await webhooksSection.getByRole('button', { name: 'Save webhook' }).click();

    await expect(webhooksSection.getByText('https://alex-hooks.example.test/kanban')).toBeVisible();
    await expect(webhooksSection.getByText('HMAC', { exact: true })).toBeVisible();
    await expect(webhooksSection.getByText('Active', { exact: true })).toBeVisible();
    await expect(webhooksSection.getByText('tag: groceries')).toBeVisible();
    await expect(webhooksSection.getByText('card.due_soon')).toBeVisible();

    // Ensure raw secret never renders in page text
    const bodyText = await page.locator('body').innerText();
    expect(bodyText).not.toContain(alexSecret);
    expect(await hasHorizontalOverflow(page)).toBe(false);

    // Pause webhook and verify Paused state persists across reload
    await webhooksSection.getByRole('button', { name: 'Pause' }).click();
    await expect(webhooksSection.getByText('Paused', { exact: true })).toBeVisible();

    await page.reload();
    await expect(
      page
        .getByRole('region', { name: 'Webhook Subscriptions' })
        .getByText('Paused', { exact: true }),
    ).toBeVisible();
    expect((await page.locator('body').innerText()).includes(alexSecret)).toBe(false);

    // Re-enable webhook -> Active
    const sectionAfterReload = page.getByRole('region', { name: 'Webhook Subscriptions' });
    await sectionAfterReload.getByRole('button', { name: 'Enable' }).click();
    await expect(sectionAfterReload.getByText('Active', { exact: true })).toBeVisible();

    // Delete webhook with inline confirmation and confirm removal across reload
    await sectionAfterReload.getByRole('button', { name: 'Delete' }).click();
    await sectionAfterReload.getByRole('button', { name: 'Confirm delete' }).click();
    await expect(
      sectionAfterReload.getByText('https://alex-hooks.example.test/kanban'),
    ).toHaveCount(0);

    await page.reload();
    await expect(
      page
        .getByRole('region', { name: 'Webhook Subscriptions' })
        .getByText('https://alex-hooks.example.test/kanban'),
    ).toHaveCount(0);

    // Create a Standard Webhooks (Grok) subscription, confirm badge + hidden secret + Refresh/lastDelivery display
    const stdSecret = 'whsec_c3RhbmRhcmQtd2ViaG9vay10ZXN0LXNlY3JldA==';
    const webhooksAfterDelete = page.getByRole('region', { name: 'Webhook Subscriptions' });
    await webhooksAfterDelete.getByRole('button', { name: 'Add webhook' }).click();
    await webhooksAfterDelete
      .getByLabel('Webhook URL')
      .fill('https://grok-hooks.example.test/automation/123');
    await webhooksAfterDelete.getByLabel('Standard Webhooks (Grok)').check();
    await webhooksAfterDelete.getByLabel('Signing secret').fill(stdSecret);
    await webhooksAfterDelete.getByRole('button', { name: 'Save webhook' }).click();

    await expect(
      webhooksAfterDelete.getByText('https://grok-hooks.example.test/automation/123'),
    ).toBeVisible();
    await expect(webhooksAfterDelete.getByText('Standard Webhooks', { exact: true })).toBeVisible();
    expect(await page.locator('body').innerText()).not.toContain(stdSecret);
    expect(await hasHorizontalOverflow(page)).toBe(false);

    // Simulate a delivery retry error in Firestore and verify manual Refresh surfaces it
    const alexTokenRes = await request.post('/api/dev/token', {
      data: { handle: 'alex' },
    });
    expect(alexTokenRes.ok()).toBe(true);
    const { token: alexToken } = (await alexTokenRes.json()) as { token: string };
    const subsRes = await request.get('/api/subscriptions', {
      headers: { authorization: `Bearer ${alexToken}` },
    });
    expect(subsRes.ok()).toBe(true);
    const subsBody = (await subsRes.json()) as { subscriptions: Array<{ id: string }> };
    const createdSubId = subsBody.subscriptions[0]?.id;
    expect(createdSubId).toBeTruthy();

    const { getApp, getApps, initializeApp } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST;
    const app = getApps().length > 0 ? getApp() : initializeApp({ projectId: PROJECT_ID });
    const db = getFirestore(app);
    await db
      .collection('subscriptions')
      .doc(createdSubId!)
      .update({
        lastDelivery: {
          status: 'pending',
          attemptCount: 1,
          lastAttemptAt: new Date().toISOString(),
          nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
          lastError: 'HTTP 400',
        },
      });

    await webhooksAfterDelete
      .getByRole('button', { name: 'Refresh webhook subscriptions' })
      .click();
    await expect(webhooksAfterDelete.getByText(/Retrying \(attempt 1\)/)).toBeVisible();
    await expect(webhooksAfterDelete.getByText(/HTTP 400/)).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);
  });
});
