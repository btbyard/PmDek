/**
 * PMDecks Cloud Functions
 *
 * Functions:
 *  - generateCard  : natural language prompt → { title, description }
 *  - generateBoard : project description → { title, columns }
 *
 * Uses the @google/genai SDK (v1.x) with gemini-2.0-flash.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule }          = require('firebase-functions/v2/scheduler');
const { defineSecret }       = require('firebase-functions/params');
const { GoogleGenAI }        = require('@google/genai');
const admin                  = require('firebase-admin');
const Stripe                 = require('stripe');
const crypto                 = require('crypto');

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_PRICE_MID = defineSecret('STRIPE_PRICE_MID');
const STRIPE_PRICE_PRO = defineSecret('STRIPE_PRICE_PRO');
const STRIPE_PRICE_BUSINESS_SMALL = defineSecret('STRIPE_PRICE_BUSINESS_SMALL');
const STRIPE_PRICE_BUSINESS_GROWTH = defineSecret('STRIPE_PRICE_BUSINESS_GROWTH');
const _BUILD = 5; // bump to force redeploy

if (!admin.apps.length) {
  admin.initializeApp();
}

function _isBootstrapAdminEmail(email) {
  const normalized = String(email || '').toLowerCase().trim();
  return ['bradster8@yahoo.com'].includes(normalized);
}

function _getStripe() {
  const key = STRIPE_SECRET_KEY.value();
  if (!key) throw new HttpsError('failed-precondition', 'Stripe is not configured (missing STRIPE_SECRET_KEY).');
  return new Stripe(key, { apiVersion: '2025-02-24.acacia' });
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function _getAI() {
  const key = GEMINI_API_KEY.value();
  if (!key) throw new HttpsError('internal', 'AI service is not configured.');
  return new GoogleGenAI({ apiKey: key });
}

const MODEL = 'gemini-2.5-flash';

const BILLING_PLANS = {
  free: {
    key: 'free',
    deckLimit: 10,
    dailyAiRequests: 2,
    allowedProjectTypes: ['standard', 'weekly', 'recurring'],
    canUseOrg: false,
    orgLimitCount: 0,
    orgSeatLimit: 0,
  },
  mid: {
    key: 'mid',
    deckLimit: 25,
    dailyAiRequests: 15,
    allowedProjectTypes: 'all',
    canUseOrg: true,
    orgLimitCount: 1,
    orgSeatLimit: 10,
  },
  pro: {
    key: 'pro',
    deckLimit: 75,
    dailyAiRequests: 40,
    allowedProjectTypes: 'all',
    canUseOrg: true,
    orgLimitCount: 2,
    orgSeatLimit: 20,
  },
  'business-small': {
    key: 'business-small',
    deckLimit: 300,
    dailyAiRequests: 250,
    allowedProjectTypes: 'all',
    canUseOrg: true,
    orgLimitCount: 1,
    orgSeatLimit: 50,
  },
  'business-growth': {
    key: 'business-growth',
    deckLimit: 2000,
    dailyAiRequests: 1000,
    allowedProjectTypes: 'all',
    canUseOrg: true,
    orgLimitCount: 1,
    orgSeatLimit: 500,
  },
  enterprise: {
    key: 'enterprise',
    deckLimit: 10000,
    dailyAiRequests: 5000,
    allowedProjectTypes: 'all',
    canUseOrg: true,
    orgLimitCount: 999,
    orgSeatLimit: 5000,
  },
};

const DEFAULT_PLAN_KEY = 'free';
const PLAN_PRIORITY = {
  free: 0,
  mid: 1,
  pro: 2,
  'business-small': 3,
  'business-growth': 4,
  enterprise: 5,
};

function _stripFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

function _getPlanConfig(planKey) {
  return BILLING_PLANS[planKey] || BILLING_PLANS[DEFAULT_PLAN_KEY];
}

function _pickHigherPlan(planA, planB) {
  if (!planB) return planA;
  const planAPriority = PLAN_PRIORITY[planA.key] ?? 0;
  const planBPriority = PLAN_PRIORITY[planB.key] ?? 0;
  return planBPriority > planAPriority ? planB : planA;
}

async function _getUserDoc(uid) {
  const snap = await admin.firestore().collection('users').doc(uid).get();
  return snap.exists ? (snap.data() || {}) : {};
}

async function _getEffectiveUserPlan(uid) {
  const userData = await _getUserDoc(uid);
  const personalPlan = _getPlanConfig(userData.billingPlan || DEFAULT_PLAN_KEY);

  if (!userData.organizationId) return personalPlan;

  const orgSnap = await admin.firestore().collection('organizations').doc(userData.organizationId).get();
  if (!orgSnap.exists) return personalPlan;

  const orgData = orgSnap.data() || {};
  if (!orgData.ownerId) return personalPlan;

  const ownerData = orgData.ownerId === uid ? userData : await _getUserDoc(orgData.ownerId);
  const ownerPlan = _getPlanConfig(ownerData.billingPlan || DEFAULT_PLAN_KEY);
  const inheritedPlan = ownerPlan.canUseOrg ? ownerPlan : null;

  return _pickHigherPlan(personalPlan, inheritedPlan);
}

async function _consumeAiCreditOrThrow(uid) {
  const plan = await _getEffectiveUserPlan(uid);
  const dayKey = new Date().toISOString().slice(0, 10);
  const usageRef = admin.firestore().collection('users').doc(uid).collection('usage').doc(`ai-${dayKey}`);

  await admin.firestore().runTransaction(async (tx) => {
    const usageSnap = await tx.get(usageRef);
    const current = usageSnap.exists ? Number(usageSnap.data().count || 0) : 0;
    if (current >= Number(plan.dailyAiRequests || 0)) {
      throw new HttpsError('resource-exhausted', `Daily AI limit reached for ${plan.key} (${plan.dailyAiRequests}/day).`);
    }

    tx.set(usageRef, {
      count: current + 1,
      day: dayKey,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
}

function _normalizeColumns(columns) {
  if (!Array.isArray(columns) || columns.length < 2) {
    throw new HttpsError('invalid-argument', 'columns must be an array with at least 2 columns.');
  }

  return columns.slice(0, 15).map((col, index) => ({
    id: String(col?.id || `col-${index}`).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40),
    title: String(col?.title || `Column ${index + 1}`).slice(0, 30),
    order: index,
  }));
}

// ─── generateCard ─────────────────────────────────────────────────────────────

exports.generateCard = onCall({ maxInstances: 10, invoker: 'public', secrets: [GEMINI_API_KEY] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to use AI features.');
  }

  const { prompt } = request.data;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'prompt must be a non-empty string.');
  }
  if (prompt.trim().length > 500) {
    throw new HttpsError('invalid-argument', 'prompt must be 500 characters or fewer.');
  }

  await _consumeAiCreditOrThrow(request.auth.uid);

  const ai = _getAI();

  let result;
  try {
    result = await ai.models.generateContent({
      model: MODEL,
      contents: prompt.trim(),
      config: {
        systemInstruction: `You are a senior software engineer and project management expert.
Convert the user's task description into a concise, well-scoped Kanban card following standard software engineering practices.
Consider where this task fits in an SDLC (planning, design, implementation, testing, review, deployment, documentation).
Respond with ONLY valid JSON matching this exact shape:
{
  "title": "Short, action-oriented title using imperative verb (max 80 chars)",
  "description": "One to three sentences of technical context, acceptance criteria, or definition of done (max 300 chars). Empty string if not needed."
}
Do not include markdown fences, comments, or any text outside the JSON object.`,
        responseMimeType: 'application/json',
      },
    });
  } catch (err) {
    console.error('generateCard: Gemini API error:', err.message ?? err);
    throw new HttpsError('internal', 'AI service request failed.');
  }

  const rawText = result.text ?? '';
  let parsed;
  try {
    parsed = JSON.parse(_stripFences(rawText));
  } catch {
    console.error('generateCard: failed to parse response:', rawText);
    throw new HttpsError('internal', 'AI returned an unexpected response format.');
  }

  if (typeof parsed.title !== 'string' || !parsed.title.trim()) {
    throw new HttpsError('internal', 'AI returned a card without a title.');
  }

  return {
    title:       parsed.title.trim().slice(0, 80),
    description: (parsed.description || '').trim().slice(0, 300),
  };
});

// ─── generateBoard ────────────────────────────────────────────────────────────

exports.generateBoard = onCall({ maxInstances: 10, invoker: 'public', secrets: [GEMINI_API_KEY] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to use AI features.');
  }

  const { prompt } = request.data;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'prompt must be a non-empty string.');
  }
  if (prompt.trim().length > 500) {
    throw new HttpsError('invalid-argument', 'prompt must be 500 characters or fewer.');
  }

  await _consumeAiCreditOrThrow(request.auth.uid);

  const ai = _getAI();

  let result;
  try {
    result = await ai.models.generateContent({
      model: MODEL,
      contents: prompt.trim(),
      config: {
        systemInstruction: `You are a project management assistant.
Given a project description, create a Kanban board configuration.
Respond with ONLY valid JSON matching this exact shape:
{
  "title": "Board title (max 60 chars, concise and descriptive)",
  "columns": [
    { "id": "todo",        "title": "To Do",       "order": 0 },
    { "id": "in-progress", "title": "In Progress",  "order": 1 },
    { "id": "done",        "title": "Done",         "order": 2 }
  ]
}
Use 3-5 columns that suit the project type.
Column ids must be lowercase-hyphenated (e.g. "todo", "in-review", "deployed").
Column titles should be short (max 30 chars each).
Do not include markdown fences or any text outside the JSON object.`,
        responseMimeType: 'application/json',
      },
    });
  } catch (err) {
    console.error('generateBoard: Gemini API error:', err.message ?? err);
    throw new HttpsError('internal', 'AI service request failed.');
  }

  const rawText = result.text ?? '';
  let parsed;
  try {
    parsed = JSON.parse(_stripFences(rawText));
  } catch {
    console.error('generateBoard: failed to parse response:', rawText);
    throw new HttpsError('internal', 'AI returned an unexpected response format.');
  }

  if (typeof parsed.title !== 'string' || !parsed.title.trim()) {
    throw new HttpsError('internal', 'AI returned a board without a title.');
  }
  if (!Array.isArray(parsed.columns) || parsed.columns.length < 2) {
    throw new HttpsError('internal', 'AI returned an invalid columns array.');
  }

  const columns = parsed.columns.slice(0, 6).map((col, i) => ({
    id:    String(col.id   || `col-${i}`).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40),
    title: String(col.title || `Column ${i + 1}`).slice(0, 30),
    order: i,
  }));

  return {
    title:   parsed.title.trim().slice(0, 60),
    columns,
  };
});

// ─── generateBoardWithTasks ───────────────────────────────────────────────────

exports.generateBoardWithTasks = onCall({ maxInstances: 10, invoker: 'public', secrets: [GEMINI_API_KEY] }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to use AI features.');
  }

  const { prompt } = request.data;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new HttpsError('invalid-argument', 'prompt must be a non-empty string.');
  }
  if (prompt.trim().length > 500) {
    throw new HttpsError('invalid-argument', 'prompt must be 500 characters or fewer.');
  }

  await _consumeAiCreditOrThrow(request.auth.uid);

  const ai = _getAI();

  let result;
  try {
    result = await ai.models.generateContent({
      model: MODEL,
      contents: prompt.trim(),
      config: {
        systemInstruction: `You are a senior software engineer and project manager generating a complete Kanban board for a software project.
You follow standard software engineering practices: agile planning, TDD, CI/CD, code review, security, documentation, and observability.
Given a project description, create a full board with columns and ALL tasks placed in the first ("todo") column — nothing is in progress or done yet.

Respond with ONLY valid JSON matching this exact shape — no markdown fences, no extra text:
{
  "title": "Board title (max 60 chars)",
  "columns": [
    {
      "id": "todo",
      "title": "To Do",
      "order": 0,
      "tasks": [
        {
          "title": "Imperative-verb task title (max 80 chars)",
          "description": "Acceptance criteria or technical context (max 200 chars, or empty string)",
          "subtasks": [
            { "title": "Concrete step (max 80 chars)" }
          ]
        }
      ]
    }
  ]
}

Rules for columns:
- Use 3-5 columns that suit the project workflow (e.g. To Do, In Progress, In Review, Done)
- Column ids must be lowercase-hyphenated ("todo", "in-progress", "in-review", "done")
- ALL tasks belong in the first column ("todo") — the other columns start empty

Rules for tasks (place ALL in the first column):
- 8-14 tasks total; cover the full SDLC: requirements, architecture, implementation, testing, CI/CD, security, documentation
- Include tasks for: project setup & tooling, core feature implementation, unit & integration tests, code review process, CI/CD pipeline, security review, API/user documentation, deployment, monitoring/observability
- Each task must have 2-4 specific subtasks that break it into concrete engineering steps
- **Be concise**: task titles max 55 chars, use 3-5 words, imperative verb (Set up, Implement, Write, Configure, Add, Deploy)
- **Descriptions**: one short sentence max 100 chars, or empty string — no fluff
- **Subtask titles**: max 45 chars, action-oriented, no padding words
- Tasks and subtasks must be concrete and specific to the described project`,
        responseMimeType: 'application/json',
      },
    });
  } catch (err) {
    console.error('generateBoardWithTasks: Gemini API error:', err.message ?? err);
    throw new HttpsError('internal', 'AI service request failed.');
  }

  const rawText = result.text ?? '';
  let parsed;
  try {
    parsed = JSON.parse(_stripFences(rawText));
  } catch {
    console.error('generateBoardWithTasks: failed to parse response:', rawText);
    throw new HttpsError('internal', 'AI returned an unexpected response format.');
  }

  if (typeof parsed.title !== 'string' || !parsed.title.trim()) {
    throw new HttpsError('internal', 'AI returned a board without a title.');
  }
  if (!Array.isArray(parsed.columns) || parsed.columns.length < 2) {
    throw new HttpsError('internal', 'AI returned an invalid columns array.');
  }

  const columns = parsed.columns.slice(0, 6).map((col, i) => ({
    id:    String(col.id || `col-${i}`).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40),
    title: String(col.title || `Column ${i + 1}`).slice(0, 30),
    order: i,
    tasks: (Array.isArray(col.tasks) ? col.tasks : []).slice(0, 6).map((t, ti) => ({
      title:       String(t.title || '').trim().slice(0, 80),
      description: String(t.description || '').trim().slice(0, 200),
      order:       ti,
      subtasks:    (Array.isArray(t.subtasks) ? t.subtasks : []).slice(0, 6).map((s, si) => ({
        id:        `sub-${Date.now()}-${si}-${Math.floor(Math.random() * 10000)}`,
        title:     String(s.title || '').trim().slice(0, 80),
        completed: false,
      })).filter((s) => s.title),
    })).filter((t) => t.title),
  }));

  return {
    title: parsed.title.trim().slice(0, 60),
    columns,
  };
});

// ─── createBoard (server-enforced limits) ───────────────────────────────────

exports.createBoard = onCall({ maxInstances: 20, invoker: 'public' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to create a deck.');
  }

  const uid = request.auth.uid;
  const {
    title,
    columns,
    dueDate = null,
    color = null,
    projectType = 'standard',
    visibility = 'private',
    orgId = null,
    assignedMembers = [],
    projectDeckOwnerId = null,
  } = request.data || {};

  if (typeof title !== 'string' || !title.trim()) {
    throw new HttpsError('invalid-argument', 'title is required.');
  }

  const effectivePlan = await _getEffectiveUserPlan(uid);
  const boardCountSnap = await admin.firestore().collection('boards').where('userId', '==', uid).count().get();
  const boardCount = Number(boardCountSnap.data().count || 0);
  if (boardCount >= Number(effectivePlan.deckLimit || 0)) {
    throw new HttpsError('resource-exhausted', `Deck limit reached for ${effectivePlan.key} (${effectivePlan.deckLimit}).`);
  }

  if (effectivePlan.allowedProjectTypes !== 'all' && !effectivePlan.allowedProjectTypes.includes(projectType)) {
    throw new HttpsError('permission-denied', `Project type requires a higher plan than ${effectivePlan.key}.`);
  }

  const safeVisibility = visibility === 'org' ? 'org' : 'private';
  let safeOrgId = null;
  let safeAssignedMembers = [];
  let safeProjectDeckOwnerId = null;

  if (safeVisibility === 'org') {
    if (!effectivePlan.canUseOrg) {
      throw new HttpsError('permission-denied', 'Your plan does not allow organization decks.');
    }
    if (typeof orgId !== 'string' || !orgId.trim()) {
      throw new HttpsError('invalid-argument', 'orgId is required for organization decks.');
    }

    const orgSnap = await admin.firestore().collection('organizations').doc(orgId).get();
    if (!orgSnap.exists) {
      throw new HttpsError('not-found', 'Organization not found.');
    }
    const orgData = orgSnap.data() || {};
    const orgMembers = Array.isArray(orgData.members) ? orgData.members : [];
    if (!orgMembers.includes(uid)) {
      throw new HttpsError('permission-denied', 'You must be an organization member to create an org deck.');
    }

    safeOrgId = orgId;
    safeAssignedMembers = Array.isArray(assignedMembers)
      ? [...new Set(assignedMembers.filter((memberUid) => orgMembers.includes(memberUid)))]
      : [];
    safeProjectDeckOwnerId = (typeof projectDeckOwnerId === 'string' && orgMembers.includes(projectDeckOwnerId))
      ? projectDeckOwnerId
      : uid;
  }

  const boardDoc = {
    userId: uid,
    title: title.trim().slice(0, 60) || 'My Board',
    columns: _normalizeColumns(columns),
    dueDate: dueDate || null,
    color: color || null,
    projectType: String(projectType || 'standard'),
    visibility: safeVisibility,
    orgId: safeOrgId,
    assignedMembers: safeAssignedMembers,
    stickyNotes: [],
    projectDeckOwnerId: safeVisibility === 'org' ? safeProjectDeckOwnerId : null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const ref = await admin.firestore().collection('boards').add(boardDoc);
  return { boardId: ref.id };
});

// ─── createOrganization (server-enforced limits) ────────────────────────────

exports.createOrganization = onCall({ maxInstances: 20, invoker: 'public' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to create an organization.');
  }

  const uid = request.auth.uid;
  const name = String(request.data?.name || '').trim();
  if (!name) {
    throw new HttpsError('invalid-argument', 'Organization name is required.');
  }

  const userData = await _getUserDoc(uid);
  const userPlan = _getPlanConfig(userData.billingPlan || DEFAULT_PLAN_KEY);
  const orgLimit = Number(userPlan.orgLimitCount || 0);
  if (orgLimit <= 0 || !userPlan.canUseOrg) {
    throw new HttpsError('permission-denied', `Your ${userPlan.key} plan cannot create organizations.`);
  }

  const ownedOrgIds = Array.isArray(userData.ownedOrgIds)
    ? userData.ownedOrgIds
    : (userData.ownedOrgId ? [userData.ownedOrgId] : []);

  if (ownedOrgIds.length >= orgLimit) {
    throw new HttpsError('resource-exhausted', `Your ${userPlan.key} plan allows up to ${orgLimit} organization(s).`);
  }

  if (userData.organizationId && !ownedOrgIds.includes(userData.organizationId)) {
    throw new HttpsError('failed-precondition', 'Leave your current organization before creating a new one.');
  }

  const orgRef = await admin.firestore().collection('organizations').add({
    name: name.slice(0, 60),
    ownerId: uid,
    members: [uid],
    admins: [uid],
    memberRoles: {
      [uid]: 'owner',
    },
    allowAiUsage: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  const nextOwnedOrgIds = [...ownedOrgIds, orgRef.id];
  await admin.firestore().collection('users').doc(uid).set({
    ownedOrgIds: nextOwnedOrgIds,
    organizationId: orgRef.id,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return { orgId: orgRef.id };
});

// ─── createStripeCheckoutSession ─────────────────────────────────────────────

exports.createStripeCheckoutSession = onCall({
  maxInstances: 10,
  invoker: 'public',
  secrets: [
    STRIPE_SECRET_KEY,
    STRIPE_PRICE_MID,
    STRIPE_PRICE_PRO,
    STRIPE_PRICE_BUSINESS_SMALL,
    STRIPE_PRICE_BUSINESS_GROWTH,
  ],
}, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'You must be signed in to start checkout.');
  }

  const { planKey, successUrl, cancelUrl } = request.data || {};
  if (typeof planKey !== 'string' || !planKey.trim()) {
    throw new HttpsError('invalid-argument', 'planKey is required.');
  }

  const priceIdMap = {
    mid: STRIPE_PRICE_MID.value(),
    pro: STRIPE_PRICE_PRO.value(),
    'business-small': STRIPE_PRICE_BUSINESS_SMALL.value(),
    'business-growth': STRIPE_PRICE_BUSINESS_GROWTH.value(),
  };
  const priceId = priceIdMap[planKey];
  if (!priceId) {
    throw new HttpsError('failed-precondition', `No Stripe price configured for plan: ${planKey}`);
  }

  const stripe = _getStripe();
  const userDoc = await admin.firestore().collection('users').doc(request.auth.uid).get();
  const email = userDoc.exists ? (userDoc.data().email || request.auth.token.email || undefined) : (request.auth.token.email || undefined);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: typeof successUrl === 'string' && successUrl ? successUrl : 'https://example.com',
    cancel_url: typeof cancelUrl === 'string' && cancelUrl ? cancelUrl : 'https://example.com',
    customer_email: email,
    metadata: {
      uid: request.auth.uid,
      planKey,
    },
  });

  return {
    url: session.url,
    id: session.id,
  };
});

// ─── setUserAsAdmin (admin-only function) ────────────────────────────────────

exports.setUserAsAdmin = onCall({
  maxInstances: 10,
  invoker: 'public',
}, async (request) => {
  const callerUid = request.auth?.uid;
  const { email } = request.data || {};

  if (!email || typeof email !== 'string') {
    throw new HttpsError('invalid-argument', 'email is required.');
  }

  // Verify caller is an admin (profile admin or bootstrap email)
  if (callerUid) {
    const callerEmail = request.auth?.token?.email;
    if (_isBootstrapAdminEmail(callerEmail)) {
      // Bootstrap admins can grant admin access before profile flags are set.
    } else {
    const callerDoc = await admin.firestore().collection('users').doc(callerUid).get();
    if (!callerDoc.exists || !callerDoc.data().isAdmin) {
      throw new HttpsError('permission-denied', 'Only admins can set other admins.');
    }
    }
  }

  // Find user by email
  const usersSnap = await admin.firestore()
    .collection('users')
    .where('email', '==', email.toLowerCase())
    .limit(1)
    .get();

  if (usersSnap.empty) {
    throw new HttpsError('not-found', `No user found with email: ${email}`);
  }

  const userDoc = usersSnap.docs[0];
  await userDoc.ref.update({ isAdmin: true });

  return {
    uid: userDoc.id,
    email: userDoc.data().email,
    isAdmin: true,
  };
});

// ─── Org membership helpers ───────────────────────────────────────────────────

async function _writeOrgActivity(orgId, type, actorUid, extra = {}) {
  try {
    await admin.firestore()
      .collection('organizations').doc(orgId)
      .collection('activityLog').add({
        type,
        actorUid,
        ...extra,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn('_writeOrgActivity failed:', err.message);
  }
}

async function _createNotification(uid, { type, title, body, ...extra }) {
  const { dedupeKey, ...payloadExtra } = extra || {};
  const payload = {
    type,
    title,
    body,
    read: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    ...payloadExtra,
  };

  try {
    const itemsRef = admin.firestore()
      .collection('notifications').doc(uid)
      .collection('items');

    if (dedupeKey) {
      await itemsRef.doc(String(dedupeKey)).create(payload);
      return;
    }

    await itemsRef.add(payload);
  } catch (err) {
    const code = String(err?.code || '');
    if (code === 'already-exists' || code === '6') return;
    console.warn('_createNotification failed:', err.message);
  }
}

function _toYmd(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function _addDaysYmd(ymd, days) {
  const dt = new Date(`${ymd}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + Number(days || 0));
  return _toYmd(dt);
}

function _daysBetweenYmd(fromYmd, toYmd) {
  const from = new Date(`${fromYmd}T00:00:00Z`);
  const to = new Date(`${toYmd}T00:00:00Z`);
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

function _safeNotifId(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 180);
}

function _dueRecipients(cardData = {}, boardData = {}) {
  const recipients = new Set();
  const assignees = Array.isArray(cardData.assignees) ? cardData.assignees : [];
  assignees.filter(Boolean).forEach((uid) => recipients.add(uid));

  if (recipients.size === 0 && boardData?.userId) {
    recipients.add(boardData.userId);
  }

  return [...recipients];
}

exports.notifyDueDateReminders = onSchedule(
  {
    schedule: 'every day 07:00',
    timeZone: 'Etc/UTC',
    maxInstances: 1,
  },
  async () => {
    const todayYmd = _toYmd(new Date());
    const upcomingEndYmd = _addDaysYmd(todayYmd, 3);

    const cardsSnap = await admin.firestore().collection('cards')
      .where('completed', '==', false)
      .where('dueDate', '>=', todayYmd)
      .where('dueDate', '<=', upcomingEndYmd)
      .get();

    const boardCache = new Map();
    let processedCards = 0;

    for (const cardDoc of cardsSnap.docs) {
      const card = cardDoc.data() || {};
      const dueDate = String(card.dueDate || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) continue;

      const daysUntil = _daysBetweenYmd(todayYmd, dueDate);
      const notifType = daysUntil === 0 ? 'due_today' : (daysUntil > 0 && daysUntil <= 3 ? 'due_upcoming' : null);
      if (!notifType) continue;

      let board = null;
      const boardId = String(card.boardId || '');
      if (boardId) {
        if (boardCache.has(boardId)) {
          board = boardCache.get(boardId);
        } else {
          const boardSnap = await admin.firestore().collection('boards').doc(boardId).get();
          board = boardSnap.exists ? (boardSnap.data() || {}) : null;
          boardCache.set(boardId, board);
        }
      }

      const recipients = _dueRecipients(card, board || {});
      if (recipients.length === 0) continue;

      const safeTitle = String(card.title || 'Task').slice(0, 160);
      const boardName = String(board?.title || '').slice(0, 120);

      const title = notifType === 'due_today' ? 'Task due today' : 'Upcoming task due';
      const body = notifType === 'due_today'
        ? `"${safeTitle}" is due today${boardName ? ` in ${boardName}` : ''}.`
        : `"${safeTitle}" is due in ${daysUntil} day${daysUntil === 1 ? '' : 's'} (${dueDate})${boardName ? ` in ${boardName}` : ''}.`;

      await Promise.all(recipients.map((uid) => {
        const dedupeKey = _safeNotifId(`due_${notifType}_${uid}_${cardDoc.id}_${dueDate}`);
        return _createNotification(uid, {
          type: notifType,
          title,
          body,
          boardId: boardId || null,
          cardId: cardDoc.id,
          dueDate,
          orgId: board?.orgId || null,
          dedupeKey,
        });
      }));

      processedCards += 1;
    }

    return { ok: true, date: todayYmd, processedCards };
  },
);

// ─── addOrgMember ─────────────────────────────────────────────────────────────

exports.addOrgMember = onCall({ maxInstances: 20, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const uid = request.auth.uid;
  const { orgId, username } = request.data || {};

  if (!orgId || typeof orgId !== 'string') throw new HttpsError('invalid-argument', 'orgId required.');
  if (!username || typeof username !== 'string') throw new HttpsError('invalid-argument', 'username required.');

  const orgSnap = await admin.firestore().collection('organizations').doc(orgId).get();
  if (!orgSnap.exists) throw new HttpsError('not-found', 'Organization not found.');
  const orgData = orgSnap.data();

  const admins = Array.isArray(orgData.admins) ? orgData.admins : [];
  if (orgData.ownerId !== uid && !admins.includes(uid)) {
    throw new HttpsError('permission-denied', 'Only org owners and admins can add members.');
  }

  const usernameSnap = await admin.firestore().collection('usernames').doc(username.toLowerCase()).get();
  if (!usernameSnap.exists) throw new HttpsError('not-found', `No user found with username "@${username}".`);
  const targetUid = usernameSnap.data().uid;

  const members = Array.isArray(orgData.members) ? orgData.members : [];
  if (members.includes(targetUid)) {
    throw new HttpsError('already-exists', `@${username} is already a member of this organization.`);
  }

  const ownerData = await _getUserDoc(orgData.ownerId);
  const ownerPlan = _getPlanConfig(ownerData.billingPlan || DEFAULT_PLAN_KEY);
  const seatLimit = Number(ownerPlan.orgSeatLimit || 0);
  if (seatLimit > 0 && members.length >= seatLimit) {
    throw new HttpsError('resource-exhausted', `Seat limit reached (${seatLimit} for ${ownerPlan.key} plan).`);
  }

  const targetUserData = await _getUserDoc(targetUid);
  if (targetUserData.organizationId && targetUserData.organizationId !== orgId) {
    throw new HttpsError('failed-precondition', `@${username} is already a member of another organization.`);
  }

  await admin.firestore().collection('organizations').doc(orgId).update({
    members: admin.firestore.FieldValue.arrayUnion(targetUid),
    [`memberRoles.${targetUid}`]: 'collaborator',
  });
  await admin.firestore().collection('users').doc(targetUid).update({
    organizationId: orgId,
  });

  await _writeOrgActivity(orgId, 'member_added', uid, {
    targetUid,
    targetUsername: username.toLowerCase(),
    role: 'collaborator',
  });

  await _createNotification(targetUid, {
    type: 'org_added',
    title: 'Added to organization',
    body: `You were added to "${orgData.name || 'an organization'}".`,
    orgId,
    orgName: orgData.name || '',
  });

  const targetProfile = await admin.firestore().collection('users').doc(targetUid).get();
  return {
    uid: targetUid,
    username: username.toLowerCase(),
    displayName: targetProfile.exists ? (targetProfile.data().displayName || '') : '',
  };
});

// ─── removeOrgMember ─────────────────────────────────────────────────────────

exports.removeOrgMember = onCall({ maxInstances: 20, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const uid = request.auth.uid;
  const { orgId, targetUid } = request.data || {};

  if (!orgId || typeof orgId !== 'string') throw new HttpsError('invalid-argument', 'orgId required.');
  if (!targetUid || typeof targetUid !== 'string') throw new HttpsError('invalid-argument', 'targetUid required.');

  const orgSnap = await admin.firestore().collection('organizations').doc(orgId).get();
  if (!orgSnap.exists) throw new HttpsError('not-found', 'Organization not found.');
  const orgData = orgSnap.data();

  if (orgData.ownerId === targetUid) {
    throw new HttpsError('permission-denied', 'Cannot remove the organization owner.');
  }

  const admins = Array.isArray(orgData.admins) ? orgData.admins : [];
  if (orgData.ownerId !== uid && !admins.includes(uid)) {
    throw new HttpsError('permission-denied', 'Only org owners and admins can remove members.');
  }

  await admin.firestore().collection('organizations').doc(orgId).update({
    members: admin.firestore.FieldValue.arrayRemove(targetUid),
    admins: admin.firestore.FieldValue.arrayRemove(targetUid),
    [`memberRoles.${targetUid}`]: admin.firestore.FieldValue.delete(),
  });
  await admin.firestore().collection('users').doc(targetUid).update({
    organizationId: null,
  });

  // Transfer any org boards owned by the leaving member to the org owner (#3 org-owned boards)
  try {
    const orgBoardsSnap = await admin.firestore()
      .collection('boards')
      .where('orgId', '==', orgId)
      .where('userId', '==', targetUid)
      .get();
    const batch = admin.firestore().batch();
    orgBoardsSnap.docs.forEach((boardDoc) => {
      batch.update(boardDoc.ref, { userId: orgData.ownerId });
    });
    if (!orgBoardsSnap.empty) await batch.commit();
  } catch (err) {
    console.warn('removeOrgMember: board transfer failed:', err.message);
  }

  await _writeOrgActivity(orgId, 'member_removed', uid, { targetUid });

  await _createNotification(targetUid, {
    type: 'org_removed',
    title: 'Removed from organization',
    body: `You were removed from "${orgData.name || 'an organization'}".`,
    orgId,
    orgName: orgData.name || '',
  });

  return { success: true };
});

// ─── setOrgMemberRole ─────────────────────────────────────────────────────────

exports.setOrgMemberRole = onCall({ maxInstances: 20, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const uid = request.auth.uid;
  const { orgId, targetUid, role } = request.data || {};

  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
  if (!targetUid) throw new HttpsError('invalid-argument', 'targetUid required.');

  const normalizedRole = String(role || '').toLowerCase();
  if (!['admin', 'collaborator', 'read-only'].includes(normalizedRole)) {
    throw new HttpsError('invalid-argument', 'role must be admin, collaborator, or read-only.');
  }

  const orgSnap = await admin.firestore().collection('organizations').doc(orgId).get();
  if (!orgSnap.exists) throw new HttpsError('not-found', 'Organization not found.');
  const orgData = orgSnap.data();

  if (orgData.ownerId === targetUid) {
    throw new HttpsError('permission-denied', 'Cannot change the owner\'s role.');
  }

  const admins = Array.isArray(orgData.admins) ? orgData.admins : [];
  if (orgData.ownerId !== uid && !admins.includes(uid)) {
    throw new HttpsError('permission-denied', 'Only org owners and admins can change member roles.');
  }

  const members = Array.isArray(orgData.members) ? orgData.members : [];
  if (!members.includes(targetUid)) {
    throw new HttpsError('not-found', 'User is not a member of this organization.');
  }

  const roleMap = (orgData.memberRoles && typeof orgData.memberRoles === 'object') ? orgData.memberRoles : {};
  const oldRole = orgData.ownerId === targetUid
    ? 'owner'
    : (String(roleMap[targetUid] || '').toLowerCase() || (admins.includes(targetUid) ? 'admin' : 'collaborator'));

  const newAdmins = normalizedRole === 'admin'
    ? [...new Set([...admins, targetUid])]
    : admins.filter((id) => id !== targetUid);

  await admin.firestore().collection('organizations').doc(orgId).update({
    admins: newAdmins,
    [`memberRoles.${targetUid}`]: normalizedRole,
  });

  await _writeOrgActivity(orgId, 'role_changed', uid, {
    targetUid,
    oldRole,
    newRole: normalizedRole,
    role: normalizedRole,
  });

  return { success: true };
});

// ─── transferOrgOwnership ─────────────────────────────────────────────────────

exports.transferOrgOwnership = onCall({ maxInstances: 20, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const uid = request.auth.uid;
  const { orgId, newOwnerUid } = request.data || {};

  if (!orgId || typeof orgId !== 'string') throw new HttpsError('invalid-argument', 'orgId required.');
  if (!newOwnerUid || typeof newOwnerUid !== 'string') throw new HttpsError('invalid-argument', 'newOwnerUid required.');

  const orgRef = admin.firestore().collection('organizations').doc(orgId);
  const orgSnap = await orgRef.get();
  if (!orgSnap.exists) throw new HttpsError('not-found', 'Organization not found.');
  const orgData = orgSnap.data() || {};

  if (orgData.ownerId !== uid) {
    throw new HttpsError('permission-denied', 'Only the current owner can transfer ownership.');
  }
  if (newOwnerUid === uid) {
    throw new HttpsError('invalid-argument', 'New owner must be a different member.');
  }

  const members = Array.isArray(orgData.members) ? orgData.members : [];
  if (!members.includes(newOwnerUid)) {
    throw new HttpsError('failed-precondition', 'New owner must already be a member of this organization.');
  }

  const newOwnerData = await _getUserDoc(newOwnerUid);
  const newOwnerPlan = _getPlanConfig(newOwnerData.billingPlan || DEFAULT_PLAN_KEY);
  const newOwnerOrgLimit = Number(newOwnerPlan.orgLimitCount || 0);
  if (newOwnerOrgLimit <= 0 || !newOwnerPlan.canUseOrg) {
    throw new HttpsError('failed-precondition', `@${newOwnerData.username || newOwnerUid} cannot own organizations on plan ${newOwnerPlan.key}.`);
  }

  const newOwnerOwnedOrgIds = Array.isArray(newOwnerData.ownedOrgIds)
    ? newOwnerData.ownedOrgIds
    : (newOwnerData.ownedOrgId ? [newOwnerData.ownedOrgId] : []);
  if (!newOwnerOwnedOrgIds.includes(orgId) && newOwnerOwnedOrgIds.length >= newOwnerOrgLimit) {
    throw new HttpsError('resource-exhausted', `New owner has reached their organization limit (${newOwnerOrgLimit}).`);
  }

  const currentOwnerData = await _getUserDoc(uid);
  const currentOwnerOwnedOrgIds = Array.isArray(currentOwnerData.ownedOrgIds)
    ? currentOwnerData.ownedOrgIds
    : (currentOwnerData.ownedOrgId ? [currentOwnerData.ownedOrgId] : []);

  const admins = Array.isArray(orgData.admins) ? orgData.admins : [];
  const nextAdmins = [...new Set([...admins, uid, newOwnerUid])];

  await orgRef.update({
    ownerId: newOwnerUid,
    admins: nextAdmins,
    [`memberRoles.${newOwnerUid}`]: 'owner',
    [`memberRoles.${uid}`]: 'admin',
  });

  const nextNewOwnerOwnedOrgIds = newOwnerOwnedOrgIds.includes(orgId)
    ? newOwnerOwnedOrgIds
    : [...newOwnerOwnedOrgIds, orgId];
  await admin.firestore().collection('users').doc(newOwnerUid).set({
    ownedOrgIds: nextNewOwnerOwnedOrgIds,
    organizationId: newOwnerData.organizationId || orgId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  const nextCurrentOwnerOwnedOrgIds = currentOwnerOwnedOrgIds.filter((id) => id !== orgId);
  await admin.firestore().collection('users').doc(uid).set({
    ownedOrgIds: nextCurrentOwnerOwnedOrgIds,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  await _writeOrgActivity(orgId, 'owner_transferred', uid, {
    previousOwnerUid: uid,
    targetUid: newOwnerUid,
  });

  await _createNotification(newOwnerUid, {
    type: 'org_owner_transferred',
    title: 'Organization ownership transferred',
    body: `You are now the owner of "${orgData.name || 'this organization'}".`,
    orgId,
    orgName: orgData.name || '',
  });

  return { success: true };
});

// ─── createOrgInvite ─────────────────────────────────────────────────────────

exports.createOrgInvite = onCall({ maxInstances: 20, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const uid = request.auth.uid;
  const { orgId, email, role = 'collaborator' } = request.data || {};

  if (!orgId || typeof orgId !== 'string') throw new HttpsError('invalid-argument', 'orgId required.');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
    throw new HttpsError('invalid-argument', 'Valid email address required.');
  }

  const normalizedRole = String(role).toLowerCase();
  if (!['admin', 'collaborator', 'read-only'].includes(normalizedRole)) {
    throw new HttpsError('invalid-argument', 'Invalid role.');
  }

  const orgSnap = await admin.firestore().collection('organizations').doc(orgId).get();
  if (!orgSnap.exists) throw new HttpsError('not-found', 'Organization not found.');
  const orgData = orgSnap.data();

  const admins = Array.isArray(orgData.admins) ? orgData.admins : [];
  if (orgData.ownerId !== uid && !admins.includes(uid)) {
    throw new HttpsError('permission-denied', 'Only org owners and admins can create invites.');
  }

  const ownerData = await _getUserDoc(orgData.ownerId);
  const ownerPlan = _getPlanConfig(ownerData.billingPlan || DEFAULT_PLAN_KEY);
  const seatLimit = Number(ownerPlan.orgSeatLimit || 0);
  const members = Array.isArray(orgData.members) ? orgData.members : [];
  if (seatLimit > 0 && members.length >= seatLimit) {
    throw new HttpsError('resource-exhausted', `Seat limit reached (${seatLimit} for ${ownerPlan.key} plan).`);
  }

  const normalizedEmail = String(email).toLowerCase().trim();

  // Reuse existing pending invite if one exists
  const existingSnap = await admin.firestore()
    .collection('orgInvites')
    .where('orgId', '==', orgId)
    .where('email', '==', normalizedEmail)
    .where('status', '==', 'pending')
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    const existing = existingSnap.docs[0];
    return { inviteId: existing.id, token: existing.data().token };
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const inviterData = await _getUserDoc(uid);
  const inviteRef = await admin.firestore().collection('orgInvites').add({
    orgId,
    orgName: orgData.name || '',
    invitedBy: uid,
    invitedByName: inviterData.displayName || inviterData.email || '',
    email: normalizedEmail,
    role: normalizedRole,
    token,
    status: 'pending',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
  });

  await _writeOrgActivity(orgId, 'invite_sent', uid, { email: normalizedEmail, role: normalizedRole });

  return { inviteId: inviteRef.id, token };
});

// ─── getOrgInvitePreview ──────────────────────────────────────────────────────

exports.getOrgInvitePreview = onCall({ maxInstances: 20, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const { inviteId, token } = request.data || {};

  if (!inviteId || !token) throw new HttpsError('invalid-argument', 'inviteId and token required.');

  const inviteSnap = await admin.firestore().collection('orgInvites').doc(inviteId).get();
  if (!inviteSnap.exists) throw new HttpsError('not-found', 'Invite not found or has expired.');
  const invite = inviteSnap.data();

  if (invite.token !== token) throw new HttpsError('permission-denied', 'Invalid invite token.');
  if (invite.status !== 'pending') {
    throw new HttpsError('failed-precondition', `This invite has already been ${invite.status}.`);
  }

  const now = new Date();
  const expiresAt = invite.expiresAt?.toDate ? invite.expiresAt.toDate() : new Date(invite.expiresAt);
  if (now > expiresAt) {
    await inviteSnap.ref.update({ status: 'expired' });
    throw new HttpsError('deadline-exceeded', 'This invite has expired.');
  }

  return {
    orgId: invite.orgId,
    orgName: invite.orgName || '',
    role: invite.role || 'collaborator',
    inviterName: invite.invitedByName || '',
    expiresAt: expiresAt.toISOString(),
  };
});

// ─── acceptOrgInvite ─────────────────────────────────────────────────────────

exports.acceptOrgInvite = onCall({ maxInstances: 20, invoker: 'public' }, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const uid = request.auth.uid;
  const { inviteId, token } = request.data || {};

  if (!inviteId || !token) throw new HttpsError('invalid-argument', 'inviteId and token required.');

  const inviteSnap = await admin.firestore().collection('orgInvites').doc(inviteId).get();
  if (!inviteSnap.exists) throw new HttpsError('not-found', 'Invite not found.');
  const invite = inviteSnap.data();

  if (invite.token !== token) throw new HttpsError('permission-denied', 'Invalid invite token.');
  if (invite.status !== 'pending') {
    throw new HttpsError('failed-precondition', `This invite has already been ${invite.status}.`);
  }

  const now = new Date();
  const expiresAt = invite.expiresAt?.toDate ? invite.expiresAt.toDate() : new Date(invite.expiresAt);
  if (now > expiresAt) {
    await inviteSnap.ref.update({ status: 'expired' });
    throw new HttpsError('deadline-exceeded', 'This invite has expired.');
  }

  const orgSnap = await admin.firestore().collection('organizations').doc(invite.orgId).get();
  if (!orgSnap.exists) throw new HttpsError('not-found', 'Organization no longer exists.');
  const orgData = orgSnap.data();

  const members = Array.isArray(orgData.members) ? orgData.members : [];
  if (members.includes(uid)) {
    // Already a member — mark invite consumed and return success
    await inviteSnap.ref.update({ status: 'accepted', acceptedBy: uid, acceptedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { orgId: invite.orgId, orgName: invite.orgName || orgData.name };
  }

  const ownerData = await _getUserDoc(orgData.ownerId);
  const ownerPlan = _getPlanConfig(ownerData.billingPlan || DEFAULT_PLAN_KEY);
  const seatLimit = Number(ownerPlan.orgSeatLimit || 0);
  if (seatLimit > 0 && members.length >= seatLimit) {
    throw new HttpsError('resource-exhausted', 'Organization has reached its seat limit.');
  }

  const userData = await _getUserDoc(uid);
  if (userData.organizationId && userData.organizationId !== invite.orgId) {
    throw new HttpsError('failed-precondition', 'You are already a member of another organization. Leave it first.');
  }

  const updateData = {
    members: admin.firestore.FieldValue.arrayUnion(uid),
    [`memberRoles.${uid}`]: invite.role || 'collaborator',
  };
  if (invite.role === 'admin') {
    updateData.admins = admin.firestore.FieldValue.arrayUnion(uid);
  }

  await admin.firestore().collection('organizations').doc(invite.orgId).update(updateData);
  await admin.firestore().collection('users').doc(uid).update({ organizationId: invite.orgId });

  await inviteSnap.ref.update({
    status: 'accepted',
    acceptedBy: uid,
    acceptedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await _writeOrgActivity(invite.orgId, 'invite_accepted', uid, {
    email: invite.email,
    role: invite.role,
  });

  await _createNotification(orgData.ownerId, {
    type: 'invite_accepted',
    title: 'Invite accepted',
    body: `Someone accepted your invite to join "${orgData.name || 'your organization'}".`,
    orgId: invite.orgId,
    orgName: orgData.name || '',
  });

  return { orgId: invite.orgId, orgName: invite.orgName || orgData.name };
});
