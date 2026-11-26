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

async function seedHousehold(): Promise<void> {
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

test.describe('M4.3 PWA Installability, Manifest, Icons, Offline Banner & Polish', () => {
  test.beforeAll(async () => {
    await seedHousehold();
  });

  test('serves web manifest and all icons with HTTP 200, toggles offline banner, has >=44px targets and zero console/page errors', async ({
    page,
    context,
    request,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    // Verify web manifest & every referenced icon returns HTTP 200
    const manifestRes = await request.get('/manifest.webmanifest');
    expect(manifestRes.status()).toBe(200);
    const manifest = (await manifestRes.json()) as {
      name: string;
      display: string;
      icons: Array<{ src: string; sizes?: string; purpose?: string }>;
    };
    expect(manifest.name).toBe('agent-kanban');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.length).toBeGreaterThanOrEqual(3);

    for (const icon of manifest.icons) {
      const iconRes = await request.get(icon.src);
      expect(iconRes.status()).toBe(200);
    }
    const appleIconRes = await request.get('/apple-touch-icon.png');
    expect(appleIconRes.status()).toBe(200);

    // Load PWA at mobile viewport 390x844 and sign in
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await page.getByRole('button', { name: /Sign in as Alex \(@alex\)/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'To-Do' })).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);

    // Verify >= 44px tap targets on bottom nav links and FAB
    const navLinks = page.getByRole('navigation', { name: 'Primary' }).getByRole('link');
    const linkCount = await navLinks.count();
    expect(linkCount).toBe(4);
    for (let i = 0; i < linkCount; i += 1) {
      const box = await navLinks.nth(i).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }

    const fab = page.getByRole('button', { name: 'New card' });
    const fabBox = await fab.boundingBox();
    expect(fabBox?.width ?? 0).toBeGreaterThanOrEqual(44);
    expect(fabBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    // FAB SVG icon is centered inside the circular button
    const fabIconBox = await fab.locator('svg').boundingBox();
    expect(fabBox).not.toBeNull();
    expect(fabIconBox).not.toBeNull();
    if (fabBox && fabIconBox) {
      const fabCenterX = fabBox.x + fabBox.width / 2;
      const fabCenterY = fabBox.y + fabBox.height / 2;
      const iconCenterX = fabIconBox.x + fabIconBox.width / 2;
      const iconCenterY = fabIconBox.y + fabIconBox.height / 2;
      expect(Math.abs(fabCenterX - iconCenterX)).toBeLessThanOrEqual(1.5);
      expect(Math.abs(fabCenterY - iconCenterY)).toBeLessThanOrEqual(1.5);
    }

    // Styled select suppresses native arrow and reserves right padding for the chevron
    const personSelectStyles = await page
      .getByRole('combobox', { name: 'Filter by person' })
      .evaluate((el) => {
        const win = globalThis as unknown as {
          getComputedStyle: (node: unknown) => { appearance: string; paddingRight: string };
        };
        const style = win.getComputedStyle(el);
        return {
          appearance: style.appearance,
          paddingRight: parseFloat(style.paddingRight),
        };
      });
    expect(personSelectStyles.appearance).toBe('none');
    expect(personSelectStyles.paddingRight).toBeGreaterThanOrEqual(32);

    // Navigating to /callback (e.g. post-OAuth redirect) normalizes to '/' and keeps FAB visible
    await page.goto('/callback?code=test');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('button', { name: 'New card' })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'To-Do' }),
    ).toHaveAttribute('aria-current', 'page');

    // Offline banner appears when offline and hides when back online
    await expect(page.getByTestId('offline-banner')).toHaveCount(0);
    await context.setOffline(true);
    await expect(page.getByTestId('offline-banner')).toBeVisible();

    await context.setOffline(false);
    await expect(page.getByTestId('offline-banner')).toHaveCount(0);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
