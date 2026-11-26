import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage, type Storage } from 'firebase-admin/storage';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_ATTACHMENT_SIZE_BYTES,
  type Activity,
  type Attachment,
  type Card,
} from '@agent-kanban/shared';
import { seedEmulator } from '../../../scripts/seed-emulator.js';
import { getStorageBucketName } from '../src/lib/firebase.js';

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'demo-agent-kanban';
const REGION = 'us-central1';
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST ?? '127.0.0.1:5001';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const BASE_URL = `http://${FUNCTIONS_HOST}/${PROJECT_ID}/${REGION}/api`;

function getTestApp() {
  process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST;
  return getApps().length > 0 ? getApp() : initializeApp({ projectId: PROJECT_ID });
}

function getTestFirestore(): Firestore {
  return getFirestore(getTestApp());
}

function getTestStorage(): Storage {
  return getStorage(getTestApp());
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
  },
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      authorization: `Bearer ${options.token}`,
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = (await res.json()) as T;
  return { status: res.status, data };
}

describe('GCS signed-URL attachment API (Emulator)', () => {
  let db: Firestore;
  let storage: Storage;
  let alexToken: string;
  let samToken: string;
  let alexPrivateCardId: string;

  beforeAll(async () => {
    db = getTestFirestore();
    storage = getTestStorage();
    await clearFirestoreEmulator();
    await seedEmulator(db);
    alexToken = await getAuthToken('alex');
    samToken = await getAuthToken('sam');

    const created = await apiRequest<{ card: Card }>('/api/cards', {
      method: 'POST',
      token: alexToken,
      body: {
        title: 'Alex attachment card',
        assignedUserIds: ['user-alex'],
        awareUserIds: [],
      },
    });
    expect(created.status).toBe(201);
    alexPrivateCardId = created.data.card.id;
  });

  it('rejects >10 MB, disallowed MIME types, tampered uploads, and unauthorized users (404)', async () => {
    const oversizeRes = await apiRequest(`/api/cards/${alexPrivateCardId}/attachments/upload-url`, {
      method: 'POST',
      token: alexToken,
      body: {
        fileName: 'too-big.jpg',
        contentType: 'image/jpeg',
        size: MAX_ATTACHMENT_SIZE_BYTES + 1,
      },
    });
    expect(oversizeRes.status).toBe(400);

    const badMimeRes = await apiRequest(`/api/cards/${alexPrivateCardId}/attachments/upload-url`, {
      method: 'POST',
      token: alexToken,
      body: {
        fileName: 'script.html',
        contentType: 'text/html',
        size: 128,
      },
    });
    expect(badMimeRes.status).toBe(400);

    // Unauthorized user gets 404 across all attachment endpoints
    const samUploadUrl = await apiRequest(
      `/api/cards/${alexPrivateCardId}/attachments/upload-url`,
      {
        method: 'POST',
        token: samToken,
        body: {
          fileName: 'photo.png',
          contentType: 'image/png',
          size: 64,
        },
      },
    );
    expect(samUploadUrl.status).toBe(404);

    const samList = await apiRequest(`/api/cards/${alexPrivateCardId}/attachments`, {
      token: samToken,
    });
    expect(samList.status).toBe(404);

    // Request upload URL for image/png, but PUT disallowed text/html -> confirm rejects 400 and cleans up object
    const uploadReq = await apiRequest<{
      attachmentId: string;
      uploadUrl: string;
      storagePath: string;
    }>(`/api/cards/${alexPrivateCardId}/attachments/upload-url`, {
      method: 'POST',
      token: alexToken,
      body: {
        fileName: 'spoofed.png',
        contentType: 'image/png',
        size: 32,
      },
    });
    expect(uploadReq.status).toBe(201);

    const putBadRes = await fetch(uploadReq.data.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: Buffer.from('<html>not a png</html>'),
    });
    expect(putBadRes.status).toBe(200);

    const badConfirmRes = await apiRequest(
      `/api/cards/${alexPrivateCardId}/attachments/${uploadReq.data.attachmentId}/confirm`,
      {
        method: 'POST',
        token: alexToken,
        body: {},
      },
    );
    expect(badConfirmRes.status).toBe(400);

    const bucket = storage.bucket(getStorageBucketName());
    const [existsAfterReject] = await bucket.file(uploadReq.data.storagePath).exists();
    expect(existsAfterReject).toBe(false);
  });

  it('completes upload -> confirm -> list -> download -> verify bytes -> delete for PNG and PDF', async () => {
    const pngBytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
      0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ]);
    const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n', 'utf8');

    const uploadAndVerify = async (fileName: string, contentType: string, payload: Buffer) => {
      const urlRes = await apiRequest<{
        attachmentId: string;
        uploadUrl: string;
        storagePath: string;
      }>(`/api/cards/${alexPrivateCardId}/attachments/upload-url`, {
        method: 'POST',
        token: alexToken,
        body: {
          fileName,
          contentType,
          size: payload.length,
        },
      });
      expect(urlRes.status).toBe(201);
      expect(urlRes.data.storagePath).toBe(
        `cards/${alexPrivateCardId}/${urlRes.data.attachmentId}/${fileName}`,
      );

      const putRes = await fetch(urlRes.data.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body: new Uint8Array(payload),
      });
      expect(putRes.status).toBe(200);

      const confirmRes = await apiRequest<{ attachment: Attachment }>(
        `/api/cards/${alexPrivateCardId}/attachments/${urlRes.data.attachmentId}/confirm`,
        {
          method: 'POST',
          token: alexToken,
          body: {},
        },
      );
      expect(confirmRes.status).toBe(201);
      expect(confirmRes.data.attachment.id).toBe(urlRes.data.attachmentId);
      expect(confirmRes.data.attachment.contentType).toBe(contentType);
      expect(confirmRes.data.attachment.size).toBe(payload.length);

      // Download URL returns matching bytes
      const downloadUrlRes = await apiRequest<{ downloadUrl: string; attachment: Attachment }>(
        `/api/cards/${alexPrivateCardId}/attachments/${urlRes.data.attachmentId}/download-url`,
        { token: alexToken },
      );
      expect(downloadUrlRes.status).toBe(200);

      const downloadedRes = await fetch(downloadUrlRes.data.downloadUrl);
      expect(downloadedRes.status).toBe(200);
      expect(downloadedRes.headers.get('content-type')).toContain(contentType);
      const downloadedBuf = Buffer.from(await downloadedRes.arrayBuffer());
      expect(downloadedBuf.equals(payload)).toBe(true);

      // Unauthorized user gets 404 on download-url and delete
      const samDownload = await apiRequest(
        `/api/cards/${alexPrivateCardId}/attachments/${urlRes.data.attachmentId}/download-url`,
        { token: samToken },
      );
      expect(samDownload.status).toBe(404);

      const samDelete = await apiRequest(
        `/api/cards/${alexPrivateCardId}/attachments/${urlRes.data.attachmentId}`,
        { method: 'DELETE', token: samToken },
      );
      expect(samDelete.status).toBe(404);

      return urlRes.data;
    };

    const uploadedPng = await uploadAndVerify('receipt.png', 'image/png', pngBytes);
    const uploadedPdf = await uploadAndVerify('manual.pdf', 'application/pdf', pdfBytes);

    // Rename PNG attachment and verify persistence, auth isolation, validation, and activity log
    const samRename = await apiRequest(
      `/api/cards/${alexPrivateCardId}/attachments/${uploadedPng.attachmentId}`,
      {
        method: 'PATCH',
        token: samToken,
        body: { fileName: 'hacked.png' },
      },
    );
    expect(samRename.status).toBe(404);

    const invalidRename = await apiRequest(
      `/api/cards/${alexPrivateCardId}/attachments/${uploadedPng.attachmentId}`,
      {
        method: 'PATCH',
        token: alexToken,
        body: { fileName: '   ' },
      },
    );
    expect(invalidRename.status).toBe(400);

    const renameRes = await apiRequest<{ attachment: Attachment }>(
      `/api/cards/${alexPrivateCardId}/attachments/${uploadedPng.attachmentId}`,
      {
        method: 'PATCH',
        token: alexToken,
        body: { fileName: 'kitchen-receipt.png' },
      },
    );
    expect(renameRes.status).toBe(200);
    expect(renameRes.data.attachment.fileName).toBe('kitchen-receipt.png');

    const listRes = await apiRequest<{ attachments: Attachment[] }>(
      `/api/cards/${alexPrivateCardId}/attachments`,
      { token: alexToken },
    );
    expect(listRes.status).toBe(200);
    expect(listRes.data.attachments.map((a) => a.id)).toEqual([
      uploadedPng.attachmentId,
      uploadedPdf.attachmentId,
    ]);
    expect(listRes.data.attachments[0]?.fileName).toBe('kitchen-receipt.png');

    // Delete both attachments and verify Storage objects and Firestore records are removed
    for (const item of [uploadedPng, uploadedPdf]) {
      const delRes = await apiRequest<{ deleted: boolean; id: string }>(
        `/api/cards/${alexPrivateCardId}/attachments/${item.attachmentId}`,
        { method: 'DELETE', token: alexToken },
      );
      expect(delRes.status).toBe(200);
      expect(delRes.data).toEqual({ deleted: true, id: item.attachmentId });

      const bucket = storage.bucket(getStorageBucketName());
      const [existsAfterDelete] = await bucket.file(item.storagePath).exists();
      expect(existsAfterDelete).toBe(false);
    }

    const listAfterDelete = await apiRequest<{ attachments: Attachment[] }>(
      `/api/cards/${alexPrivateCardId}/attachments`,
      { token: alexToken },
    );
    expect(listAfterDelete.status).toBe(200);
    expect(listAfterDelete.data.attachments).toHaveLength(0);

    const actRes = await apiRequest<{ activity: Activity[] }>(
      `/api/cards/${alexPrivateCardId}/activity`,
      { token: alexToken },
    );
    expect(actRes.status).toBe(200);
    const actions = actRes.data.activity.map((a) => a.action);
    expect(actions).toContain('card.attachment_added');
    expect(actions).toContain('card.attachment_renamed');
    expect(actions).toContain('card.attachment_deleted');
  });
});
