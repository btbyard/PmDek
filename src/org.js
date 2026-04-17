/**
 * @module org
 * @description
 * Organization management: create, fetch, add/remove members.
 *
 * Users can own multiple organizations (based on plan limits).
 * Users can belong to one organization (organizationId on user doc).
 *
 * Collection: /organizations/{orgId}
 * org.allowAiUsage - boolean, whether org members can use AI features (default: true)
 */

import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  query,
  updateDoc,
  where,
  arrayUnion,
  arrayRemove,
  deleteField,
  serverTimestamp,
} from 'firebase/firestore';

import { db }                          from './firebase.js';
import { getUserByUsername, getUserProfile } from './users.js';
import { getPlanConfig }               from './billing.js';

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Creates a new organization owned by the given user.
 * Checks plan limits for org count.
 * Adds allowAiUsage setting (default: true).
 *
 * @param {string} uid
 * @param {string} name
 * @returns {Promise<string>} New org document ID
 * @throws {Error} if user has reached org limit for their plan
 */
export async function createOrg(uid, name) {
  // Check org count limit based on plan
  const userSnap = await getDoc(doc(db, 'users', uid));
  const userData = userSnap.exists() ? (userSnap.data() || {}) : {};
  const userPlan = getPlanConfig(userData.billingPlan || 'free');
  const orgLimit = userPlan.orgLimitCount || 0;
  
  if (orgLimit <= 0) {
    throw new Error(`Your ${userPlan.label} plan does not allow creating organizations.`);
  }
  
  const ownedOrgIds = Array.isArray(userData.ownedOrgIds) ? userData.ownedOrgIds : [];
  if (ownedOrgIds.length >= orgLimit) {
    throw new Error(`Your ${userPlan.label} plan allows up to ${orgLimit} organization${orgLimit === 1 ? '' : 's'}. You have reached the limit.`);
  }
  
  const orgRef = await addDoc(collection(db, 'organizations'), {
    name:      name.trim(),
    ownerId:   uid,
    members:   [uid],
    admins:    [uid],
    memberRoles: {
      [uid]: 'owner',
    },
    allowAiUsage: true,
    createdAt: serverTimestamp(),
  });
  
  // Update user doc with new org in ownedOrgIds array
  ownedOrgIds.push(orgRef.id);
  await updateDoc(doc(db, 'users', uid), {
    ownedOrgIds: ownedOrgIds,
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
 * Returns all organizations where the user is a member.
 *
 * @param {string} uid
 * @returns {Promise<object[]>}
 */
export async function getUserOrganizations(uid) {
  if (!uid) return [];
  const q = query(collection(db, 'organizations'), where('members', 'array-contains', uid));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
    [`memberRoles.${user.uid}`]: 'collaborator',
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
    [`memberRoles.${uid}`]: deleteField(),
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
  return setOrgMemberRole(orgId, uid, isAdmin ? 'admin' : 'collaborator');
}

/**
 * Sets the org role for a member and keeps admins[] aligned for rule checks.
 * Supported roles: 'admin' | 'collaborator' | 'read-only'
 * @param {string} orgId
 * @param {string} uid
 * @param {string} role
 */
export async function setOrgMemberRole(orgId, uid, role) {
  const org = await getOrgById(orgId);
  if (!org) throw new Error('Organization not found.');
  if (!Array.isArray(org.members) || !org.members.includes(uid)) {
    throw new Error('User must be an organization member before role assignment.');
  }

  const normalizedRole = String(role || '').toLowerCase();
  if (!['admin', 'collaborator', 'read-only'].includes(normalizedRole)) {
    throw new Error('Invalid role. Must be admin, collaborator, or read-only.');
  }

  if (org.ownerId === uid) {
    throw new Error('Owner role cannot be changed.');
  }

  const admins = Array.isArray(org.admins) ? org.admins : [];
  const updatedAdmins = normalizedRole === 'admin'
    ? [...new Set([...admins, uid])]
    : admins.filter((id) => id !== uid);

  await updateDoc(doc(db, 'organizations', orgId), {
    admins: updatedAdmins,
    [`memberRoles.${uid}`]: normalizedRole,
  });
}

/**
 * Fetches all organizations.
 * @returns {Promise<object[]>}
 */
export async function getAllOrganizations() {
  const snap = await getDocs(collection(db, 'organizations'));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ─── Organization Settings ────────────────────────────────────────────────────

/**
 * Updates org AI usage setting.
 * Only owners/admins can update org settings.
 *
 * @param {string} orgId
 * @param {boolean} allowAiUsage
 * @returns {Promise<void>}
 */
export async function setOrgAiUsageSetting(orgId, allowAiUsage) {
  const org = await getOrgById(orgId);
  if (!org) throw new Error('Organization not found.');

  await updateDoc(doc(db, 'organizations', orgId), {
    allowAiUsage: Boolean(allowAiUsage),
  });
}

/**
 * Checks if AI usage is allowed for an organization.
 *
 * @param {string} orgId
 * @returns {Promise<boolean>}
 */
export async function isOrgAiUsageAllowed(orgId) {
  const org = await getOrgById(orgId);
  if (!org) return false;
  return org.allowAiUsage !== false; // Default to true if not set
}
