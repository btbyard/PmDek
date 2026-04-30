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
  getDoc,
  getDocs,
  query,
  updateDoc,
  where,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';

import { db, functions }               from './firebase.js';
import { getUserProfile } from './users.js';

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
  const createOrgFn = httpsCallable(functions, 'createOrganization');
  const result = await createOrgFn({ name: name.trim() });
  const orgId = result?.data?.orgId;
  if (!orgId || typeof orgId !== 'string') {
    throw new Error('Organization create failed: missing organization ID from server.');
  }
  return orgId;
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
 * Finds a user by username and adds them to the organization via a server-side callable.
 * Throws if the username does not exist, user is already in another org, or seat limit is reached.
 *
 * @param {string} orgId         Org to add the user to
 * @param {string} username      Username of the user to invite
 * @returns {Promise<object>}    Resolved user profile
 */
export async function addMemberByUsername(orgId, username) {
  const fn = httpsCallable(functions, 'addOrgMember');
  const result = await fn({ orgId, username: username.toLowerCase() });
  return result.data;
}

/**
 * Removes a member from the organization via a server-side callable.
 * The owner cannot be removed via this function.
 *
 * @param {string} orgId
 * @param {string} uid
 * @returns {Promise<void>}
 */
export async function removeMember(orgId, uid) {
  const fn = httpsCallable(functions, 'removeOrgMember');
  await fn({ orgId, targetUid: uid });
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
 * Sets the org role for a member via a server-side callable.
 * Supported roles: 'admin' | 'collaborator' | 'read-only'
 * @param {string} orgId
 * @param {string} uid
 * @param {string} role
 */
export async function setOrgMemberRole(orgId, uid, role) {
  const fn = httpsCallable(functions, 'setOrgMemberRole');
  await fn({ orgId, targetUid: uid, role });
}

/**
 * Transfers organization ownership to another existing member.
 * Only current owner can perform this action.
 *
 * @param {string} orgId
 * @param {string} newOwnerUid
 * @returns {Promise<void>}
 */
export async function transferOrgOwnership(orgId, newOwnerUid) {
  const fn = httpsCallable(functions, 'transferOrgOwnership');
  await fn({ orgId, newOwnerUid });
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

// ─── Invite flow ──────────────────────────────────────────────────────────────

/**
 * Creates a server-side invite token for the given email and role.
 * Returns { inviteId, token }.
 */
export async function createOrgInvite(orgId, email, role = 'collaborator') {
  const fn = httpsCallable(functions, 'createOrgInvite');
  const result = await fn({ orgId, email, role });
  return result.data; // { inviteId, token }
}

/**
 * Returns safe preview info for an invite (orgName, role, inviterName) without accepting it.
 */
export async function getOrgInvitePreview(inviteId, token) {
  const fn = httpsCallable(functions, 'getOrgInvitePreview');
  const result = await fn({ inviteId, token });
  return result.data; // { orgId, orgName, role, inviterName, expiresAt }
}

/**
 * Accepts an org invite. Adds the current user to the org.
 * Returns { orgId, orgName }.
 */
export async function acceptOrgInvite(inviteId, token) {
  const fn = httpsCallable(functions, 'acceptOrgInvite');
  const result = await fn({ inviteId, token });
  return result.data; // { orgId, orgName }
}
