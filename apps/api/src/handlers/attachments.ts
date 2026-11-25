import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import type { Storage } from 'firebase-admin/storage';
import {
  AllowedAttachmentMimeTypeSchema,
  AttachmentSchema,
  EntityIdSchema,
  MAX_ATTACHMENT_SIZE_BYTES,
  UploadUrlRequestSchema,
  type AllowedAttachmentMimeType,
  type Attachment,
} from '@agent-kanban/shared';

type Bucket = ReturnType<Storage['bucket']>;
import { getConfig, type AppConfig } from '../config.js';
import { resolveEncryptionKey } from '../lib/crypto.js';
import { AppError, parseWithSchema } from '../lib/errors.js';
import { getDb, getDefaultBucket, getStorageBucketName } from '../lib/firebase.js';
import { buildActivityEntry, writeActivityInTransaction } from '../services/activity.js';
import type { AuthContext } from '../types/express.js';
import { assertCardVisible, nextMonotonicIso, parseStoredCard, type HandlerDeps } from './cards.js';

const UPLOAD_URL_TTL_MS = 5 * 60 * 1000;
const DOWNLOAD_URL_TTL_MS = 15 * 60 * 1000;

export interface AttachmentHandlerDeps extends HandlerDeps {
  bucket?: Bucket;
  config?: AppConfig;
  emulatorBaseUrl?: string;
}

interface EmulatorStorageTokenPayload {
  v: 1;
  action: 'read' | 'write';
  bucket: string;
  storagePath: string;
  contentType: string;
  fileName: string;
  exp: number;
}

interface PendingAttachmentDoc {
  id: string;
  cardId: string;
  storagePath: string;
  fileName: string;
  contentType: AllowedAttachmentMimeType;
  size: number;
  uploadedBy: string;
  expiresAt: string;
  createdAt: string;
}

const ALLOWED_EMULATOR_BROWSER_ORIGINS = new Set([
  'http://127.0.0.1:5050',
  'http://localhost:5050',
  'http://localhost:5173',
]);

export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  const capped = cleaned.slice(0, 120);
  return capped.length > 0 ? capped : 'file';
}

export function isStorageEmulatorTransferEnabled(
  config: Pick<AppConfig, 'isEmulator' | 'isTest'>,
): boolean {
  return (
    Boolean(process.env.FIREBASE_STORAGE_EMULATOR_HOST) && (config.isEmulator || config.isTest)
  );
}

export function resolveEmulatorApiBaseUrl(req: Request): string {
  const originHeader = req.header('origin') ?? req.header('referer');
  if (originHeader) {
    try {
      const origin = new URL(originHeader).origin;
      if (ALLOWED_EMULATOR_BROWSER_ORIGINS.has(origin)) {
        return origin;
      }
    } catch {
      // Fall through to functions emulator base URL.
    }
  }

  const functionsHost = process.env.FUNCTIONS_EMULATOR_HOST ?? '127.0.0.1:5001';
  const projectId = process.env.GCLOUD_PROJECT ?? 'demo-agent-kanban';
  return `http://${functionsHost}/${projectId}/us-central1/api`;
}

function signEmulatorStorageToken(
  payload: EmulatorStorageTokenPayload,
  config: Pick<AppConfig, 'webhookEncryptionKey' | 'isEmulator' | 'isTest'>,
): string {
  const key = resolveEncryptionKey(config);
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', key).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${sig}`;
}

function verifyEmulatorStorageToken(
  token: string,
  config: Pick<AppConfig, 'webhookEncryptionKey' | 'isEmulator' | 'isTest'>,
): EmulatorStorageTokenPayload {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AppError(403, 'INVALID_STORAGE_TOKEN', 'Invalid emulator storage token format');
  }

  const [encodedPayload, sig] = parts;
  const key = resolveEncryptionKey(config);
  const expectedSig = crypto.createHmac('sha256', key).update(encodedPayload).digest('base64url');

  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new AppError(403, 'INVALID_STORAGE_TOKEN', 'Invalid emulator storage token signature');
  }

  let parsed: EmulatorStorageTokenPayload;
  try {
    parsed = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    ) as EmulatorStorageTokenPayload;
  } catch {
    throw new AppError(403, 'INVALID_STORAGE_TOKEN', 'Malformed emulator storage token payload');
  }

  if (parsed.v !== 1 || typeof parsed.exp !== 'number' || Date.now() > parsed.exp) {
    throw new AppError(403, 'STORAGE_TOKEN_EXPIRED', 'Emulator storage token expired');
  }

  return parsed;
}

