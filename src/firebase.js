/**
 * @module firebase
 * @description
 * Single entry point for all Firebase services used by PMDek.
 *
 * Design decision: one module initialises Firebase exactly once and re-exports
 * the service singletons. Every other module imports from here — this means
 * Firebase is never accidentally initialised twice and swapping config is a
 * one-file change.
 *
 * All config values come from environment variables injected by Vite at
 * build time. See .env.example for required keys.
 */

import { initializeApp }                          from 'firebase/app';
import { getAuth, connectAuthEmulator }            from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator }  from 'firebase/firestore';
import { getFunctions, connectFunctionsEmulator }  from 'firebase/functions';
import { getStorage, connectStorageEmulator }      from 'firebase/storage';

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);

/** Firebase Auth instance */
export const auth      = getAuth(app);

/** Firestore database instance */
export const db        = getFirestore(app);

/** Firebase Functions instance.
 * Region is us-central1 by default; change here if you deployed to another region.
 */
export const functions = getFunctions(app, 'us-central1');

/** Firebase Storage instance */
export const storage = getStorage(app);

// ─── Emulator connections (local dev only) ────────────────────────────────────
// Emulators are opt-in so local dev can run without Java/emulator tooling.
// Set VITE_USE_FIREBASE_EMULATORS=true in .env to enable local emulator routing.
const useFirebaseEmulators =
  import.meta.env.DEV && import.meta.env.VITE_USE_FIREBASE_EMULATORS === 'true';

if (useFirebaseEmulators) {
  connectAuthEmulator(auth,           'http://localhost:9099',           { disableWarnings: true });
  connectFirestoreEmulator(db,         'localhost', 8080);
  connectFunctionsEmulator(functions,  'localhost', 5001);
  connectStorageEmulator(storage,      'localhost', 9199);
}
