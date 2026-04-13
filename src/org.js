/**
 * @module org
 * @description
 * Organization management: create, fetch, add/remove members.
 *
 * Each user can belong to at most one organization (organizationId on the
 * user doc). An owner can create exactly one org (ownedOrgId on the user doc).
 *
 * Collection: /organizations/{orgId}
 */

import {
  collection,
  doc,
  addDoc,
  getDoc,
  updateDoc,
  arrayUnion,
  arrayRemove,
  serverTimestamp,
} from 'firebase/firestore';

import { db }                          from './firebase.js';
import { getUserByUsername, getUserProfile } from './users.js';
import { getPlanConfig }               from './billing.js';

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Creates a new organization owned by the given user.
 * Sets organizationId and ownedOrgId on the user doc.
 *
 * @param {string} uid
 * @param {string} name
 * @returns {Promise<string>} New org document ID
 */
export async function createOrg(uid, name) {
  const orgRef = await addDoc(collection(db, 'organizations'), {
    name:      name.trim(),
    ownerId:   uid,
    members:   [uid],
    admins:    [uid],
    createdAt: serverTimestamp(),
  });
  await updateDoc(doc(db, 'users', uid), {
    ownedOrgId:     orgRef.id,
    organizationId: orgRef.id,
  });
  return orgRef.id;
}

/**
 * Fetches an organization by ID.
 * Returns null if it does not exist.
 *
 * @param {string} orgId
 * @returns {Promise<object|null>}
 */
export async function getOrgById(orgId) {
  if (!orgId) return null;
  const snap = await getDoc(doc(db, 'organizations', orgId));
  return snap.exists() ? { id: orgId, ...snap.data() } : null;
}

/**
 * Returns full user profiles for all members of the given org.
 *
 * @param {string} orgId
 * @returns {Promise<object[]>}
 */
export async function getOrgMembers(orgId) {
  const org = await getOrgById(orgId);
  if (!org || !Array.isArray(org.members)) return [];
  const profiles = await Promise.all(org.members.map((uid) => getUserProfile(uid)));
  return profiles.filter(Boolean);
}

// ─── Membership ───────────────────────────────────────────────────────────────

/**
 * Finds a user by username and adds them to the organization.
 * Throws if the username does not exist or the user is already in a different org.
 *
 * @param {string} orgId         Org to add the user to
 * @param {string} username      Username of the user to invite
 * @param {string} inviterOrgId  OrgId of the inviting owner (for conflict check)
 * @returns {Promise<object>}    Resolved user profile
 */
export async function addMemberByUsername(orgId, username, inviterOrgId) {
  const org = await getOrgById(orgId);
  if (!org) throw new Error('Organization not found.');

  const user = await getUserByUsername(username);
  if (!user) throw new Error(`No user found with username "@${username}".`);
  if (user.organizationId && user.organizationId !== inviterOrgId) {
    throw new Error(`@${username} is already a member of another organization.`);
  }

  const ownerProfile = org.ownerId ? await getUserProfile(org.ownerId) : null;
  const ownerPlan = getPlanConfig(ownerProfile?.billingPlan || 'free');
  const seatLimit = Number(ownerPlan.orgSeatLimit || 0);
  const currentMembers = Array.isArray(org.members) ? org.members : [];

  if (seatLimit > 0 && currentMembers.length >= seatLimit) {
    throw new Error(`${ownerPlan.label} allows up to ${seatLimit} users per organization.`);
  }

  await updateDoc(doc(db, 'organizations', orgId), {
    members: arrayUnion(user.uid),
  });
  await updateDoc(doc(db, 'users', user.uid), {
    organizationId: orgId,
  });
  return user;
}

/**
 * Removes a member from the organization and clears their organizationId.
 * The owner cannot be removed via this function (caller should check first).
 *
 * @param {string} orgId
 * @param {string} uid
 * @returns {Promise<void>}
 */
export async function removeMember(orgId, uid) {
  await updateDoc(doc(db, 'organizations', orgId), {
    members: arrayRemove(uid),
    admins: arrayRemove(uid),
  });
  await updateDoc(doc(db, 'users', uid), {
    organizationId: null,
  });
}

// ─── Organization admins ──────────────────────────────────────────────────────

/**
 * Sets or removes admin status for a member of the org.
 * @param {string} orgId
 * @param {string} uid
 * @param {boolean} isAdmin
 */
export async function setOrgMemberAdminStatus(orgId, uid, isAdmin) {
  const org = await getOrgById(orgId);
  if (!org) throw new Error('Organization not found.');
  if (!Array.isArray(org.members) || !org.members.includes(uid)) {
    throw new Error('User must be an organization member before becoming an admin.');
  }
  
  const admins = Array.isArray(org.admins) ? org.admins : [];
  const updatedAdmins = isAdmin
    ? [...new Set([...admins, uid])]
    : admins.filter((id) => id !== uid);
  
  await updateDoc(doc(db, 'organizations', orgId), { admins: updatedAdmins });
}

/**
 * Fetches all organizations.
 * @returns {Promise<object[]>}
 */
export async function getAllOrganizations() {
  const { getDocs, collection } = await import('firebase/firestore');
  const snap = await getDocs(collection(db, 'organizations'));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