async function mintSignedTransferUrl(params: {
  action: 'read' | 'write';
  bucket: Bucket;
  storagePath: string;
  contentType: string;
  fileName: string;
  expiresAtMs: number;
  config: AppConfig;
  emulatorBaseUrl?: string;
}): Promise<string> {
  if (isStorageEmulatorTransferEnabled(params.config)) {
    const token = signEmulatorStorageToken(
      {
        v: 1,
        action: params.action,
        bucket: params.bucket.name || getStorageBucketName(),
        storagePath: params.storagePath,
        contentType: params.contentType,
        fileName: params.fileName,
        exp: params.expiresAtMs,
      },
      params.config,
    );
    const base =
      params.emulatorBaseUrl ??
      `http://${process.env.FUNCTIONS_EMULATOR_HOST ?? '127.0.0.1:5001'}/${process.env.GCLOUD_PROJECT ?? 'demo-agent-kanban'}/us-central1/api`;
    return `${base}/api/emulator/storage?token=${encodeURIComponent(token)}`;
  }

  const file = params.bucket.file(params.storagePath);
  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: params.action,
    expires: params.expiresAtMs,
    ...(params.action === 'write' ? { contentType: params.contentType } : {}),
  });
  return url;
}

function parseStoredAttachment(id: string, rawData: Record<string, unknown>): Attachment {
  const parsed = AttachmentSchema.safeParse({
    ...rawData,
    id,
  });
  if (!parsed.success) {
    throw new AppError(
      500,
      'INVALID_ATTACHMENT_RECORD',
      `Stored attachment "${id}" failed schema validation`,
    );
  }
  return parsed.data;
}

function normalizeStoredContentType(raw: unknown): string {
  if (typeof raw !== 'string') {
    return '';
  }
  return (raw.split(';')[0] ?? '').trim().toLowerCase();
}

export async function createAttachmentUploadUrlHandler(
  auth: AuthContext,
  rawCardId: unknown,
  rawInput: unknown,
  deps: AttachmentHandlerDeps = {},
): Promise<{
  attachmentId: string;
  uploadUrl: string;
  storagePath: string;
  expiresAt: string;
}> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const input = parseWithSchema(
    UploadUrlRequestSchema,
    rawInput,
    'Invalid attachment upload request',
  );
  const db = deps.db ?? getDb();
  const config = deps.config ?? getConfig();
  const bucket = deps.bucket ?? getDefaultBucket();
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();

  const cardRef = db.collection('cards').doc(cardId);
  const cardSnap = await cardRef.get();
  assertCardVisible(
    cardSnap.exists ? parseStoredCard(cardSnap.id, cardSnap.data() ?? {}) : null,
    auth.ownerUserId,
  );

  const attachmentId = `att-${crypto.randomUUID()}`;
  const sanitized = sanitizeFileName(input.fileName);
  const storagePath = `cards/${cardId}/${attachmentId}/${sanitized}`;
  const expiresAtMs = now.getTime() + UPLOAD_URL_TTL_MS;
  const expiresAt = new Date(expiresAtMs).toISOString();

  const pendingDoc: PendingAttachmentDoc = {
    id: attachmentId,
    cardId,
    storagePath,
    fileName: input.fileName,
    contentType: input.contentType,
    size: input.size,
    uploadedBy: auth.ownerUserId,
    expiresAt,
    createdAt: nowIso,
  };

  await cardRef.collection('pendingAttachments').doc(attachmentId).set(pendingDoc);

  const uploadUrl = await mintSignedTransferUrl({
    action: 'write',
    bucket,
    storagePath,
    contentType: input.contentType,
    fileName: input.fileName,
    expiresAtMs,
    config,
    emulatorBaseUrl: deps.emulatorBaseUrl,
  });

  return {
    attachmentId,
    uploadUrl,
    storagePath,
    expiresAt,
  };
}

