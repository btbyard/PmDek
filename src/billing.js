/**
 * @module billing
 * Client-side billing + entitlement helpers.
 *
 * Note: this is an MVP enforcement layer in the app. Critical billing checks
 * should also be enforced server-side in Cloud Functions for production.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';

import { auth, db } from './firebase.js';

const TEST_PLAN_OVERRIDES = {
  'bradster8@yahoo.com': 'pro',
};

function _getTestPlanOverrideKey() {
  const email = String(auth.currentUser?.email || '').trim().toLowerCase();
  return TEST_PLAN_OVERRIDES[email] || null;
}

function _usageLocalKey(uid, dayKey) {
  return `pmdek-ai-usage:${uid}:${dayKey}`;
}

function _readLocalUsage(uid, dayKey) {
  try {
    return Number(localStorage.getItem(_usageLocalKey(uid, dayKey)) || 0);
  } catch {
    return 0;
  }
}

function _writeLocalUsage(uid, dayKey, value) {
  try {
    localStorage.setItem(_usageLocalKey(uid, dayKey), String(Math.max(0, Number(value) || 0)));
  } catch {
    // ignore localStorage write failures
  }
}

export const BILLING_PLANS = {
  free: {
    key: 'free',
    label: 'Free',
    deckLimit: 10,
    dailyAiRequests: 2,
    allowedProjectTypes: ['standard', 'weekly', 'recurring'],
    canUseOrg: false,
    orgSeatLimit: 0,
    monthlyUsd: 0,
  },
  mid: {
    key: 'mid',
    label: 'Mid',
    deckLimit: 25,
    dailyAiRequests: 15,
    allowedProjectTypes: 'all',
    canUseOrg: true,
    orgLimitCount: 1,
    orgSeatLimit: 10,
    monthlyUsd: 9,
  },
  pro: {
    key: 'pro',
    label: 'Pro',
    deckLimit: 75,
    dailyAiRequests: 40,
    allowedProjectTypes: 'all',
    canUseOrg: true,
    orgLimitCount: 2,
    orgSeatLimit: 20,
    monthlyUsd: 19,
  },
  'business-small': {
    key: 'business-small',
    label: 'Business 1-50',
    deckLimit: 300,
    dailyAiRequests: 250,
    allowedProjectTypes: 'all',
    canUseOrg: true,
    orgLimitCount: 1,
    orgSeatLimit: 50,
    monthlyUsd: 29,
  },
  'business-growth': {
    key: 'business-growth',
    label: 'Business 51-500',
    deckLimit: 2000,
    dailyAiRequests: 1000,
    allowedProjectTypes: 'all',
    canUseOrg: true,
    orgLimitCount: 1,
    orgSeatLimit: 500,
    monthlyUsd: 49,
  },
  'enterprise': {
    key: 'enterprise',
    label: 'Custom/Enterprise',
    deckLimit: 10000,
    dailyAiRequests: 5000,
    allowedProjectTypes: 'all',
    canUseOrg: true,
    orgLimitCount: 999,
    orgSeatLimit: 5000,
    monthlyUsd: 0,
    customPricing: true,
  },
};

const DEFAULT_PLAN_KEY = 'free';
const PLAN_PRIORITY = {
  free: 0,
  mid: 1,
  pro: 2,
  'business-small': 3,
  'business-growth': 4,
  'enterprise': 5,
};

function _getPlanPriority(planKey) {
  return PLAN_PRIORITY[planKey] ?? 0;
}

function _pickHigherPlan(planA, planB) {
  if (!planB) return planA;
  return _getPlanPriority(planB.key) > _getPlanPriority(planA.key) ? planB : planA;
}

export function getPlanConfig(planKey) {
  return BILLING_PLANS[planKey] || BILLING_PLANS[DEFAULT_PLAN_KEY];
}

export async function getUserBillingContext(uid) {
  const overrideKey = _getTestPlanOverrideKey();
  const userSnap = await getDoc(doc(db, 'users', uid));
  const userData = userSnap.exists() ? (userSnap.data() || {}) : {};
  const personalPlan = getPlanConfig(overrideKey || userData.billingPlan || DEFAULT_PLAN_KEY);

  let orgData = null;
  let orgRole = 'none';
  let inheritedPlan = null;

  if (userData.organizationId) {
    const orgSnap = await getDoc(doc(db, 'organizations', userData.organizationId));
    if (orgSnap.exists()) {
      orgData = { id: orgSnap.id, ...(orgSnap.data() || {}) };
      if (orgData.ownerId === uid) orgRole = 'owner';
      else if (Array.isArray(orgData.admins) && orgData.admins.includes(uid)) orgRole = 'admin';
      else if (Array.isArray(orgData.members) && orgData.members.includes(uid)) orgRole = 'member';

      if (orgData.ownerId) {
        const ownerData = orgData.ownerId === uid
          ? userData
          : ((await getDoc(doc(db, 'users', orgData.ownerId))).data() || {});
        const ownerPlan = getPlanConfig(ownerData.billingPlan || DEFAULT_PLAN_KEY);
        if (ownerPlan.canUseOrg) inheritedPlan = ownerPlan;
      }
    }
  }

  const effectivePlan = _pickHigherPlan(personalPlan, inheritedPlan);

  return {
    personalPlan,
    effectivePlan,
    inheritedPlan: inheritedPlan && orgData?.ownerId !== uid ? inheritedPlan : null,
    organizationId: userData.organizationId || null,
    ownedOrgIds: Array.isArray(userData.ownedOrgIds) ? userData.ownedOrgIds : (userData.ownedOrgId ? [userData.ownedOrgId] : []),
    orgRole,
    canCreateOrganization: Boolean(personalPlan.canUseOrg),
    canManageOrgMembers: orgRole === 'owner' || orgRole === 'admin',
  };
}

export async function getEffectiveUserPlan(uid) {
  return (await getUserBillingContext(uid)).effectivePlan;
}

export async function canCreateOrganization(uid) {
  const ctx = await getUserBillingContext(uid);
  let reason = null;
  const orgLimit = ctx.personalPlan.orgLimitCount || 0;
  const ownedCount = Array.isArray(ctx.ownedOrgIds) ? ctx.ownedOrgIds.length : 0;
  
  if (!ctx.personalPlan.canUseOrg) {
    reason = 'Organization creation requires your own Pro or Business plan.';
  } else if (ctx.organizationId && !(Array.isArray(ctx.ownedOrgIds) && ctx.ownedOrgIds.includes(ctx.organizationId))) {
    reason = 'You are already part of another organization. Leave it before creating your own.';
  } else if (ownedCount >= orgLimit && orgLimit > 0) {
    reason = `Your ${ctx.personalPlan.label} plan allows up to ${orgLimit} organization${orgLimit === 1 ? '' : 's'}. You have reached the limit.`;
  }

  return {
    allowed: !reason && ctx.personalPlan.canUseOrg && ownedCount < orgLimit,
    reason,
    orgLimit,
    ownedCount,
    organizationId: ctx.organizationId || null,
    ownedOrgIds: Array.isArray(ctx.ownedOrgIds) ? ctx.ownedOrgIds : [],
    personalPlan: ctx.personalPlan,
    effectivePlan: ctx.effectivePlan,
  };
}

export async function ensureBillingDefaults(uid) {
  const overrideKey = _getTestPlanOverrideKey();
  const userRef = doc(db, 'users', uid);
  const snap = await getDoc(userRef);
  if (!snap.exists()) return;
  const data = snap.data() || {};

  if (overrideKey && data.billingPlan !== overrideKey) {
    await setDoc(userRef, {
      billingPlan: overrideKey,
      billingStatus: 'active',
      billingUpdatedAt: serverTimestamp(),
    }, { merge: true });
    return;
  }

  if (data.billingPlan) return;
  await setDoc(userRef, {
    billingPlan: DEFAULT_PLAN_KEY,
    billingStatus: 'active',
    billingUpdatedAt: serverTimestamp(),
  }, { merge: true });
}

export async function getUserPlan(uid) {
  return (await getUserBillingContext(uid)).personalPlan;
}

export async function canCreateDeck(uid) {
  const plan = await getEffectiveUserPlan(uid);
  const q = query(collection(db, 'boards'), where('userId', '==', uid));
  const snap = await getDocs(q);
  return {
    allowed: snap.size < plan.deckLimit,
    used: snap.size,
    limit: plan.deckLimit,
    plan,
  };
}

export async function assertProjectTypeAllowed(uid, projectType) {
  const plan = await getEffectiveUserPlan(uid);
  if (plan.allowedProjectTypes === 'all') return plan;
  if (plan.allowedProjectTypes.includes(projectType)) return plan;
  throw new Error(`Project type requires a higher tier. Current plan: ${plan.label}.`);
}

export async function consumeAiCredit(uid) {
  const plan = await getEffectiveUserPlan(uid);
  const dayKey = new Date().toISOString().slice(0, 10);
  const usageRef = doc(db, 'users', uid, 'usage', `ai-${dayKey}`);

  try {
    await runTransaction(db, async (tx) => {
      const usageSnap = await tx.get(usageRef);
      const current = usageSnap.exists() ? (usageSnap.data().count || 0) : 0;
      if (current >= plan.dailyAiRequests) {
        throw new Error(`Daily AI limit reached for ${plan.label} (${plan.dailyAiRequests}/day).`);
      }
      tx.set(usageRef, {
        count: current + 1,
        day: dayKey,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    });
  } catch (err) {
    // Fallback for environments where usage subcollection rules are not deployed yet.
    if (String(err?.code || '').includes('permission-denied')) {
      const currentLocal = _readLocalUsage(uid, dayKey);
      if (currentLocal >= plan.dailyAiRequests) {
        throw new Error(`Daily AI limit reached for ${plan.label} (${plan.dailyAiRequests}/day).`);
      }
      _writeLocalUsage(uid, dayKey, currentLocal + 1);
    } else {
      throw err;
    }
  }

  return plan;
}

export async function getAiUsageSummary(uid) {
  const plan = await getEffectiveUserPlan(uid);
  const dayKey = new Date().toISOString().slice(0, 10);
  const usageRef = doc(db, 'users', uid, 'usage', `ai-${dayKey}`);
  let used = 0;
  try {
    const snap = await getDoc(usageRef);
    used = snap.exists() ? Number(snap.data().count || 0) : 0;
  } catch (err) {
    if (String(err?.code || '').includes('permission-denied')) {
      used = _readLocalUsage(uid, dayKey);
    } else {
      used = 0;
    }
  }
  const limit = Number(plan.dailyAiRequests || 0);
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    plan,
    dayKey,
  };
}
