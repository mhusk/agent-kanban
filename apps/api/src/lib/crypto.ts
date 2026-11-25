import crypto from 'node:crypto';
import { getConfig, type AppConfig } from '../config.js';
import { AppError } from './errors.js';

const KEY_BYTE_LENGTH = 32;
const IV_BYTE_LENGTH = 12;
const AUTH_TAG_BYTE_LENGTH = 16;
const ENVELOPE_VERSION = 'v1';

// Deterministic key strictly for local Firebase Emulators & Vitest tests when
// WEBHOOK_ENCRYPTION_KEY is not explicitly provided via .env.local.
const EMULATOR_FALLBACK_KEY = crypto
  .createHash('sha256')
  .update('agent-kanban-emulator-only-webhook-key-v1')
  .digest();

export type EncryptionKeyConfig = Pick<AppConfig, 'webhookEncryptionKey' | 'isEmulator' | 'isTest'>;

function decodeKeyMaterial(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  const decoded = Buffer.from(trimmed, 'base64');
  // Verify strict base64 round-trip or valid 32-byte length so arbitrary strings aren't truncated silently.
  const reEncoded = decoded.toString('base64').replace(/=+$/, '');
  const normalizedInput = trimmed.replace(/=+$/, '');
  if (decoded.length !== KEY_BYTE_LENGTH || reEncoded !== normalizedInput) {
    throw new AppError(
      500,
      'INVALID_WEBHOOK_ENCRYPTION_KEY',
      'WEBHOOK_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or 64-char hex)',
    );
  }
  return decoded;
}

/**
 * Resolves the 32-byte AES-256-GCM encryption key.
 * Fails closed in production if `WEBHOOK_ENCRYPTION_KEY` is missing.
 */
export function resolveEncryptionKey(config?: EncryptionKeyConfig): Buffer {
  const resolved = config ?? getConfig();
  if (resolved.webhookEncryptionKey !== null) {
    return decodeKeyMaterial(resolved.webhookEncryptionKey);
  }
  if (resolved.isEmulator || resolved.isTest) {
    return EMULATOR_FALLBACK_KEY;
  }
  throw new AppError(
    500,
    'WEBHOOK_ENCRYPTION_KEY_MISSING',
    'WEBHOOK_ENCRYPTION_KEY must be configured outside emulator/test mode',
  );
}

/**
 * Encrypts a plaintext webhook secret using AES-256-GCM with a fresh 12-byte random IV.
 */
export function encryptSecret(plaintext: string, config?: EncryptionKeyConfig): string {
  const key = resolveEncryptionKey(config);
  const iv = crypto.randomBytes(IV_BYTE_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    ENVELOPE_VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Decrypts a `v1:<iv>:<tag>:<ciphertext>` AES-256-GCM envelope.
 */
export function decryptSecret(encoded: string, config?: EncryptionKeyConfig): string {
  const key = resolveEncryptionKey(config);
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new AppError(500, 'INVALID_ENCRYPTED_SECRET', 'Unsupported encrypted secret envelope');
  }

  const [, ivB64, tagB64, ctB64] = parts;
  if (!ivB64 || !tagB64 || !ctB64) {
    throw new AppError(500, 'INVALID_ENCRYPTED_SECRET', 'Malformed encrypted secret components');
  }

  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const ciphertext = Buffer.from(ctB64, 'base64');

  if (iv.length !== IV_BYTE_LENGTH || authTag.length !== AUTH_TAG_BYTE_LENGTH) {
    throw new AppError(
      500,
      'INVALID_ENCRYPTED_SECRET',
      'Invalid IV or authentication tag length in encrypted secret',
    );
  }

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    throw new AppError(500, 'SECRET_DECRYPTION_FAILED', 'Unable to decrypt webhook secret');
  }
}