export async function confirmAttachmentUploadHandler(
  auth: AuthContext,
  rawCardId: unknown,
  rawAttachmentId: unknown,
  deps: AttachmentHandlerDeps = {},
): Promise<{ attachment: Attachment }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const attachmentId = parseWithSchema(EntityIdSchema, rawAttachmentId, 'Invalid attachment ID');
  const db = deps.db ?? getDb();
  const bucket = deps.bucket ?? getDefaultBucket();
  const getNow = deps.now ?? (() => new Date());

  const cardRef = db.collection('cards').doc(cardId);
  const cardSnap = await cardRef.get();
  assertCardVisible(
    cardSnap.exists ? parseStoredCard(cardSnap.id, cardSnap.data() ?? {}) : null,
    auth.ownerUserId,
  );

  const confirmedRef = cardRef.collection('attachments').doc(attachmentId);
  const existingConfirmed = await confirmedRef.get();
  if (existingConfirmed.exists) {
    return {
      attachment: parseStoredAttachment(existingConfirmed.id, existingConfirmed.data() ?? {}),
    };
  }

  const pendingRef = cardRef.collection('pendingAttachments').doc(attachmentId);
  const pendingSnap = await pendingRef.get();
  if (!pendingSnap.exists) {
    throw new AppError(404, 'PENDING_ATTACHMENT_NOT_FOUND', 'Pending attachment upload not found');
  }

  const pending = pendingSnap.data() as PendingAttachmentDoc;
  const file = bucket.file(pending.storagePath);
  const [exists] = await file.exists();
  if (!exists) {
    throw new AppError(
      400,
      'ATTACHMENT_NOT_UPLOADED',
      'Uploaded object was not found in Cloud Storage',
    );
  }

  const [metadata] = await file.getMetadata();
  const rawSize = Number(metadata.size ?? 0);
  const storedMime = normalizeStoredContentType(metadata.contentType ?? pending.contentType);
  const mimeCheck = AllowedAttachmentMimeTypeSchema.safeParse(storedMime);

  if (
    !Number.isFinite(rawSize) ||
    rawSize < 1 ||
    rawSize > MAX_ATTACHMENT_SIZE_BYTES ||
    !mimeCheck.success
  ) {
    await file.delete({ ignoreNotFound: true });
    await pendingRef.delete();
    throw new AppError(
      400,
      'INVALID_UPLOADED_ATTACHMENT',
      'Uploaded attachment violates 10 MB limit or allowed MIME type rules',
    );
  }

  const attachment = await db.runTransaction(async (tx) => {
    const freshCardSnap = await tx.get(cardRef);
    const existingCard = assertCardVisible(
      freshCardSnap.exists ? parseStoredCard(freshCardSnap.id, freshCardSnap.data() ?? {}) : null,
      auth.ownerUserId,
    );

    const alreadyConfirmed = await tx.get(confirmedRef);
    if (alreadyConfirmed.exists) {
      return parseStoredAttachment(alreadyConfirmed.id, alreadyConfirmed.data() ?? {});
    }

    const nowIso = nextMonotonicIso(existingCard.lastTouchedAt, getNow());
    const createdAttachment = AttachmentSchema.parse({
      id: attachmentId,
      cardId,
      storagePath: pending.storagePath,
      fileName: pending.fileName,
      contentType: mimeCheck.data,
      size: Math.trunc(rawSize),
      uploadedBy: pending.uploadedBy,
      createdAt: nowIso,
    });

    const activity = buildActivityEntry({
      cardId: existingCard.id,
      visibleToUserIds: existingCard.visibleToUserIds,
      auth,
      action: 'card.attachment_added',
      diff: {
        attachment: {
          from: null,
          to: {
            id: createdAttachment.id,
            fileName: createdAttachment.fileName,
            contentType: createdAttachment.contentType,
            size: createdAttachment.size,
          },
        },
      },
      createdAt: nowIso,
    });

    tx.set(confirmedRef, createdAttachment);
    tx.delete(pendingRef);
    tx.update(cardRef, { lastTouchedAt: nowIso });
    writeActivityInTransaction(tx, db, activity);

    return createdAttachment;
  });

  return { attachment };
}

