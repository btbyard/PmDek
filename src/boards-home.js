/**
 * @module boards-home
 * @description
 * Renders the Boards home page — the first screen after sign-in.
 *
 * Tiles are styled as tall playing cards. Each card has a settings gear (⚙)
 * in the top-right that opens a rename modal. Clicking the card body opens the board.
 */

import { getUserBoards, createBoard, renameBoard, deleteBoard } from './board.js';
import { generateBoard }                           from './ai.js';

// Store the refresh callback so the rename modal can refresh the grid after saving.
let _onBoardOpen = null;
let _currentUser = null;

// ─── Public API ───────────────────────────────────────────────────────────────

export async function renderBoardsHome(user, onBoardOpen) {
  _currentUser = user;
  _onBoardOpen = onBoardOpen;

  const root = document.getElementById('boards-root');
  if (!root) return;

  root.innerHTML = `
    <div class="flex justify-center py-8">
      <div class="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"></div>
    </div>
  `;

  const boards = await getUserBoards(user.uid);
  _renderTiles(root, boards);
}

export function openCreateBoardModal(user, onCreated) {
  const modalRoot = document.getElementById('modal-root');

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <h3 class="text-lg font-semibold text-gray-800 mb-4">Create board</h3>
        <form id="create-board-form" class="flex flex-col gap-4">
          <input id="board-title-input" type="text" placeholder="Board name"
            required maxlength="100"
            class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500" />
          <div class="flex justify-end gap-2">
            <button type="button" id="create-board-cancel"
              class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">
              Cancel
            </button>
            <button type="submit"
              class="px-4 py-2 text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg transition-colors">
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  const form  = document.getElementById('create-board-form');
  const input = document.getElementById('board-title-input');
  input.focus();

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('create-board-cancel').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  let _submitting = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (_submitting) return;
    _submitting = true;
    const submitBtn = form.querySelector('[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    const title = input.value.trim() || 'My Board';
    try {
      const boardId = await createBoard(user, title);
      close();
      onCreated(boardId, title);
    } catch (err) {
      console.error('Create board failed:', err);
      _submitting = false;
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}

/**
 * Opens the AI board generation modal.
 * Prompts for a project description, calls the generateBoard Cloud Function,
 * then creates the board and navigates to it.
 *
 * @param {import('firebase/auth').User} user
 * @param {(boardId: string, board: object) => void} onCreated
 */
export function openAiBoardModal(user, onCreated) {
  const modalRoot = document.getElementById('modal-root');

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <div class="flex items-center gap-2 mb-1">
          <span class="text-lg">✨</span>
          <h3 class="text-lg font-semibold text-gray-800">Do it for me Gemini</h3>
        </div>
        <p class="text-sm text-gray-500 mb-4">Describe your project and AI will suggest a board name and columns.</p>
        <form id="ai-board-form" class="flex flex-col gap-4">
          <textarea
            id="ai-board-prompt"
            rows="3"
            placeholder="e.g. Mobile app for tracking personal finances"
            required
            maxlength="500"
            class="w-full rounded-lg border-gray-300 text-sm resize-none focus:ring-brand-500 focus:border-brand-500"
          ></textarea>
          <div id="ai-board-status" class="hidden text-sm text-brand-600 flex items-center gap-2">
            <div class="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin flex-shrink-0"></div>
            <span>Generating board…</span>
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" id="ai-board-cancel"
              class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">
              Cancel
            </button>
            <button type="submit" id="ai-board-submit"
              class="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white
                     bg-brand-500 hover:bg-brand-600 rounded-lg transition-colors">
              <span class="text-base leading-none">✨</span>
              Do it for me Gemini
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  const form       = document.getElementById('ai-board-form');
  const promptArea = document.getElementById('ai-board-prompt');
  const statusEl   = document.getElementById('ai-board-status');
  const submitBtn  = document.getElementById('ai-board-submit');
  promptArea.focus();

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('ai-board-cancel').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  let _submitting = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (_submitting) return;
    _submitting = true;

    submitBtn.disabled = true;
    statusEl.classList.remove('hidden');

    const prompt = promptArea.value.trim();
    try {
      const { title, columns } = await generateBoard(prompt);
      const boardObj = { title, columns };
      const boardId  = await createBoard(user, title, columns);
      close();
      onCreated(boardId, { id: boardId, ...boardObj });
    } catch (err) {
      console.error('AI board generation failed:', err);
      statusEl.innerHTML = `<span class="text-red-600">Something went wrong. Please try again.</span>`;
      _submitting = false;
      submitBtn.disabled = false;
    }
  });
}

