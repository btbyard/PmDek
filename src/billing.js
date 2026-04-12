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
    monthlyUsd: 0,
  },
  mid: {
    key: 'mid',
    label: 'Mid',
    deckLimit: 25,
    dailyAiRequests: 15,
    allowedProjectTypes: 'all',
    canUseOrg: false,
    monthlyUsd: 9,
  },
  pro: {
    key: 'pro',
    label: 'Pro',
    deckLimit: 75,
    dailyAiRequests: 40,
    allowedProjectTypes: 'all',
    canUseOrg: true,
    monthlyUsd: 19,
  },
  'business-small': {
    key: 'business-small',
    label: 'Business 1-50',
    deckLimit: 300,
    dailyAiRequests: 250,
    allowedProjectTypes: 'all',
    canUseOrg: true,
    monthlyUsd: 19,
  },
  'business-growth': {
    key: 'business-growth',
    label: 'Business 51-500',
    deckLimit: 2000,
    dailyAiRequests: 1000,
    allowedProjectTypes: 'all',
    canUseOrg: true,
    monthlyUsd: 49,
  },
};

const DEFAULT_PLAN_KEY = 'free';

export function getPlanConfig(planKey) {
  return BILLING_PLANS[planKey] || BILLING_PLANS[DEFAULT_PLAN_KEY];
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
  const overrideKey = _getTestPlanOverrideKey();
  if (overrideKey) return getPlanConfig(overrideKey);

  const snap = await getDoc(doc(db, 'users', uid));
  const key = snap.exists() ? (snap.data().billingPlan || DEFAULT_PLAN_KEY) : DEFAULT_PLAN_KEY;
  return getPlanConfig(key);
}

export async function canCreateDeck(uid) {
  const plan = await getUserPlan(uid);
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
  const plan = await getUserPlan(uid);
  if (plan.allowedProjectTypes === 'all') return plan;
  if (plan.allowedProjectTypes.includes(projectType)) return plan;
  throw new Error(`Project type requires a higher tier. Current plan: ${plan.label}.`);
}

export async function consumeAiCredit(uid) {
  const plan = await getUserPlan(uid);
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
  const plan = await getUserPlan(uid);
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
