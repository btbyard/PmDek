/**
 * @module auth
 * @description
 * Handles Firebase Authentication for PMDek.
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
