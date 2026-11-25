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
