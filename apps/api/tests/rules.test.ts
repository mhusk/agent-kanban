import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, type Firestore } from 'firebase/firestore';
import { deleteObject, getBytes, ref, uploadBytes, type FirebaseStorage } from 'firebase/storage';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

const PROJECT_ID = 'demo-agent-kanban';

const PROTECTED_COLLECTIONS = [
  'users',
  'cards',
  'activity',
  'agentConnections',
  'subscriptions',
  'events',
] as const;

function parseHostPort(
  envValue: string | undefined,
  defaultHost: string,
  defaultPort: number,
): { host: string; port: number } {
  if (!envValue) {
    return { host: defaultHost, port: defaultPort };
  }
  const lastColon = envValue.lastIndexOf(':');
  if (lastColon === -1) {
    return { host: defaultHost, port: defaultPort };
  }
  const host = envValue.slice(0, lastColon);
  const port = Number.parseInt(envValue.slice(lastColon + 1), 10);
  if (!host || Number.isNaN(port)) {
    return { host: defaultHost, port: defaultPort };
  }
  return { host, port };
}

async function expectPermissionDenied(promise: Promise<unknown>): Promise<void> {
  const err = (await assertFails(promise)) as { code?: string };
  expect(err?.code).toMatch(/permission-denied|storage\/unauthorized/i);
}

