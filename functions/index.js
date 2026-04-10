/**
 * PMDek Cloud Functions
 *
 * Functions:
 *  - generateCard  : natural language prompt → { title, description }
 *  - generateBoard : project description → { title, columns }
 *
 * Uses the @google/genai SDK (v1.x) with gemini-2.0-flash.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { GoogleGenAI }        = require('@google/genai');

// ─── Shared helpers ───────────────────────────────────────────────────────────

function _getAI() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new HttpsError('internal', 'AI service is not configured.');
  return new GoogleGenAI({ apiKey: key });
}

const MODEL = 'gemini-2.0-flash';

function _stripFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

// ─── generateCard ─────────────────────────────────────────────────────────────

exports.generateCard = onCall({ maxInstances: 10 }, async (request) => {
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
Convert the user's task description into a concise Kanban card.
Respond with ONLY valid JSON matching this exact shape:
{
  "title": "Short, action-oriented title (max 80 chars)",
  "description": "One to three sentences of additional context (max 300 chars). Empty string if not needed."
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

exports.generateBoard = onCall({ maxInstances: 10 }, async (request) => {
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


// ─── Shared helpers ───────────────────────────────────────────────────────────

function _getGeminiModel() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new HttpsError('internal', 'AI service is not configured.');
  const genAI = new GoogleGenerativeAI(key);
  return genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
}

function _stripFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

// ─── generateCard ─────────────────────────────────────────────────────────────

/**
 * Firebase Callable Function: generateCard
 *
 * Accepts a natural language task description and returns a structured
 * Kanban card object using Gemini.
 *
 * Request:  { prompt: string }
 * Response: { title: string, description: string }
 *
 * Authentication is enforced — unauthenticated calls are rejected.
 * This prevents abuse of the Gemini API quota.
 */
exports.generateCard = onCall(
  {
    // Limit concurrency to keep costs predictable.
    maxInstances: 10,
  },
  async (request) => {
    // ── Auth guard ─────────────────────────────────────────────────────────
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'You must be signed in to use AI features.');
    }

    // ── Input validation ───────────────────────────────────────────────────
    const { prompt } = request.data;
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new HttpsError('invalid-argument', 'prompt must be a non-empty string.');
    }
    if (prompt.trim().length > 500) {
      throw new HttpsError('invalid-argument', 'prompt must be 500 characters or fewer.');
    }

    // ── Gemini call ────────────────────────────────────────────────────────
    const model = _getGeminiModel();

    const systemPrompt = `You are a project management assistant. 
Convert the user's task description into a concise Kanban card.
Respond with ONLY valid JSON matching this exact shape:
{
  "title": "Short, action-oriented title (max 80 chars)",
  "description": "One to three sentences of additional context (max 300 chars). Empty string if not needed."
}
Do not include markdown fences, comments, or any text outside the JSON object.`;

    const result  = await model.generateContent([systemPrompt, prompt.trim()]);
    const rawText = result.response.text();

    // ── Parse and validate response ────────────────────────────────────────
    let parsed;
    try {
      parsed = JSON.parse(_stripFences(rawText));
    } catch {
      console.error('generateCard: failed to parse Gemini response:', rawText);
      throw new HttpsError('internal', 'AI returned an unexpected response format.');
    }

    if (typeof parsed.title !== 'string' || !parsed.title.trim()) {
      throw new HttpsError('internal', 'AI returned a card without a title.');
    }

    return {
      title:       parsed.title.trim().slice(0, 80),
      description: (parsed.description || '').trim().slice(0, 300),
    };
  },
);

// ─── generateBoard ────────────────────────────────────────────────────────────

/**
 * Firebase Callable Function: generateBoard
 *
 * Accepts a project description and returns a board name + column list.
 *
 * Request:  { prompt: string }
 * Response: { title: string, columns: [{id, title, order}] }
 */
exports.generateBoard = onCall({ maxInstances: 10 }, async (request) => {
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

  const model = _getGeminiModel();

  const systemPrompt = `You are a project management assistant.
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
Do not include markdown fences or any text outside the JSON object.`;

  const result  = await model.generateContent([systemPrompt, prompt.trim()]);
  const rawText = result.response.text();

  let parsed;
  try {
    parsed = JSON.parse(_stripFences(rawText));
  } catch {
    console.error('generateBoard: failed to parse Gemini response:', rawText);
    throw new HttpsError('internal', 'AI returned an unexpected response format.');
  }

  if (typeof parsed.title !== 'string' || !parsed.title.trim()) {
    throw new HttpsError('internal', 'AI returned a board without a title.');
  }
  if (!Array.isArray(parsed.columns) || parsed.columns.length < 2) {
    throw new HttpsError('internal', 'AI returned an invalid columns array.');
  }

  // Sanitise each column
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