// ─── Private rendering ────────────────────────────────────────────────────────

function _renderTiles(root, boards) {
  root.innerHTML = '';

  if (boards.length === 0) {
    root.innerHTML = `
      <div class="flex flex-col items-center justify-center py-20 text-center">
        <div class="text-5xl mb-4">📋</div>
        <p class="text-gray-500 text-sm">No boards yet.</p>
        <p class="text-gray-400 text-sm">Click <strong>Create board</strong> to get started.</p>
      </div>
    `;
    return;
  }

  const grid = document.createElement('div');
  // Playing-card grid: fixed width cards, wrap naturally
  grid.className = 'flex flex-wrap gap-5';

  boards.forEach((board) => {
    grid.appendChild(_buildCard(board));
  });

  root.appendChild(grid);
}

/**
 * Builds a tall playing-card style board tile.
 *
 * Structure:
 *  ┌──────────────────┐
 *  │  [color band]  ⚙ │  ← settings gear top-right
 *  │                  │
 *  │   Board Title    │
 *  │   N columns      │
 *  │                  │
 *  └──────────────────┘
 */
function _buildCard(board) {
  const wrapper = document.createElement('div');
  // Fixed playing-card proportions: 160px wide × 220px tall
  wrapper.className = 'relative group w-40 h-56 flex-shrink-0';

  const colCount = board.columns?.length ?? 3;

  // Clickable card body (opens board)
  const card = document.createElement('button');
  card.className = [
    'w-full h-full flex flex-col bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden',
    'hover:shadow-lg hover:-translate-y-1 hover:border-brand-400',
    'transition-all duration-150 text-left',
  ].join(' ');
  card.dataset.boardId = board.id;
  card.setAttribute('aria-label', `Open board: ${board.title}`);

  card.innerHTML = `
    <!-- Top colour band — decorative, like a playing card suit marker -->
    <div class="h-16 w-full bg-gradient-to-br from-brand-500 to-brand-700 flex-shrink-0 relative">
      <!-- Card suit pattern dots -->
      <div class="absolute inset-0 opacity-10"
           style="background-image: radial-gradient(circle, white 1px, transparent 1px); background-size: 12px 12px;">
      </div>
    </div>
    <!-- Card body -->
    <div class="flex-1 flex flex-col justify-end p-3 pb-4">
      <h2 class="text-sm font-semibold text-gray-800 group-hover:text-brand-600 transition-colors line-clamp-2 leading-snug">
        ${escapeHtml(board.title)}
      </h2>
      <p class="mt-1 text-xs text-gray-400">${colCount} column${colCount !== 1 ? 's' : ''}</p>
    </div>
  `;

  card.addEventListener('click', () => _onBoardOpen(board.id, board));

  // Settings gear (top-right of card, absolutely positioned over the colour band)
  const gear = document.createElement('button');
  gear.className = [
    'absolute top-2 right-2 z-10',
    'w-6 h-6 flex items-center justify-center rounded-full',
    'bg-white/20 hover:bg-white/40 text-white transition-colors',
    'opacity-0 group-hover:opacity-100',
  ].join(' ');
  gear.setAttribute('aria-label', 'Board settings');
  gear.innerHTML = `
    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94
           3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724
           1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572
           1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31
           -.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724
           1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/>
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
    </svg>
  `;

  gear.addEventListener('click', (e) => {
    e.stopPropagation();
    _openBoardSettingsMenu(e, board);
  });

  wrapper.appendChild(card);
  wrapper.appendChild(gear);
  return wrapper;
}

// ─── Settings dropdown ───────────────────────────────────────────────────────

/**
 * Shows a tiny positioned dropdown below the gear button with Rename / Delete.
 */
