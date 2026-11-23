import { expect, test } from '@playwright/test';

test.describe('M0.6 PWA shell, Hosting rewrites & Dev User Switcher', () => {
  test('serves PWA manifest and service worker from Firebase Hosting', async ({ request }) => {
    const manifestRes = await request.get('/manifest.webmanifest');
    expect(manifestRes.status()).toBe(200);
    const manifest = (await manifestRes.json()) as {
      name: string;
      short_name: string;
      display: string;
      start_url: string;
    };
    expect(manifest.name).toBe('agent-kanban');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');

    const swRes = await request.get('/sw.js');
    expect(swRes.status()).toBe(200);
    const swBody = await swRes.text();
    expect(swBody.length).toBeGreaterThan(0);

    // Hosting rewrite routes /api/** directly to the Cloud Function
    const healthRes = await request.get('/api/health');
    expect(healthRes.status()).toBe(200);
    const health = (await healthRes.json()) as { ok: boolean; service: string };
    expect(health.ok).toBe(true);
    expect(health.service).toBe('agent-kanban');
  });

  test('signs in as Alex, signs out, signs in as Sam, and shows 403 for unallowlisted accounts', async ({
    page,
  }) => {
    await page.goto('/');

    // Unauthenticated sign-in screen with Dev User Switcher
    await expect(page.getByRole('heading', { name: 'agent-kanban' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Dev User Switcher' })).toBeVisible();
    const alexBtn = page.getByRole('button', { name: /Sign in as Alex \(@alex\)/i });
    const samBtn = page.getByRole('button', { name: /Sign in as Sam \(@sam\)/i });
    await expect(alexBtn).toBeVisible();
    await expect(samBtn).toBeVisible();

    // Sign in as Alex via Dev User Switcher -> verifies /api/me renders "Alex Rivera"
    await alexBtn.click();
    await expect(page.getByRole('heading', { level: 1, name: 'To-Do' })).toBeVisible();
    await expect(page.locator('header')).toContainText('Alex Rivera (@alex)');
    await expect(page.locator('main')).toContainText('Alex Rivera');
    await expect(page.locator('main')).toContainText('alex@example.test');

    // Bottom nav switches routes cleanly through SPA fallback
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

    // Sign out -> returns to sign-in screen
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Dev User Switcher' })).toBeVisible();

    // Sign in as Sam -> verifies /api/me renders "Sam Rivera"
    await samBtn.click();
    await expect(page.locator('header')).toContainText('Sam Rivera (@sam)');
    await expect(page.locator('main')).toContainText('Sam Rivera');
    await expect(page.locator('main')).toContainText('sam@example.test');

    // Sign out and test unallowlisted account -> verifies friendly 403 screen
    await page.getByRole('button', { name: 'Sign out' }).click();
    await page.getByRole('button', { name: /Test unallowlisted account \(403\)/i }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Household access required' }),
    ).toBeVisible();
    await expect(page.locator('main')).toContainText('outsider@example.test');

    // Can sign out from 403 screen back to Dev User Switcher
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Dev User Switcher' })).toBeVisible();
  });
});
