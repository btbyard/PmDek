/**
 * @module board
 * @description
 * Manages the user's board document in Firestore and renders the column
 * skeleton in the DOM.
 *
 * Responsibilities:
 *  - Create the board document on first login (idempotent)
 *  - Expose the boardId to other modules
 *  - Render the three column containers that cards.js populates
 *
 * Design decision: columns are stored as an array inside the board document
 * rather than a subcollection. For v1's fixed three columns this avoids
 * extra reads and keeps onboarding simple. Column IDs are stable slugs so
 * cards can reference them without worrying about document IDs.
 */

import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  getDocs,
  serverTimestamp,
} from 'firebase/firestore';

import { db } from './firebase.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default columns created with every new board. Order value drives left-to-right display. */
export const DEFAULT_COLUMNS = [
  { id: 'todo',        title: 'Todo',        order: 0 },
  { id: 'in-progress', title: 'In Progress', order: 1 },
  { id: 'done',        title: 'Done',        order: 2 },
];

// Module-level cache — set once after board is loaded, read by cards.js.
let _boardId = null;

/**
 * Returns the current user's boardId.
 * Throws if called before `ensureBoard` resolves.
 * @returns {string}
 */
export function getBoardId() {
  if (!_boardId) throw new Error('Board not initialised. Call setBoardId() first.');
  return _boardId;
}

/**
 * Sets the active board ID. Called when the user opens a board.
 * @param {string} id
 */
export function setBoardId(id) {
  _boardId = id;
}

// ─── Firestore helpers ───────────────────────────────────────────────────────

/**
 * Creates a new board for the given user and returns its ID.
 *
 * Boards now use auto-generated Firestore IDs so a user can have multiple.
 *
 * @param {import('firebase/auth').User} user
 * @param {string} [title='My Board']
 * @returns {Promise<string>} boardId
 */
export async function createBoard(user, title = 'My Board', columns = DEFAULT_COLUMNS) {
  const ref = await addDoc(collection(db, 'boards'), {
    userId:    user.uid,
    title:     title.trim() || 'My Board',
    columns:   columns,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

/**
 * Fetches all boards belonging to the given user, ordered by creation time.
 *
 * @param {string} userId
 * @returns {Promise<Array<{id: string, title: string, columns: Array}>>}
 */
export async function getUserBoards(userId) {
  const q    = query(collection(db, 'boards'), where('userId', '==', userId));
  const snap = await getDocs(q);
  const boards = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  boards.sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));
  return boards;
}

/**
 * Renames a board document.
 * @param {string} boardId
 * @param {string} newTitle
 * @returns {Promise<void>}
 */
export async function renameBoard(boardId, newTitle) {
  await updateDoc(doc(db, 'boards', boardId), { title: newTitle.trim() || 'My Board' });
}

/**
 * Saves updated column titles back to the board document.
 * Columns are an embedded array so this replaces the whole array.
 * @param {string} boardId
 * @param {Array<{id: string, title: string, order: number}>} columns
 * @returns {Promise<void>}
 */
export async function saveColumns(boardId, columns) {
  await updateDoc(doc(db, 'boards', boardId), { columns });
}

/**
 * Deletes a board document. Cards are not automatically deleted (handled by
 * Firestore rules / a Cloud Function in a future version).
 * @param {string} boardId
 * @returns {Promise<void>}
 */
export async function deleteBoard(boardId) {
  await deleteDoc(doc(db, 'boards', boardId));
}

// ─── DOM rendering ───────────────────────────────────────────────────────────

/**
 * Renders the board skeleton: header + column containers.
 * Accepts the full board object so saved column titles are respected.
 *
 * @param {{ id: string, title: string, columns: Array }} board
 */
export function renderBoard(board) {
  const boardRoot = document.getElementById('board-root');
  boardRoot.innerHTML = '';

  const columns = (board.columns && board.columns.length)
    ? [...board.columns].sort((a, b) => a.order - b.order)
    : DEFAULT_COLUMNS;

  // Centered scrollable columns wrapper
  const columnsWrapper = document.createElement('div');
  columnsWrapper.className = 'flex gap-4 items-start justify-center overflow-x-auto pb-4 px-4';
  columnsWrapper.id = 'columns-wrapper';

  columns.forEach((col) => {
    columnsWrapper.appendChild(buildColumnEl(col, board.id, columns));
  });

  boardRoot.appendChild(columnsWrapper);
  _initColumnDrag(board.id, columns);
}

/**
 * Builds a single column DOM element with an inline-editable title.
 *
 * @param {{ id: string, title: string, order: number }} col
 * @param {string} boardId
 * @param {Array} allColumns  Full columns array, needed when saving a rename
 * @returns {HTMLElement}
 */
function buildColumnEl(col, boardId, allColumns) {
  const el = document.createElement('div');
  el.className        = 'column flex flex-col w-72 flex-shrink-0 bg-gray-100 rounded-xl p-3';
  el.dataset.columnId = col.id;
  el.draggable        = true;   // columns are drag-reorderable

  el.innerHTML = `
    <div class="col-header flex items-center gap-1 mb-3">
      <input
        class="col-title-input flex-1 text-sm font-semibold text-gray-600 uppercase tracking-wide
               bg-transparent border-none outline-none focus:bg-white focus:rounded focus:px-1
               focus:ring-1 focus:ring-brand-400 transition-all cursor-pointer"
        value="${escapeHtml(col.title)}"
        maxlength="50"
        aria-label="Column title"
        data-original="${escapeHtml(col.title)}"
      />
      <span class="card-count text-xs text-gray-400 font-medium ml-auto flex-shrink-0">0</span>
    </div>
    <div class="card-list flex flex-col gap-2 min-h-[2rem]" data-column-id="${col.id}"></div>
    <button
      class="add-card-btn mt-3 flex items-center gap-1 text-sm text-gray-400 hover:text-brand-600 transition-colors"
      data-column-id="${col.id}"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
      </svg>
      Add card
    </button>
  `;

  // ── Inline column rename ─────────────────────────────────────────────────
  const input = el.querySelector('.col-title-input');

  const saveTitle = async () => {
    const newTitle = input.value.trim();
    if (!newTitle) { input.value = input.dataset.original; return; }
    if (newTitle === input.dataset.original) return;
    input.dataset.original = newTitle;
    // Mutate the shared columns array and persist
    const target = allColumns.find((c) => c.id === col.id);
    if (target) target.title = newTitle;
    try {
      await saveColumns(boardId, allColumns);
    } catch (err) {
      console.error('Failed to save column title:', err);
    }
  };

  input.addEventListener('blur', saveTitle);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = input.dataset.original; input.blur(); }
  });

  // Stop column drag when user is typing in the title input
  input.addEventListener('mousedown', (e) => e.stopPropagation());

  return el;
}