function _openBoardSettingsMenu(e, board) {
  // Remove any existing open menus
  document.querySelectorAll('.board-settings-menu').forEach((m) => m.remove());

  const btn  = e.currentTarget;
  const rect = btn.getBoundingClientRect();

  const menu = document.createElement('div');
  menu.className = [
    'board-settings-menu absolute z-50 right-0 mt-1 w-36',
    'bg-white rounded-xl shadow-lg border border-gray-100 py-1 text-sm',
  ].join(' ');
  // Position below the gear icon
  menu.style.top  = `${rect.bottom + window.scrollY + 4}px`;
  menu.style.left = `${rect.left   + window.scrollX - 96}px`;   // right-align
  menu.style.position = 'fixed';

  menu.innerHTML = `
    <button data-action="rename"
      class="w-full text-left px-4 py-2 hover:bg-gray-50 transition-colors flex items-center gap-2">
      <svg class="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5
             m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
      </svg>
      Rename
    </button>
    <div class="my-1 border-t border-gray-100"></div>
    <button data-action="delete"
      class="w-full text-left px-4 py-2 hover:bg-red-50 text-red-600 transition-colors flex items-center gap-2">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6
             m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
      </svg>
      Delete board
    </button>
  `;

  document.body.appendChild(menu);

  // Close on outside click
  const closeMenu = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('click', closeMenu, true);
    }
  };
  // Use capture so it fires before any other click handlers
  setTimeout(() => document.addEventListener('click', closeMenu, true), 0);

  menu.querySelector('[data-action="rename"]').addEventListener('click', () => {
    menu.remove();
    document.removeEventListener('click', closeMenu, true);
    _openRenameBoardModal(board);
  });

  menu.querySelector('[data-action="delete"]').addEventListener('click', () => {
    menu.remove();
    document.removeEventListener('click', closeMenu, true);
    _openDeleteBoardModal(board);
  });
}

// ─── Rename modal ─────────────────────────────────────────────────────────────

function _openRenameBoardModal(board) {
  const modalRoot = document.getElementById('modal-root');

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <h3 class="text-lg font-semibold text-gray-800 mb-4">Rename board</h3>
        <form id="rename-board-form" class="flex flex-col gap-4">
          <input id="rename-board-input" type="text"
            value="${escapeHtml(board.title)}"
            required maxlength="100"
            class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500" />
          <div class="flex justify-end gap-2">
            <button type="button" id="rename-board-cancel"
              class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">
              Cancel
            </button>
            <button type="submit"
              class="px-4 py-2 text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg transition-colors">
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  const form  = document.getElementById('rename-board-form');
  const input = document.getElementById('rename-board-input');
  input.focus();
  input.select();

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('rename-board-cancel').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newTitle = input.value.trim();
    if (!newTitle) return;
    try {
      await renameBoard(board.id, newTitle);
      close();
      await renderBoardsHome(_currentUser, _onBoardOpen);
    } catch (err) {
      console.error('Rename board failed:', err);
    }
  });
}

// ─── Delete confirmation modal ────────────────────────────────────────────────

function _openDeleteBoardModal(board) {
  const modalRoot = document.getElementById('modal-root');

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <div class="flex items-start gap-3 mb-4">
          <div class="flex-shrink-0 w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
            <svg class="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667
                   1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0
                   L3.34 16c-.77 1.333.192 3 1.732 3z"/>
            </svg>
          </div>
          <div>
            <h3 class="text-base font-semibold text-gray-900">Delete board?</h3>
            <p class="mt-1 text-sm text-gray-500">
              <strong>${escapeHtml(board.title)}</strong> will be permanently deleted.
              This cannot be undone.
            </p>
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <button id="delete-board-cancel"
            class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">
            Cancel
          </button>
          <button id="delete-board-confirm"
            class="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors">
            Delete
          </button>
        </div>
      </div>
    </div>
  `;

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('delete-board-cancel').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  document.getElementById('delete-board-confirm').addEventListener('click', async () => {
    try {
      await deleteBoard(board.id);
      close();
      await renderBoardsHome(_currentUser, _onBoardOpen);
    } catch (err) {
      console.error('Delete board failed:', err);
    }
  });
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