export async function listCardAttachmentsHandler(
  auth: AuthContext,
  rawCardId: unknown,
  deps: AttachmentHandlerDeps = {},
): Promise<{ attachments: Attachment[] }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const db = deps.db ?? getDb();

  const cardRef = db.collection('cards').doc(cardId);
  const cardSnap = await cardRef.get();
  assertCardVisible(
    cardSnap.exists ? parseStoredCard(cardSnap.id, cardSnap.data() ?? {}) : null,
    auth.ownerUserId,
  );

  const snap = await cardRef.collection('attachments').orderBy('createdAt', 'asc').get();
  const attachments = snap.docs.map((doc) => parseStoredAttachment(doc.id, doc.data()));

  return { attachments };
}

export async function getAttachmentDownloadUrlHandler(
  auth: AuthContext,
  rawCardId: unknown,
  rawAttachmentId: unknown,
  deps: AttachmentHandlerDeps = {},
): Promise<{ downloadUrl: string; expiresAt: string; attachment: Attachment }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const attachmentId = parseWithSchema(EntityIdSchema, rawAttachmentId, 'Invalid attachment ID');
  const db = deps.db ?? getDb();
  const config = deps.config ?? getConfig();
  const bucket = deps.bucket ?? getDefaultBucket();
  const now = (deps.now ?? (() => new Date()))();

  const cardRef = db.collection('cards').doc(cardId);
  const cardSnap = await cardRef.get();
  assertCardVisible(
    cardSnap.exists ? parseStoredCard(cardSnap.id, cardSnap.data() ?? {}) : null,
    auth.ownerUserId,
  );

  const attSnap = await cardRef.collection('attachments').doc(attachmentId).get();
  if (!attSnap.exists) {
    throw new AppError(404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found');
  }

  const attachment = parseStoredAttachment(attSnap.id, attSnap.data() ?? {});
  const expiresAtMs = now.getTime() + DOWNLOAD_URL_TTL_MS;
  const expiresAt = new Date(expiresAtMs).toISOString();

  const downloadUrl = await mintSignedTransferUrl({
    action: 'read',
    bucket,
    storagePath: attachment.storagePath,
    contentType: attachment.contentType,
    fileName: attachment.fileName,
    expiresAtMs,
    config,
    emulatorBaseUrl: deps.emulatorBaseUrl,
  });

  return {
    downloadUrl,
    expiresAt,
    attachment,
  };
}