describe('Firebase Security Rules (deny-all client access)', () => {
  let testEnv: RulesTestEnvironment;

  beforeAll(async () => {
    const firestoreRules = fs.readFileSync(
      path.join(REPO_ROOT, 'firebase/firestore.rules'),
      'utf8',
    );
    const storageRules = fs.readFileSync(path.join(REPO_ROOT, 'firebase/storage.rules'), 'utf8');

    const firestoreEndpoint = parseHostPort(process.env.FIRESTORE_EMULATOR_HOST, '127.0.0.1', 8080);
    const storageEndpoint = parseHostPort(
      process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? process.env.STORAGE_EMULATOR_HOST,
      '127.0.0.1',
      9199,
    );

    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: firestoreEndpoint.host,
        port: firestoreEndpoint.port,
        rules: firestoreRules,
      },
      storage: {
        host: storageEndpoint.host,
        port: storageEndpoint.port,
        rules: storageRules,
      },
    });
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await testEnv.clearStorage();
  });

  afterAll(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  describe('Firestore deny-all rules', () => {
    it.each(PROTECTED_COLLECTIONS)(
      'denies unauthenticated getDoc/setDoc/deleteDoc on %s',
      async (collectionName) => {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          const adminDb = ctx.firestore() as unknown as Firestore;
          await setDoc(doc(adminDb, collectionName, 'seed-doc'), {
            seeded: true,
          });
        });

        const unauthedDb = testEnv.unauthenticatedContext().firestore() as unknown as Firestore;
        const target = doc(unauthedDb, collectionName, 'seed-doc');

        await expectPermissionDenied(getDoc(target));
        await expectPermissionDenied(setDoc(target, { mutated: true }));
        await expectPermissionDenied(deleteDoc(target));
      },
    );

    it.each(PROTECTED_COLLECTIONS)(
      'denies authenticated client getDoc/setDoc/deleteDoc on %s',
      async (collectionName) => {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
          const adminDb = ctx.firestore() as unknown as Firestore;
          await setDoc(doc(adminDb, collectionName, 'seed-doc'), {
            seeded: true,
            ownerUserId: 'user-alex',
          });
        });

        const authedDb = testEnv
          .authenticatedContext('user-alex', { email: 'alex@example.test' })
          .firestore() as unknown as Firestore;
        const target = doc(authedDb, collectionName, 'seed-doc');

        await expectPermissionDenied(getDoc(target));
        await expectPermissionDenied(setDoc(target, { mutated: true }));
        await expectPermissionDenied(deleteDoc(target));
      },
    );

    it('denies nested card subcollections (comments, attachments) for authenticated clients', async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const adminDb = ctx.firestore() as unknown as Firestore;
        await setDoc(doc(adminDb, 'cards', 'card-1', 'comments', 'comment-1'), {
          text: 'Seeded comment',
        });
        await setDoc(doc(adminDb, 'cards', 'card-1', 'attachments', 'att-1'), {
          fileName: 'receipt.pdf',
        });
      });

      const authedDb = testEnv
        .authenticatedContext('user-alex', { email: 'alex@example.test' })
        .firestore() as unknown as Firestore;

      const commentRef = doc(authedDb, 'cards', 'card-1', 'comments', 'comment-1');
      const attachmentRef = doc(authedDb, 'cards', 'card-1', 'attachments', 'att-1');

      await expectPermissionDenied(getDoc(commentRef));
      await expectPermissionDenied(setDoc(commentRef, { text: 'Blocked' }));
      await expectPermissionDenied(deleteDoc(commentRef));

      await expectPermissionDenied(getDoc(attachmentRef));
      await expectPermissionDenied(setDoc(attachmentRef, { fileName: 'blocked.pdf' }));
      await expectPermissionDenied(deleteDoc(attachmentRef));
    });

    it('allows server-side/Admin bypass via withSecurityRulesDisabled', async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const adminDb = ctx.firestore() as unknown as Firestore;
        const cardRef = doc(adminDb, 'cards', 'admin-card');

        await assertSucceeds(
          setDoc(cardRef, {
            title: 'Admin seeded card',
            status: 'todo',
          }),
        );

        const snap = await assertSucceeds(getDoc(cardRef));
        expect(snap.exists()).toBe(true);
        expect(snap.data()?.title).toBe('Admin seeded card');

        await assertSucceeds(deleteDoc(cardRef));
        const deletedSnap = await assertSucceeds(getDoc(cardRef));
        expect(deletedSnap.exists()).toBe(false);
      });
    });
  });

  describe('Cloud Storage deny-all rules', () => {
    const sampleBytes = new TextEncoder().encode('agent-kanban attachment payload');

    it('denies unauthenticated direct uploads, downloads, and deletes', async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const adminStorage = ctx.storage() as unknown as FirebaseStorage;
        await uploadBytes(ref(adminStorage, 'attachments/card-1/existing.txt'), sampleBytes, {
          contentType: 'text/plain',
        });
      });

      const unauthedStorage = testEnv
        .unauthenticatedContext()
        .storage() as unknown as FirebaseStorage;

      await expectPermissionDenied(
        uploadBytes(ref(unauthedStorage, 'attachments/card-1/new.txt'), sampleBytes, {
          contentType: 'text/plain',
        }),
      );
      await expectPermissionDenied(
        getBytes(ref(unauthedStorage, 'attachments/card-1/existing.txt')),
      );
      await expectPermissionDenied(
        deleteObject(ref(unauthedStorage, 'attachments/card-1/existing.txt')),
      );
    });

    it('denies authenticated direct uploads, downloads, and deletes', async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const adminStorage = ctx.storage() as unknown as FirebaseStorage;
        await uploadBytes(ref(adminStorage, 'attachments/card-1/existing.txt'), sampleBytes, {
          contentType: 'text/plain',
        });
      });

      const authedStorage = testEnv
        .authenticatedContext('user-alex', { email: 'alex@example.test' })
        .storage() as unknown as FirebaseStorage;

      await expectPermissionDenied(
        uploadBytes(ref(authedStorage, 'attachments/card-1/new.txt'), sampleBytes, {
          contentType: 'text/plain',
        }),
      );
      await expectPermissionDenied(getBytes(ref(authedStorage, 'attachments/card-1/existing.txt')));
      await expectPermissionDenied(
        deleteObject(ref(authedStorage, 'attachments/card-1/existing.txt')),
      );
    });

    it('allows server-side/Admin bypass via withSecurityRulesDisabled', async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const adminStorage = ctx.storage() as unknown as FirebaseStorage;
        const objectRef = ref(adminStorage, 'attachments/card-1/admin.txt');

        await assertSucceeds(uploadBytes(objectRef, sampleBytes, { contentType: 'text/plain' }));

        const downloaded = await assertSucceeds(getBytes(objectRef));
        expect(new TextDecoder().decode(downloaded)).toBe('agent-kanban attachment payload');

        await assertSucceeds(deleteObject(objectRef));
      });
    });
  });
});
