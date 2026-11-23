import crypto, { type KeyObject } from 'node:crypto';
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

/**
 * Generates an ephemeral in-memory 2048-bit RSA keypair for local Firebase
 * Emulator and test JWT signing. Private keys are never written to disk or
 * committed to version control.
 */
export function getEmulatorKeyPair(config: AppConfig = getConfig()): EmulatorKeyPair {
  ensureEmulatorMode(config);
  if (cachedKeyPair === null) {
    const generated = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    cachedKeyPair = {
      privateKey: generated.privateKey,
      publicKey: generated.publicKey,
    };
  }
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
