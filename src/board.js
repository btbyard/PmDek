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

/**
 * Creates a new column block on the active board and persists it.
 * Used by the top "Create Card" action (deck-level column creation).
 *
 * @param {string} [title='New Column']
 * @returns {Promise<void>}
 */
export async function createColumnBlock(title = 'New Column') {
  const boardId = getBoardId();
  const rawTitle = (title || '').trim() || 'New Column';

  const existingColumns = [...document.querySelectorAll('.column')].map((col, index) => {
    const input = col.querySelector('.col-title-input');
    return {
      id: col.dataset.columnId,
      title: input?.value?.trim() || input?.dataset?.original || `Column ${index + 1}`,
      order: index,
    };
  });

  const existingIds = new Set(existingColumns.map((col) => col.id));
  let nextId = _slugifyColumnId(rawTitle);
  let suffix = 2;
  while (existingIds.has(nextId)) {
    nextId = `${_slugifyColumnId(rawTitle)}-${suffix}`;
    suffix += 1;
  }

  const nextColumns = [
    ...existingColumns,
    {
      id: nextId,
      title: rawTitle,
      order: existingColumns.length,
    },
  ];

  await saveColumns(boardId, nextColumns);

  const boardTitle = document.getElementById('board-title-display')?.textContent?.trim() || 'Deck';
  renderBoard({ id: boardId, title: boardTitle, columns: nextColumns });
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

  // ── Add-column "+" button ────────────────────────────────────────────────
  const addColBtn = document.createElement('button');
  addColBtn.className = [
    'add-column-btn flex-shrink-0 self-start w-10 h-10 mt-1',
    'flex items-center justify-center rounded-full',
    'border-2 border-dashed border-brand-500/40 hover:border-brand-400',
    'text-brand-500/60 hover:text-brand-400',
    'bg-transparent hover:bg-brand-500/10',
    'transition-all duration-150',
  ].join(' ');
  addColBtn.title = 'Add column';
  addColBtn.innerHTML = `
    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
    </svg>
  `;
  addColBtn.addEventListener('click', () => createColumnBlock());
  columnsWrapper.appendChild(addColBtn);

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
  el.className        = [
    'column relative flex flex-col w-72 flex-shrink-0 rounded-xl p-3',
    'bg-gradient-to-br from-[#17181c] via-[#0b0c0e] to-[#050506]',
    'border border-white/10 shadow-[0_14px_30px_rgba(0,0,0,0.28)]',
  ].join(' ');
  el.dataset.columnId = col.id;
  el.draggable        = true;   // columns are drag-reorderable

  el.innerHTML = `
    <div class="col-header flex items-center gap-1 mb-3">
      <input
        class="col-title-input min-w-0 flex-1 text-sm font-semibold text-white/90 uppercase tracking-wide
               bg-transparent border-none outline-none rounded px-1 -mx-1
               focus:bg-black/30 focus:text-white
               focus:ring-1 focus:ring-brand-400 transition-all cursor-pointer"
        value="${escapeHtml(col.title)}"
        maxlength="50"
        aria-label="Column title"
        data-original="${escapeHtml(col.title)}"
      />
      <span class="card-count text-xs text-white/50 font-medium ml-auto flex-shrink-0">0</span>
      <button
        class="delete-col-btn flex-shrink-0 w-5 h-5 flex items-center justify-center rounded
               text-white/20 hover:text-red-300 hover:bg-red-500/10 transition-colors opacity-0"
        data-column-id="${col.id}"
        title="Delete column"
      >
        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
      </button>
    </div>
    <div class="card-list flex flex-col gap-2 min-h-[2rem]" data-column-id="${col.id}"></div>
    <button
      class="add-card-btn mt-3 flex items-center gap-1 text-sm text-white/55 hover:text-brand-100 transition-colors"
      data-column-id="${col.id}"
    >
      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
      </svg>
      Add task
    </button>
    <div class="col-resize-handle" title="Drag to resize column"></div>
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

  // Show/hide delete button on column hover
  const header = el.querySelector('.col-header');
  const delBtn = el.querySelector('.delete-col-btn');
  el.addEventListener('mouseenter', () => delBtn.classList.remove('opacity-0'));
  el.addEventListener('mouseleave', () => delBtn.classList.add('opacity-0'));
  delBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  delBtn.addEventListener('click', async () => {
    const cardCount = el.querySelectorAll('.card').length;
    const msg = cardCount > 0
      ? `Delete "${col.title}" and its ${cardCount} task${cardCount !== 1 ? 's' : ''}?`
      : `Delete "${col.title}"?`;
    if (!confirm(msg)) return;
    const next = allColumns.filter((c) => c.id !== col.id);
    try {
      await saveColumns(boardId, next);
      renderBoard({ id: boardId, title: document.getElementById('board-title-display')?.textContent?.trim() || '', columns: next });
    } catch (err) {
      console.error('Delete column failed:', err);
    }
  });

  _initColumnResize(el, col.id);

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

function _slugifyColumnId(title) {
  return String(title)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'column';
}

// ─── Column resize ────────────────────────────────────────────────────────────

/**
 * Clears all saved column widths from localStorage and resets all column
 * elements to the default width (w-72 = 288px).
 */
export function resetColumnWidths() {
  document.querySelectorAll('#columns-wrapper .column').forEach((colEl) => {
    const id = colEl.dataset.columnId;
    if (id) localStorage.removeItem(`colWidth:${id}`);
    colEl.style.width = '';
  });
}

/**
 * Attaches a right-edge drag handle to resize column width.
 * Width is saved to localStorage so it persists across page reloads.
 *
 * @param {HTMLElement} colEl
 * @param {string} columnId
 */
function _initColumnResize(colEl, columnId) {
  const handle = colEl.querySelector('.col-resize-handle');
  if (!handle) return;

  // Restore saved width
  const saved = localStorage.getItem(`colWidth:${columnId}`);
  if (saved) {
    const w = parseInt(saved, 10);
    if (w >= 200 && w <= 700) colEl.style.width = `${w}px`;
  }

  handle.addEventListener('mousedown', (downEvent) => {
    downEvent.preventDefault();
    downEvent.stopPropagation();
    colEl.draggable = false;

    const startX     = downEvent.clientX;
    const startWidth = colEl.getBoundingClientRect().width;

    const onMove = (e) => {
      const next = Math.max(200, Math.min(700, Math.round(startWidth + e.clientX - startX)));
      colEl.style.width = `${next}px`;
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      colEl.draggable = true;
      const w = Math.round(colEl.getBoundingClientRect().width);
      localStorage.setItem(`colWidth:${columnId}`, w);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
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
    _clearColDropIndicator();
    dragSrc = null;
  });

  wrapper.addEventListener('dragover', (e) => {
    const col = e.target.closest('.column');
    if (!col || col === dragSrc || !dragSrc) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    _clearColDropIndicator();
    const cols   = [...wrapper.querySelectorAll('.column')];
    const srcIdx = cols.indexOf(dragSrc);
    const tgtIdx = cols.indexOf(col);
    const indicator = _createColDropIndicator();
    if (srcIdx < tgtIdx) {
      col.after(indicator);
    } else {
      col.before(indicator);
    }
  });

  wrapper.addEventListener('dragleave', (e) => {
    if (!wrapper.contains(e.relatedTarget)) _clearColDropIndicator();
  });

  wrapper.addEventListener('drop', async (e) => {
    e.preventDefault();
    const col = e.target.closest('.column');
    if (!col || col === dragSrc || !dragSrc) return;

    col.classList.remove('col-drag-over');
    _clearColDropIndicator();

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

  function _createColDropIndicator() {
    const el = document.createElement('div');
    el.className = 'col-drop-indicator w-0.5 self-stretch bg-brand-500 rounded flex-shrink-0';
    el.style.minHeight = '60px';
    return el;
  }

  function _clearColDropIndicator() {
    wrapper.querySelectorAll('.col-drop-indicator').forEach((el) => el.remove());
  }
}

