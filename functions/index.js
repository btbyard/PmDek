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
const { defineSecret }       = require('firebase-functions/params');
const { GoogleGenAI }        = require('@google/genai');
const admin                  = require('firebase-admin');
const Stripe                 = require('stripe');

const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY');
const STRIPE_PRICE_MID = defineSecret('STRIPE_PRICE_MID');
const STRIPE_PRICE_PRO = defineSecret('STRIPE_PRICE_PRO');
const STRIPE_PRICE_BUSINESS_SMALL = defineSecret('STRIPE_PRICE_BUSINESS_SMALL');
const STRIPE_PRICE_BUSINESS_GROWTH = defineSecret('STRIPE_PRICE_BUSINESS_GROWTH');
const _BUILD = 4; // bump to force redeploy

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

function _stripFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
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
