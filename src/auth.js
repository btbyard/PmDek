/**
 * @module auth
 * @description
 * Handles Firebase Authentication for PMDecks.
 *
 * Supports:
 *  - Google sign-in (popup)
 *  - GitHub sign-in (popup)
 *  - Email + password sign-in and registration
 *  - Sign-out
 *  - Auth state observation (drives the whole app lifecycle)
 *
 * Design decision: auth state is the single source of truth for whether the
 * board is rendered. `onAuthStateChanged` is the entry point — main.js calls
 * `initAuth` once then reacts to the emitted user/null.
 */

import {
  GoogleAuthProvider,
  GithubAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
  deleteUser,
  reauthenticateWithPopup,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from 'firebase/auth';

import { auth } from './firebase.js';

// ─── Providers ───────────────────────────────────────────────────────────────

const googleProvider = new GoogleAuthProvider();
const githubProvider = new GithubAuthProvider();

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Sign in with Google via popup.
 * @returns {Promise<import('firebase/auth').UserCredential>}
 */
export function signInWithGoogle() {
  return signInWithPopup(auth, googleProvider);
}

/**
 * Sign in with GitHub via popup.
 * @returns {Promise<import('firebase/auth').UserCredential>}
 */
export function signInWithGitHub() {
  return signInWithPopup(auth, githubProvider);
}

/**
 * Sign in an existing user with email + password.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<import('firebase/auth').UserCredential>}
 */
export function signInWithEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

/**
 * Create a new account with email + password.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<import('firebase/auth').UserCredential>}
 */
export function registerWithEmail(email, password) {
  return createUserWithEmailAndPassword(auth, email, password);
}

/**
 * Send a password reset email.
 * @param {string} email
 * @returns {Promise<void>}
 */
export function resetPassword(email) {
  return sendPasswordResetEmail(auth, email);
}

/**
 * Sign out the currently authenticated user.
 * @returns {Promise<void>}
 */
export function signOutUser() {
  return signOut(auth);
}

/**
 * Re-authenticates then permanently deletes the current Firebase Auth account.
 * The caller is responsible for deleting Firestore content first.
 *
 * For Google/GitHub users this triggers a popup re-auth.
 * For email users the caller must supply the password.
 *
 * @param {string|null} [emailPassword]  Email user's password (required for email accounts)
 * @returns {Promise<void>}
 */
export async function deleteAccount(emailPassword = null) {
  const user = auth.currentUser;
  if (!user) throw new Error('No authenticated user.');

  // Re-authenticate based on provider
  const providerIds = user.providerData.map((p) => p.providerId);
  if (providerIds.includes('google.com')) {
    await reauthenticateWithPopup(user, new GoogleAuthProvider());
  } else if (providerIds.includes('github.com')) {
    await reauthenticateWithPopup(user, new GithubAuthProvider());
  } else if (providerIds.includes('password') && emailPassword) {
    const cred = EmailAuthProvider.credential(user.email, emailPassword);
    await reauthenticateWithCredential(user, cred);
  }

  await deleteUser(user);
}

/**
 * Bootstraps the auth state listener.
 *
 * Calls `onSignedIn(user)` when a user is authenticated and
 * `onSignedOut()` when there is no authenticated user — driving
 * the app to show the board or the landing page respectively.
 *
 * @param {(user: import('firebase/auth').User) => void} onSignedIn
 * @param {() => void} onSignedOut
 * @returns {import('firebase/auth').Unsubscribe} Unsubscribe function (call to stop listening)
 */
export function initAuth(onSignedIn, onSignedOut) {
  return onAuthStateChanged(auth, (user) => {
    if (user) {
      onSignedIn(user);
    } else {
      onSignedOut();
    }
  });
}
