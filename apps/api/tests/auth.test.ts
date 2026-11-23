import crypto from 'node:crypto';
import { getApp, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { bootstrapUser } from '../../../scripts/bootstrap-user.js';
import { SEED_USERS, seedEmulator } from '../../../scripts/seed-emulator.js';
import { EMULATOR_JWT_AUDIENCE, EMULATOR_JWT_ISSUER } from '../src/lib/emulatorAuth.js';

const PROJECT_ID = process.env.GCLOUD_PROJECT ?? 'demo-agent-kanban';
const REGION = 'us-central1';
const FUNCTIONS_HOST = process.env.FUNCTIONS_EMULATOR_HOST ?? '127.0.0.1:5001';
const FIRESTORE_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
const BASE_URL = `http://${FUNCTIONS_HOST}/${PROJECT_ID}/${REGION}/api`;

interface ApiUser {
  id: string;
  workosUserId: string | null;
  email: string;
  displayName: string;
  handle: string;
  role: 'admin' | 'member';
  createdAt: string;
}

interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

function getTestFirestore(): Firestore {
  process.env.FIRESTORE_EMULATOR_HOST = FIRESTORE_HOST;
  const app = getApps().length > 0 ? getApp() : initializeApp({ projectId: PROJECT_ID });
  return getFirestore(app);
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

async function requestDevToken(body: Record<string, unknown>): Promise<{
  status: number;
  json: { token?: string; user?: ApiUser; error?: ApiErrorBody['error'] };
}> {
  const res = await fetch(`${BASE_URL}/api/dev/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as {
    token?: string;
    user?: ApiUser;
    error?: ApiErrorBody['error'];
  };
  return { status: res.status, json };
}

describe('Auth middleware, allowlist, user endpoints & seed script (Emulator)', () => {
  let db: Firestore;

  beforeAll(async () => {
    db = getTestFirestore();
    await clearFirestoreEmulator();
    const seedResult = await seedEmulator(db);
    expect(seedResult.usersSeeded).toBe(2);
    expect(seedResult.cardsSeeded).toBe(6);
  });

  it('rejects missing, malformed, and bad-signature JWTs with 401', async () => {
    // 1. Missing Authorization header
    const missingRes = await fetch(`${BASE_URL}/api/me`);
    expect(missingRes.status).toBe(401);
    const missingBody = (await missingRes.json()) as ApiErrorBody;
    expect(missingBody.error.code).toBe('UNAUTHORIZED');

    // 2. Malformed Authorization header
    const malformedRes = await fetch(`${BASE_URL}/api/me`, {
      headers: { authorization: 'Token not-a-bearer-jwt' },
    });
    expect(malformedRes.status).toBe(401);
    const malformedBody = (await malformedRes.json()) as ApiErrorBody;
    expect(malformedBody.error.code).toBe('UNAUTHORIZED');

    // 3. Malformed JWT string
    const garbageJwtRes = await fetch(`${BASE_URL}/api/me`, {
      headers: { authorization: 'Bearer not.a.real.jwt' },
    });
    expect(garbageJwtRes.status).toBe(401);
    const garbageBody = (await garbageJwtRes.json()) as ApiErrorBody;
    expect(garbageBody.error.code).toBe('INVALID_TOKEN');

    // 4. Validly structured RS256 JWT signed by an untrusted RSA private key
    const untrustedKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const badSigToken = await new SignJWT({
      email: 'alex@example.test',
      email_verified: true,
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('workos_bad_sig')
      .setIssuer(EMULATOR_JWT_ISSUER)
      .setAudience(EMULATOR_JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(untrustedKeys.privateKey);

    const badSigRes = await fetch(`${BASE_URL}/api/me`, {
      headers: { authorization: `Bearer ${badSigToken}` },
    });
    expect(badSigRes.status).toBe(401);
    const badSigBody = (await badSigRes.json()) as ApiErrorBody;
    expect(badSigBody.error.code).toBe('INVALID_TOKEN');
  });

  it('rejects a valid JWT for a non-allowlisted email with 403 USER_NOT_ALLOWLISTED', async () => {
    const tokenRes = await requestDevToken({
      email: 'outsider@example.test',
      sub: 'workos_outsider_1',
      allowUnregistered: true,
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.json.token).toBeTruthy();

    const meRes = await fetch(`${BASE_URL}/api/me`, {
      headers: { authorization: `Bearer ${tokenRes.json.token}` },
    });
    expect(meRes.status).toBe(403);
    const meBody = (await meRes.json()) as ApiErrorBody;
    expect(meBody.error.code).toBe('USER_NOT_ALLOWLISTED');
  });

  it('links workosUserId on first login for an allowlisted user and persists it to Firestore', async () => {
    const alexBefore = await db.collection('users').doc('user-alex').get();
    expect(alexBefore.exists).toBe(true);
    expect(alexBefore.data()?.workosUserId).toBeNull();

    const expectedSub = 'workos_alex_first_login_01';
    const tokenRes = await requestDevToken({
      email: 'alex@example.test',
      sub: expectedSub,
    });
    expect(tokenRes.status).toBe(200);
    const alexToken = tokenRes.json.token as string;

    const meRes = await fetch(`${BASE_URL}/api/me`, {
      headers: { authorization: `Bearer ${alexToken}` },
    });
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as { user: ApiUser };
    expect(meBody.user.id).toBe('user-alex');
    expect(meBody.user.email).toBe('alex@example.test');
    expect(meBody.user.displayName).toBe('Alex Rivera');
    expect(meBody.user.handle).toBe('alex');
    expect(meBody.user.role).toBe('admin');
    expect(meBody.user.workosUserId).toBe(expectedSub);

    // Confirm workosUserId was persisted on users/user-alex in Firestore
    const alexAfter = await db.collection('users').doc('user-alex').get();
    expect(alexAfter.data()?.workosUserId).toBe(expectedSub);

    // Confirm a different sub claiming the same already-linked email is rejected
    const mismatchTokenRes = await requestDevToken({
      email: 'alex@example.test',
      sub: 'workos_different_identity_99',
      allowUnregistered: true,
    });
    expect(mismatchTokenRes.status).toBe(200);
    const mismatchRes = await fetch(`${BASE_URL}/api/me`, {
      headers: { authorization: `Bearer ${mismatchTokenRes.json.token}` },
    });
    expect(mismatchRes.status).toBe(403);
    const mismatchBody = (await mismatchRes.json()) as ApiErrorBody;
    expect(mismatchBody.error.code).toBe('USER_IDENTITY_MISMATCH');

    // Confirm re-running seedEmulator is idempotent and preserves linked workosUserId
    await seedEmulator(db);
    const alexAfterReseed = await db.collection('users').doc('user-alex').get();
    expect(alexAfterReseed.data()?.workosUserId).toBe(expectedSub);
    const cardsSnap = await db.collection('cards').get();
    expect(cardsSnap.size).toBe(6);
    const statuses = new Set(cardsSnap.docs.map((doc) => doc.data().status as string));
    expect(statuses).toEqual(new Set(['todo', 'doing', 'blocked', 'done']));
  });

  it('returns the household roster from GET /api/users and enforces admin role on POST /api/admin/users', async () => {
    const alexTokenRes = await requestDevToken({ handle: 'alex' });
    expect(alexTokenRes.status).toBe(200);
    const alexToken = alexTokenRes.json.token as string;

    const samTokenRes = await requestDevToken({ handle: 'sam' });
    expect(samTokenRes.status).toBe(200);
    const samToken = samTokenRes.json.token as string;

    // Both household members can read GET /api/users
    const rosterRes = await fetch(`${BASE_URL}/api/users`, {
      headers: { authorization: `Bearer ${samToken}` },
    });
    expect(rosterRes.status).toBe(200);
    const rosterBody = (await rosterRes.json()) as { users: ApiUser[] };
    expect(rosterBody.users.length).toBe(SEED_USERS.length);
    expect(rosterBody.users.map((u) => u.handle)).toEqual(['alex', 'sam']);

    // Non-admin (Sam) calling POST /api/admin/users -> 403
    const nonAdminRes = await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${samToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: 'jordan@example.test',
        displayName: 'Jordan Rivera',
        handle: 'jordan',
        role: 'member',
      }),
    });
    expect(nonAdminRes.status).toBe(403);
    const nonAdminBody = (await nonAdminRes.json()) as ApiErrorBody;
    expect(nonAdminBody.error.code).toBe('FORBIDDEN');

    // Admin (Alex) calling POST /api/admin/users -> 201
    const adminCreateRes = await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${alexToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: 'Jordan@Example.Test',
        displayName: 'Jordan Rivera',
        handle: '@Jordan',
        role: 'member',
      }),
    });
    expect(adminCreateRes.status).toBe(201);
    const createdBody = (await adminCreateRes.json()) as { user: ApiUser };
    expect(createdBody.user.email).toBe('jordan@example.test');
    expect(createdBody.user.handle).toBe('jordan');
    expect(createdBody.user.role).toBe('member');
    expect(createdBody.user.workosUserId).toBeNull();

    // Duplicate email -> 409
    const dupEmailRes = await fetch(`${BASE_URL}/api/admin/users`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${alexToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: 'jordan@example.test',
        displayName: 'Jordan Duplicate',
        handle: 'jordan2',
        role: 'member',
      }),
    });
    expect(dupEmailRes.status).toBe(409);
    expect(((await dupEmailRes.json()) as ApiErrorBody).error.code).toBe('USER_EMAIL_EXISTS');

    // Newly added user can sign in and get their profile via /api/me
    const jordanTokenRes = await requestDevToken({ email: 'jordan@example.test' });
    expect(jordanTokenRes.status).toBe(200);
    const jordanMeRes = await fetch(`${BASE_URL}/api/me`, {
      headers: { authorization: `Bearer ${jordanTokenRes.json.token}` },
    });
    expect(jordanMeRes.status).toBe(200);
    const jordanMeBody = (await jordanMeRes.json()) as { user: ApiUser };
    expect(jordanMeBody.user.id).toBe(createdBody.user.id);
    expect(jordanMeBody.user.workosUserId).toBeTruthy();
  });

  it('bootstraps a new household user idempotently via bootstrapUser helper', async () => {
    const first = await bootstrapUser(db, {
      email: 'casey@example.test',
      displayName: 'Casey Rivera',
      handle: 'casey',
      role: 'member',
      upsert: false,
    });
    expect(first.action).toBe('created');
    expect(first.user.workosUserId).toBeNull();

    const second = await bootstrapUser(db, {
      email: 'casey@example.test',
      displayName: 'Casey Rivera',
      handle: 'casey',
      role: 'member',
      upsert: false,
    });
    expect(second.action).toBe('unchanged');
    expect(second.user.id).toBe(first.user.id);
  });
});
