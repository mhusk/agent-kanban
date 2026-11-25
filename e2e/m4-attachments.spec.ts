import zlib from 'node:zlib';
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

function buildCrc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(buildCrc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createSolidPngBuffer(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowStride = 1 + width * 3;
  const raw = Buffer.alloc(rowStride * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowStride;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const px = rowStart + 1 + x * 3;
      raw[px] = 56;
      raw[px + 1] = 189;
      raw[px + 2] = 248;
    }
  }

  const compressed = zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function seedCleanCard(): Promise<void> {
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

test.describe('M4.2 PWA Attachments: Photo compression, PDF upload & gallery', () => {
  test.beforeAll(async () => {
    await seedCleanCard();
  });

  test('uploads PNG photo and PDF to a card, renders previews after reload, serves download URL, and deletes both', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    await page.getByRole('button', { name: /Sign in as Alex \(@alex\)/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'To-Do' })).toBeVisible();

    // Create a fresh card via Quick Add
    await page.getByRole('button', { name: 'New card' }).click();
    await page.getByLabel('Title').fill('Water heater inspection');
    await page.getByRole('button', { name: 'Create card' }).click();
    await page.getByRole('link', { name: /Water heater inspection/i }).click();

    const attachmentsRegion = page.getByRole('region', { name: /Attachments/i });
    await expect(attachmentsRegion).toBeVisible();

    // 1. Upload PNG image
    const pngBytes = createSolidPngBuffer(24, 24);
    const fileInput = attachmentsRegion.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'heater-label.png',
      mimeType: 'image/png',
      buffer: pngBytes,
    });

    await expect(attachmentsRegion.getByRole('img', { name: 'heater-label.png' })).toBeVisible();

    // 2. Upload PDF
    const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n', 'utf8');
    await fileInput.setInputFiles({
      name: 'warranty.pdf',
      mimeType: 'application/pdf',
      buffer: pdfBytes,
    });

    await expect(attachmentsRegion.getByText('warranty.pdf')).toBeVisible();
    expect(await hasHorizontalOverflow(page)).toBe(false);

    // 3. Reload and confirm both persist cleanly
    await page.reload();
    const regionAfterReload = page.getByRole('region', { name: /Attachments/i });
    const imgEl = regionAfterReload.getByRole('img', { name: 'heater-label.png' });
    await expect(imgEl).toBeVisible();
    await expect(regionAfterReload.getByText('warranty.pdf')).toBeVisible();

    // Verify signed download URL serves valid image bytes (200)
    const imgSrc = await imgEl.getAttribute('src');
    expect(imgSrc).toBeTruthy();
    const imgResponse = await request.get(imgSrc!);
    expect(imgResponse.status()).toBe(200);

    // 4. Delete both attachments and verify gone across reload
    await regionAfterReload.getByRole('button', { name: 'Delete heater-label.png' }).click();
    await expect(regionAfterReload.getByRole('img', { name: 'heater-label.png' })).toHaveCount(0);

    await regionAfterReload.getByRole('button', { name: 'Delete warranty.pdf' }).click();
    await expect(regionAfterReload.getByText('warranty.pdf')).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('region', { name: /Attachments/i })).toContainText('(0)');
  });
});