/**
 * Updates the card count badge on a column.
 * @param {string} columnId
 * @param {number} count
 */
export function updateColumnCount(columnId, count) {
  const col   = document.querySelector(`.column[data-column-id="${columnId}"]`);
  if (!col) return;
  const badge = col.querySelector('.card-count');
  if (badge) badge.textContent = count;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Minimal XSS guard for values rendered as innerHTML.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ─── Column drag-to-reorder ───────────────────────────────────────────────────

/**
 * Attaches HTML5 drag listeners to columns so the user can reorder them.
 * After a successful drop the new order is saved to Firestore.
 *
 * @param {string} boardId
 * @param {Array}  columns  The live mutable columns array (shared with buildColumnEl)
 */
function _initColumnDrag(boardId, columns) {
  const wrapper = document.getElementById('columns-wrapper');
  if (!wrapper) return;

  let dragSrc = null;

  wrapper.addEventListener('dragstart', (e) => {
    const col = e.target.closest('.column');
    if (!col) return;
    // Don't initiate a column drag when the user is interacting with a card
    if (e.target.closest('.card')) return;
    dragSrc = col;
    setTimeout(() => col.classList.add('opacity-40'), 0);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', col.dataset.columnId);
  });

  wrapper.addEventListener('dragend', () => {
    if (dragSrc) dragSrc.classList.remove('opacity-40');
    wrapper.querySelectorAll('.column').forEach((c) => c.classList.remove('col-drag-over'));
    dragSrc = null;
  });

  wrapper.addEventListener('dragover', (e) => {
    const col = e.target.closest('.column');
    if (!col || col === dragSrc || !dragSrc) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    wrapper.querySelectorAll('.column').forEach((c) => c.classList.remove('col-drag-over'));
    col.classList.add('col-drag-over', 'ring-2', 'ring-brand-400');
  });

  wrapper.addEventListener('dragleave', (e) => {
    const col = e.target.closest('.column');
    if (col) col.classList.remove('col-drag-over', 'ring-2', 'ring-brand-400');
  });

  wrapper.addEventListener('drop', async (e) => {
    e.preventDefault();
    const col = e.target.closest('.column');
    if (!col || col === dragSrc || !dragSrc) return;

    col.classList.remove('col-drag-over', 'ring-2', 'ring-brand-400');

    // Re-order DOM
    const cols   = [...wrapper.querySelectorAll('.column')];
    const srcIdx = cols.indexOf(dragSrc);
    const tgtIdx = cols.indexOf(col);

    if (srcIdx < tgtIdx) {
      wrapper.insertBefore(dragSrc, col.nextSibling);
    } else {
      wrapper.insertBefore(dragSrc, col);
    }

    // Rebuild order values and save
    const newOrder = [...wrapper.querySelectorAll('.column')].map((c, i) => c.dataset.columnId);
    newOrder.forEach((id, i) => {
      const entry = columns.find((c) => c.id === id);
      if (entry) entry.order = i;
    });

    try {
      await saveColumns(boardId, columns);
    } catch (err) {
      console.error('Failed to save column order:', err);
    }
  });
}

