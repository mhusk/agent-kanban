import crypto from 'node:crypto';
import { Timestamp, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { AppError } from '../lib/errors.js';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

interface StoredIdempotencyRecord<TBody> {
  scope: string;
  ownerUserId: string;
  key: string;
  status: number;
  body: TBody;
  createdAt: string;
  expiresAt: string;
  expiresAtTimestamp: Timestamp;
}

/**
 * Validates and trims an optional `Idempotency-Key` header.
 * Returns `undefined` if the header was not provided.
 */
export function normalizeIdempotencyKey(rawHeader: string | undefined): string | undefined {
  if (rawHeader === undefined) {
    return undefined;
  }

  const trimmed = rawHeader.trim();
  if (trimmed.length === 0) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Idempotency-Key header cannot be empty');
  }
  if (trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      `Idempotency-Key header exceeds ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
    );
  }

  return trimmed;
}

/**
 * Produces a deterministic, Firestore-safe document ID scoped to `(scope, ownerUserId, key)`.
 */
export function buildIdempotencyDocId(scope: string, ownerUserId: string, key: string): string {
  const safeScope = scope.replace(/[^A-Za-z0-9._-]/g, '_');
  const digest = crypto.createHash('sha256').update(`${ownerUserId}:${key}`).digest('hex');
  return `${safeScope}_${digest}`;
}

export interface RunIdempotentTransactionOptions<TBody> {
  scope: string;
  ownerUserId: string;
  idempotencyKey?: string;
  now?: Date;
  execute: (tx: Transaction) => Promise<{ status: number; body: TBody }>;
}

export interface IdempotentTransactionResult<TBody> {
  status: number;
  body: TBody;
  replayed: boolean;
}

/**
 * Executes a Firestore transaction with optional `Idempotency-Key` deduplication.
 * When `idempotencyKey` is provided, reads `idempotencyKeys/{docId}` first inside the
 * transaction; unexpired entries replay the stored response without running `execute`.
 */
export async function runIdempotentTransaction<TBody>(
  db: Firestore,
  options: RunIdempotentTransactionOptions<TBody>,
): Promise<IdempotentTransactionResult<TBody>> {
  const { scope, ownerUserId, idempotencyKey, execute } = options;

  if (idempotencyKey === undefined) {
    const result = await db.runTransaction(execute);
    return {
      ...result,
      replayed: false,
    };
  }

  const now = options.now ?? new Date();
  const docId = buildIdempotencyDocId(scope, ownerUserId, idempotencyKey);
  const keyRef = db.collection('idempotencyKeys').doc(docId);

  return db.runTransaction(async (tx) => {
    const existingSnap = await tx.get(keyRef);
    if (existingSnap.exists) {
      const existingData = existingSnap.data() as
        Partial<StoredIdempotencyRecord<TBody>> | undefined;
      const expiresAtMs =
        typeof existingData?.expiresAt === 'string'
          ? Date.parse(existingData.expiresAt)
          : Number.NaN;
      if (
        existingData &&
        typeof existingData.status === 'number' &&
        existingData.body !== undefined &&
        Number.isFinite(expiresAtMs) &&
        expiresAtMs > now.getTime()
      ) {
        return {
          status: existingData.status,
          body: existingData.body,
          replayed: true,
        };
      }
    }

    const result = await execute(tx);
    const expiresDate = new Date(now.getTime() + IDEMPOTENCY_TTL_MS);
    const record: StoredIdempotencyRecord<TBody> = {
      scope,
      ownerUserId,
      key: idempotencyKey,
      status: result.status,
      body: result.body,
      createdAt: now.toISOString(),
      expiresAt: expiresDate.toISOString(),
      expiresAtTimestamp: Timestamp.fromDate(expiresDate),
    };

    tx.set(keyRef, record);

    return {
      ...result,
      replayed: false,
    };
  });
}