export async function deleteCardAttachmentHandler(
  auth: AuthContext,
  rawCardId: unknown,
  rawAttachmentId: unknown,
  deps: AttachmentHandlerDeps = {},
): Promise<{ deleted: true; id: string }> {
  const cardId = parseWithSchema(EntityIdSchema, rawCardId, 'Invalid card ID');
  const attachmentId = parseWithSchema(EntityIdSchema, rawAttachmentId, 'Invalid attachment ID');
  const db = deps.db ?? getDb();
  const bucket = deps.bucket ?? getDefaultBucket();
  const getNow = deps.now ?? (() => new Date());

  const cardRef = db.collection('cards').doc(cardId);
  const cardSnap = await cardRef.get();
  assertCardVisible(
    cardSnap.exists ? parseStoredCard(cardSnap.id, cardSnap.data() ?? {}) : null,
    auth.ownerUserId,
  );

  const attRef = cardRef.collection('attachments').doc(attachmentId);
  const attSnap = await attRef.get();
  if (!attSnap.exists) {
    throw new AppError(404, 'ATTACHMENT_NOT_FOUND', 'Attachment not found');
  }

  const existingAttachment = parseStoredAttachment(attSnap.id, attSnap.data() ?? {});
  await bucket.file(existingAttachment.storagePath).delete({ ignoreNotFound: true });

  await db.runTransaction(async (tx) => {
    const freshCardSnap = await tx.get(cardRef);
    const existingCard = assertCardVisible(
      freshCardSnap.exists ? parseStoredCard(freshCardSnap.id, freshCardSnap.data() ?? {}) : null,
      auth.ownerUserId,
    );

    const freshAttSnap = await tx.get(attRef);
    if (!freshAttSnap.exists) {
      return;
    }

    const nowIso = nextMonotonicIso(existingCard.lastTouchedAt, getNow());
    const activity = buildActivityEntry({
      cardId: existingCard.id,
      visibleToUserIds: existingCard.visibleToUserIds,
      auth,
      action: 'card.attachment_deleted',
      diff: {
        attachment: {
          from: {
            id: existingAttachment.id,
            fileName: existingAttachment.fileName,
            contentType: existingAttachment.contentType,
            size: existingAttachment.size,
          },
          to: null,
        },
      },
      createdAt: nowIso,
    });

    tx.delete(attRef);
    tx.update(cardRef, { lastTouchedAt: nowIso });
    writeActivityInTransaction(tx, db, activity);
  });

  return { deleted: true, id: attachmentId };
}

export async function handleEmulatorStoragePut(
  req: Request,
  res: Response,
  configOverride?: AppConfig,
): Promise<void> {
  const config = configOverride ?? getConfig();
  if (!isStorageEmulatorTransferEnabled(config)) {
    throw new AppError(404, 'NOT_FOUND', 'Emulator storage transfer endpoint is disabled');
  }

  const rawToken = typeof req.query.token === 'string' ? req.query.token : '';
  const payload = verifyEmulatorStorageToken(rawToken, config);
  if (payload.action !== 'write') {
    throw new AppError(403, 'INVALID_STORAGE_TOKEN', 'Token is not authorized for write');
  }

  const rawReq = req as Request & { rawBody?: unknown };
  let bodyBuffer: Buffer;
  if (Buffer.isBuffer(req.body) && req.body.length > 0) {
    bodyBuffer = req.body;
  } else if (Buffer.isBuffer(rawReq.rawBody) && rawReq.rawBody.length > 0) {
    bodyBuffer = rawReq.rawBody;
  } else if (Buffer.isBuffer(req.body)) {
    bodyBuffer = req.body;
  } else {
    bodyBuffer = Buffer.alloc(0);
  }

  const uploadContentType =
    normalizeStoredContentType(req.header('content-type')) || payload.contentType;
  const bucket = getDefaultBucket();
  await bucket.file(payload.storagePath).save(bodyBuffer, {
    resumable: false,
    contentType: uploadContentType,
  });

  res.status(200).json({ ok: true, storagePath: payload.storagePath, size: bodyBuffer.length });
}

export async function handleEmulatorStorageGet(
  req: Request,
  res: Response,
  configOverride?: AppConfig,
): Promise<void> {
  const config = configOverride ?? getConfig();
  if (!isStorageEmulatorTransferEnabled(config)) {
    throw new AppError(404, 'NOT_FOUND', 'Emulator storage transfer endpoint is disabled');
  }

  const rawToken = typeof req.query.token === 'string' ? req.query.token : '';
  const payload = verifyEmulatorStorageToken(rawToken, config);
  if (payload.action !== 'read') {
    throw new AppError(403, 'INVALID_STORAGE_TOKEN', 'Token is not authorized for read');
  }

  const bucket = getDefaultBucket();
  const file = bucket.file(payload.storagePath);
  const [exists] = await file.exists();
  if (!exists) {
    throw new AppError(404, 'OBJECT_NOT_FOUND', 'Storage object not found');
  }

  const [bytes] = await file.download();
  res.setHeader('Content-Type', payload.contentType);
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.setHeader('Content-Disposition', `inline; filename="${sanitizeFileName(payload.fileName)}"`);
  res.status(200).send(bytes);
}
