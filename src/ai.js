/**
 * @module ai
 * @description
 * Client-side wrapper for AI Cloud Functions.
 *
 * All AI calls go through Firebase Cloud Functions — the Gemini API key
 * never touches the browser. This module provides a thin, typed API so
 * the rest of the app doesn't know or care which AI backend is used.
 *
 * Available functions (v0.1):
 *  - generateCard: natural language → { title, description }
 *
 * Adding new AI features:
 *  1. Add a new Cloud Function in functions/index.js
 *  2. Add a corresponding callable wrapper here
 *  3. Wire the UI in the relevant module
 */

import { httpsCallable } from 'firebase/functions';
import { functions }     from './firebase.js';
import { createCard }    from './cards.js';
import { getBoardId }    from './board.js';

// ─── Callable references ──────────────────────────────────────────────────────
// Instantiated once at module load — httpsCallable is cheap (no network call).

const _generateCardFn  = httpsCallable(functions, 'generateCard');
const _generateBoardFn = httpsCallable(functions, 'generateBoard');

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Calls the `generateCard` Cloud Function.
 *
 * Sends a natural language prompt and receives a structured card object.
 * The Cloud Function is responsible for prompt engineering and Gemini API
 * communication.
 *
 * @param {string} prompt  Free-text description, e.g. "Set up CI pipeline for main branch"
 * @returns {Promise<{ title: string, description: string }>}
 * @throws {Error} If the function call fails or returns unexpected data
 *
 * @example
 * const card = await generateCard('Add dark mode toggle to settings');
 * // { title: 'Add dark mode toggle', description: 'Implement a toggle...' }
 */
export async function generateCard(prompt) {
  if (!prompt?.trim()) throw new Error('Prompt must not be empty.');

  const result = await _generateCardFn({ prompt: prompt.trim() });

  const { title, description } = result.data;
  if (typeof title !== 'string' || !title) {
    throw new Error('generateCard: unexpected response shape from Cloud Function.');
  }

  return { title, description: description || '' };
}

/**
 * Calls the `generateBoard` Cloud Function.
 *
 * @param {string} prompt  Free-text project description
 * @returns {Promise<{ title: string, columns: Array }>}
 */
export async function generateBoard(prompt) {
  if (!prompt?.trim()) throw new Error('Prompt must not be empty.');
  const result = await _generateBoardFn({ prompt: prompt.trim() });
  const { title, columns } = result.data;
  if (typeof title !== 'string' || !title || !Array.isArray(columns)) {
    throw new Error('generateBoard: unexpected response shape from Cloud Function.');
  }
  return { title, columns };
}

// ─── UI helper ────────────────────────────────────────────────────────────────

/**
 * Opens the AI card generation modal.
 * On success, pre-fills the card creation form with the generated values.
 *
 * @param {string} columnId  Column to create the card in
 */
export function openAiModal(columnId) {
  const modalRoot = document.getElementById('modal-root');

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <div class="flex items-center gap-2 mb-1">
          <span class="text-lg">✨</span>
          <h3 class="text-lg font-semibold text-gray-800">Do it for me Gemini</h3>
        </div>
        <p class="text-sm text-gray-500 mb-4">Describe what needs to be done in plain English.</p>
        <form id="ai-form" class="flex flex-col gap-4">
          <textarea
            id="ai-prompt"
            class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500 resize-none"
            rows="3"
            placeholder="e.g. Set up automated tests for the login flow"
            maxlength="500"
            required
          ></textarea>
          <div id="ai-error" class="hidden text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2"></div>
          <div class="flex justify-end gap-2 pt-2">
            <button type="button" id="ai-cancel"
              class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">
              Cancel
            </button>
            <button type="submit" id="ai-submit"
              class="px-4 py-2 text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg transition-colors flex items-center gap-2">
              <span id="ai-btn-label">Do it for me Gemini</span>
              <svg id="ai-spinner" class="hidden w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
              </svg>
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  const form    = document.getElementById('ai-form');
  const prompt  = document.getElementById('ai-prompt');
  const errorEl = document.getElementById('ai-error');
  const spinner = document.getElementById('ai-spinner');
  const btnLabel= document.getElementById('ai-btn-label');

  prompt.focus();

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('ai-cancel').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = prompt.value.trim();
    if (!text) return;

    // Loading state
    btnLabel.textContent = 'Generating…';
    spinner.classList.remove('hidden');
    document.getElementById('ai-submit').disabled = true;
    errorEl.classList.add('hidden');

    try {
      const generated = await generateCard(text);
      close();

      getBoardId(); // ensure board is ready
      const listEl    = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
      const lastOrder = listEl?.children.length ?? 0;
      await createCard(columnId, generated.title, generated.description, lastOrder);
    } catch (err) {
      console.error('AI generation failed:', err);
      errorEl.textContent = 'Generation failed. Please try again.';
      errorEl.classList.remove('hidden');
      btnLabel.textContent = 'Do it for me Gemini';
      spinner.classList.add('hidden');
      document.getElementById('ai-submit').disabled = false;
    }
  });
}
