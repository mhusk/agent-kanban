import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { assertEmulatorAuthAllowed, readConfig, type AppConfig } from '../config.js';
import {
  EMULATOR_JWT_AUDIENCE,
  EMULATOR_JWT_ISSUER,
  resetEmulatorKeyPairForTests,
  signEmulatorToken,
  verifyEmulatorToken,
} from '../lib/emulatorAuth.js';
import { AppError } from '../lib/errors.js';
import { createAuthMiddleware, extractBearerToken, verifyJwt } from '../middleware/auth.js';

const TEST_EMULATOR_CONFIG: AppConfig = readConfig({
  AUTH_MODE: 'emulator',
  NODE_ENV: 'test',
});

describe('Auth safety guard & config defaults', () => {
  it('assertEmulatorAuthAllowed throws when FUNCTIONS_EMULATOR is unset and NODE_ENV=production', () => {
    expect(() =>
      readConfig({
        AUTH_MODE: 'emulator',
        NODE_ENV: 'production',
      }),
    ).toThrow(/AUTH_MODE=emulator is strictly prohibited/);

    expect(() =>
      assertEmulatorAuthAllowed({
        authMode: 'emulator',
        isEmulator: false,
        isTest: false,
      }),
    ).toThrow(/AUTH_MODE=emulator is strictly prohibited/);
  });

  it('defaults to emulator auth mode inside Firebase Functions Emulator when WorkOS JWKS is unset', () => {
    const config = readConfig({
      FUNCTIONS_EMULATOR: 'true',
    });
    expect(config.authMode).toBe('emulator');
    expect(config.isEmulator).toBe(true);
  });

  it('keeps workos auth mode inside Functions Emulator when WORKOS_JWKS_URL is provided', () => {
    const config = readConfig({
      FUNCTIONS_EMULATOR: 'true',
      WORKOS_JWKS_URL: 'https://api.workos.com/sso/jwks/client_example_placeholder',
    });
    expect(config.authMode).toBe('workos');
  });

  it('createAuthMiddleware refuses to initialize if AUTH_MODE=emulator outside emulator/test', () => {
    const unsafeConfig: AppConfig = {
      ...TEST_EMULATOR_CONFIG,
      authMode: 'emulator',
      isEmulator: false,
      isTest: false,
    };

    expect(() =>
      createAuthMiddleware({
        getConfigFn: () => unsafeConfig,
      }),
    ).toThrow(/AUTH_MODE=emulator is strictly prohibited/);
  });
});

describe('extractBearerToken', () => {
  it('extracts valid bearer tokens case-insensitively', () => {
    expect(extractBearerToken('Bearer header.payload.sig')).toBe('header.payload.sig');
    expect(extractBearerToken('bearer abc123')).toBe('abc123');
  });

  it('throws 401 AppError for missing or malformed headers', () => {
    for (const bad of [undefined, '', 'Basic dXNlcjpwYXNz', 'Bearer', 'Bearer ', 'Bearer a b']) {
      try {
        extractBearerToken(bad);
        expect.fail(`Expected extractBearerToken(${String(bad)}) to throw`);
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).statusCode).toBe(401);
      }
    }
  });
});

describe('Emulator RSA JWT signing & verification', () => {
  it('signs and verifies RS256 tokens using the runtime keypair', async () => {
    const token = await signEmulatorToken(
      {
        sub: 'workos_test_1',
        email: 'Alex@Example.Test',
        name: 'Alex Rivera',
      },
      TEST_EMULATOR_CONFIG,
    );

    const payload = await verifyEmulatorToken(token, TEST_EMULATOR_CONFIG);
    expect(payload.sub).toBe('workos_test_1');
    expect(payload.email).toBe('alex@example.test');
    expect(payload.email_verified).toBe(true);
    expect(payload.iss).toBe(EMULATOR_JWT_ISSUER);
    expect(payload.aud).toBe(EMULATOR_JWT_AUDIENCE);

    const identity = await verifyJwt(token, TEST_EMULATOR_CONFIG);
    expect(identity).toEqual({
      workosUserId: 'workos_test_1',
      email: 'alex@example.test',
      emailVerified: true,
    });
  });

  it('rejects JWTs signed by an untrusted RSA key with 401', async () => {
    const rogueKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forgedToken = await new SignJWT({
      email: 'alex@example.test',
      email_verified: true,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('workos_forged')
      .setIssuer(EMULATOR_JWT_ISSUER)
      .setAudience(EMULATOR_JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(rogueKeys.privateKey);

    await expect(verifyJwt(forgedToken, TEST_EMULATOR_CONFIG)).rejects.toMatchObject({
      statusCode: 401,
      code: 'INVALID_TOKEN',
    });
  });

  it('rejects expired JWTs with 401', async () => {
    const expiredToken = await signEmulatorToken(
      {
        sub: 'workos_expired',
        email: 'alex@example.test',
        expiresIn: '-5s',
      },
      TEST_EMULATOR_CONFIG,
    );

    await expect(verifyJwt(expiredToken, TEST_EMULATOR_CONFIG)).rejects.toMatchObject({
      statusCode: 401,
      code: 'INVALID_TOKEN',
    });
  });

  it('shares the runtime-generated keypair across emulator workers via os.tmpdir()', async () => {
    const prevHost = process.env.FIRESTORE_EMULATOR_HOST;
    const prevProject = process.env.GCLOUD_PROJECT;
    const uniqueHost = `127.0.0.1:unit-${crypto.randomUUID()}`;
    process.env.FIRESTORE_EMULATOR_HOST = uniqueHost;
    process.env.GCLOUD_PROJECT = 'demo-agent-kanban';

    const expectedFile = path.join(
      os.tmpdir(),
      `agent-kanban-emu-rsa-demo-agent-kanban-${uniqueHost.replace(/[^A-Za-z0-9._-]/g, '_')}.json`,
    );

    const emuConfig = readConfig({
      FUNCTIONS_EMULATOR: 'true',
      AUTH_MODE: 'emulator',
    });

    try {
      resetEmulatorKeyPairForTests();
      const token = await signEmulatorToken(
        {
          sub: 'workos_worker_1',
          email: 'sam@example.test',
        },
        emuConfig,
      );

      // Simulate a second worker process with an empty in-memory key cache
      resetEmulatorKeyPairForTests();
      const verified = await verifyEmulatorToken(token, emuConfig);
      expect(verified.sub).toBe('workos_worker_1');
      expect(verified.email).toBe('sam@example.test');
    } finally {
      resetEmulatorKeyPairForTests();
      if (prevHost === undefined) {
        delete process.env.FIRESTORE_EMULATOR_HOST;
      } else {
        process.env.FIRESTORE_EMULATOR_HOST = prevHost;
      }
      if (prevProject === undefined) {
        delete process.env.GCLOUD_PROJECT;
      } else {
        process.env.GCLOUD_PROJECT = prevProject;
      }
      try {
        fs.unlinkSync(expectedFile);
      } catch {
        // Ignore if file was not created
      }
    }
  });
});
