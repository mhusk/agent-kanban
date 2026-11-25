import crypto, { type JsonWebKey, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { assertEmulatorAuthAllowed, getConfig, type AppConfig } from '../config.js';

export const EMULATOR_JWT_ISSUER = 'https://emulator.agent-kanban.test';
export const EMULATOR_JWT_AUDIENCE = 'agent-kanban-emulator';
export const EMULATOR_JWT_KEY_ID = 'emulator-rs256-ephemeral';

export interface EmulatorKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export interface EmulatorTokenClaims {
  sub: string;
  email: string;
  emailVerified?: boolean;
  name?: string;
  expiresIn?: string;
}

let cachedKeyPair: EmulatorKeyPair | null = null;

function ensureEmulatorMode(config: AppConfig = getConfig()): void {
  assertEmulatorAuthAllowed(config);
  if (config.authMode !== 'emulator') {
    throw new Error('Emulator auth helpers cannot be invoked unless AUTH_MODE is "emulator".');
  }
}

interface PersistedEmulatorJwkFile {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

function getEmulatorKeyFilePath(): string {
  const project = (process.env.GCLOUD_PROJECT ?? 'demo-agent-kanban').replace(
    /[^A-Za-z0-9._-]/g,
    '_',
  );
  const hostKey = (
    process.env.FIRESTORE_EMULATOR_HOST ??
    process.env.FUNCTIONS_EMULATOR_HOST ??
    'local'
  ).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(os.tmpdir(), `agent-kanban-emu-rsa-${project}-${hostKey}.json`);
}

function readKeyPairFromFile(filePath: string): EmulatorKeyPair | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PersistedEmulatorJwkFile>;
    if (!parsed.privateJwk || !parsed.publicJwk) {
      return null;
    }
    return {
      privateKey: crypto.createPrivateKey({ key: parsed.privateJwk, format: 'jwk' }),
      publicKey: crypto.createPublicKey({ key: parsed.publicJwk, format: 'jwk' }),
    };
  } catch {
    return null;
  }
}

function generateAndShareEmulatorKeyPair(filePath: string): EmulatorKeyPair {
  const generated = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const payload: PersistedEmulatorJwkFile = {
    privateJwk: generated.privateKey.export({ format: 'jwk' }),
    publicJwk: generated.publicKey.export({ format: 'jwk' }),
  };

  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload), { mode: 0o600 });
    fs.linkSync(tmpPath, filePath);
    return {
      privateKey: generated.privateKey,
      publicKey: generated.publicKey,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readKeyPairFromFile(filePath);
      if (existing !== null) {
        return existing;
      }
    }
    return {
      privateKey: generated.privateKey,
      publicKey: generated.publicKey,
    };
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors on temp staging file
    }
  }
}

/**
 * Generates an ephemeral in-memory 2048-bit RSA keypair for local Firebase
 * Emulator and test JWT signing. In Firebase Functions Emulator (`isEmulator`),
 * the runtime-generated keypair is shared across concurrent worker processes via
 * an atomic temp file in `os.tmpdir()`. Private keys are never committed to
 * version control.
 */
export function getEmulatorKeyPair(config: AppConfig = getConfig()): EmulatorKeyPair {
  ensureEmulatorMode(config);
  if (cachedKeyPair !== null) {
    return cachedKeyPair;
  }

  if (!config.isEmulator) {
    const generated = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    cachedKeyPair = {
      privateKey: generated.privateKey,
      publicKey: generated.publicKey,
    };
    return cachedKeyPair;
  }

  const keyFilePath = getEmulatorKeyFilePath();
  const existing = readKeyPairFromFile(keyFilePath);
  if (existing !== null) {
    cachedKeyPair = existing;
    return cachedKeyPair;
  }

  cachedKeyPair = generateAndShareEmulatorKeyPair(keyFilePath);
  return cachedKeyPair;
}

export function getEmulatorPublicKey(config: AppConfig = getConfig()): KeyObject {
  return getEmulatorKeyPair(config).publicKey;
}

export async function signEmulatorToken(
  claims: EmulatorTokenClaims,
  config: AppConfig = getConfig(),
): Promise<string> {
  const { privateKey } = getEmulatorKeyPair(config);
  const normalizedEmail = claims.email.trim().toLowerCase();

  const payload: JWTPayload = {
    email: normalizedEmail,
    email_verified: claims.emailVerified ?? true,
    ...(claims.name ? { name: claims.name } : {}),
  };

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: EMULATOR_JWT_KEY_ID, typ: 'JWT' })
    .setSubject(claims.sub)
    .setIssuer(EMULATOR_JWT_ISSUER)
    .setAudience(EMULATOR_JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(claims.expiresIn ?? '1h')
    .sign(privateKey);
}

export async function verifyEmulatorToken(
  token: string,
  config: AppConfig = getConfig(),
): Promise<JWTPayload> {
  const publicKey = getEmulatorPublicKey(config);
  const { payload } = await jwtVerify(token, publicKey, {
    issuer: EMULATOR_JWT_ISSUER,
    audience: EMULATOR_JWT_AUDIENCE,
    algorithms: ['RS256'],
  });
  return payload;
}

/**
 * Resets the ephemeral keypair cache (intended for unit tests only).
 */
export function resetEmulatorKeyPairForTests(): void {
  cachedKeyPair = null;
}
