import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage, type Storage } from 'firebase-admin/storage';

let firestoreInstance: Firestore | null = null;
let storageInstance: Storage | null = null;

/**
 * Lazily and idempotently initializes the default Firebase Admin App.
 * Works seamlessly in both local Firebase Emulators (via FIRESTORE_EMULATOR_HOST /
 * FIREBASE_STORAGE_EMULATOR_HOST) and Cloud Functions production (ADC).
 */
export function getFirebaseApp(): App {
  const existingDefault = getApps().find((app) => app.name === '[DEFAULT]');
  if (existingDefault) {
    return existingDefault;
  }
  return initializeApp();
}

export function getDb(): Firestore {
  if (firestoreInstance !== null) {
    return firestoreInstance;
  }
  const db = getFirestore(getFirebaseApp());
  db.settings({ ignoreUndefinedProperties: true });
  firestoreInstance = db;
  return db;
}

export function getFirebaseStorage(): Storage {
  if (storageInstance !== null) {
    return storageInstance;
  }
  storageInstance = getStorage(getFirebaseApp());
  return storageInstance;
}

export function getStorageBucketName(): string {
  const explicit = process.env.STORAGE_BUCKET?.trim();
  if (explicit) {
    return explicit.replace(/^gs:\/\//, '').replace(/\/+$/, '');
  }

  const app = getFirebaseApp();
  if (typeof app.options.storageBucket === 'string' && app.options.storageBucket.trim()) {
    return app.options.storageBucket.trim();
  }

  if (process.env.FIREBASE_CONFIG) {
    try {
      const parsed = JSON.parse(process.env.FIREBASE_CONFIG) as { storageBucket?: unknown };
      if (typeof parsed.storageBucket === 'string' && parsed.storageBucket.trim()) {
        return parsed.storageBucket.trim();
      }
    } catch {
      // Ignore malformed FIREBASE_CONFIG and fall back below.
    }
  }

  const projectId =
    (typeof app.options.projectId === 'string' && app.options.projectId) ||
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    'demo-agent-kanban';

  return `${projectId}.appspot.com`;
}

export function getDefaultBucket() {
  return getFirebaseStorage().bucket(getStorageBucketName());
}
