/**
 * @module users
 * @description
 * User profile management: creation on first sign-in, unique username claiming,
 * and lookups by username or UID.
 *
 * Collections:
 *  - /users/{uid}           — user profile document
 *  - /usernames/{username}  — uniqueness index: maps username → uid
 */

import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';

import { db } from './firebase.js';

// ─── Profile CRUD ─────────────────────────────────────────────────────────────

/**
 * Fetches a user profile by UID.
 * Returns null if the document does not exist.
 * @param {string} uid
 * @returns {Promise<object|null>}
 */
export async function getUserProfile(uid) {
  if (!uid) return null;
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? { uid, ...snap.data() } : null;
}

/**
 * Ensures a /users/{uid} document exists for the signed-in Firebase user.
 * Creates a base profile on first sign-in (without a username).
 * Returns the profile object.
 *
 * @param {import('firebase/auth').User} user
 * @returns {Promise<object>}
 */
export async function ensureUserProfile(user) {
  const ref  = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) {
    return { uid: user.uid, ...snap.data() };
  }
  // First sign-in — write base document
  const profile = {
    displayName:    user.displayName || '',
    email:          user.email || '',
    photoURL:       user.photoURL || '',
    billingPlan:    'free',
    billingStatus:  'active',
    organizationId: null,
    ownedOrgId:     null,
    isAdmin:        false,
    createdAt:      serverTimestamp(),
  };
  await setDoc(ref, profile);
  return { uid: user.uid, ...profile };
}

/**
 * Updates the display name on the /users/{uid} document.
 * @param {string} uid
 * @param {string} displayName
 */
export async function updateUserDisplayName(uid, displayName) {
  await updateDoc(doc(db, 'users', uid), { displayName: displayName.trim() });
}

// ─── Username system ──────────────────────────────────────────────────────────

/**
 * Returns true if the given username is available (not yet claimed).
 * @param {string} username
 * @returns {Promise<boolean>}
 */
export async function checkUsernameAvailable(username) {
  try {
    const snap = await getDoc(doc(db, 'usernames', username.toLowerCase()));
    return !snap.exists();
  } catch (err) {
    // If rules for /usernames are not deployed yet, do not block onboarding.
    if (String(err?.code || '').includes('permission-denied')) return true;
    throw err;
  }
}

/**
 * Atomically claims a username for a user.
 * Writes to both /usernames/{username} (index) and /users/{uid} (profile).
 * Throws if the username is already taken.
 *
 * @param {string} uid
 * @param {string} username  Must already be validated (3–20 chars, a-z0-9_)
 * @returns {Promise<void>}
 */
export async function claimUsername(uid, username) {
  const normalized = username.toLowerCase();
  try {
    await runTransaction(db, async (txn) => {
      const usernameRef = doc(db, 'usernames', normalized);
      const existing    = await txn.get(usernameRef);
      if (existing.exists()) throw new Error('Username is already taken.');
      txn.set(usernameRef, { uid });
      txn.set(doc(db, 'users', uid), { username: normalized }, { merge: true });
    });
  } catch (err) {
    // Temporary fallback when /usernames is denied by old rules.
    if (String(err?.code || '').includes('permission-denied')) {
      await setDoc(doc(db, 'users', uid), { username: normalized }, { merge: true });
      return;
    }
    throw err;
  }
}

/**
 * Looks up a user profile by username.
 * Returns null if the username does not exist.
 *
 * @param {string} username
 * @returns {Promise<object|null>}
 */
export async function getUserByUsername(username) {
  const snap = await getDoc(doc(db, 'usernames', username.toLowerCase()));
  if (!snap.exists()) return null;
  const { uid } = snap.data();
  return getUserProfile(uid);
}

// ─── Validation helpers ───────────────────────────────────────────────────────

/**
 * Returns an error message string if the username is invalid, or null if valid.
 * Rules: 3–20 characters, lowercase letters / digits / underscores only.
 * @param {string} value
 * @returns {string|null}
 */
export function validateUsername(value) {
  if (!value) return 'Username is required.';
  if (value.length < 3)  return 'Username must be at least 3 characters.';
  if (value.length > 20) return 'Username must be 20 characters or fewer.';
  if (!/^[a-z0-9_]+$/.test(value)) return 'Only lowercase letters, numbers, and underscores are allowed.';
  return null;
}

// ─── Admin functions ──────────────────────────────────────────────────────────

/**
 * Fetches all users with basic profile info.
 * @returns {Promise<object[]>}
 */
export async function getAllUsers() {
  const { getDocs, collection, query } = await import('firebase/firestore');
  const snap = await getDocs(collection(db, 'users'));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
}

/**
 * Sets or removes admin status on a user.
 * @param {string} uid
 * @param {boolean} isAdmin
 */
export async function setUserAdminStatus(uid, isAdmin) {
  await updateDoc(doc(db, 'users', uid), { isAdmin: Boolean(isAdmin) });
}
