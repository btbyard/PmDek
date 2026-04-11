/**
 * @module cards
 * @description
 * Full CRUD for Kanban cards: Firestore persistence + DOM rendering.
 *
 * Ordering strategy: float midpoint insertion.
 *  - Each card has an `order` (float). The list is sorted by this value.
 *  - Inserting between two cards: order = (prev.order + next.order) / 2
 *  - This means drag-drop only writes ONE document, not the entire column.
 *  - Precision degrades after many insertions in the same gap but is fine for v1.
 *
 * Real-time: a single onSnapshot query on the `cards` collection (filtered by
 * boardId) drives all column renders instead of per-column listeners. One
 * listener, one WebSocket connection.
 */

import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from 'firebase/firestore';

import { db }                 from './firebase.js';
import { storage }            from './firebase.js';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';

const CARD_COLORS = [
  { value: '#6366f1', label: 'Indigo' },
  { value: '#8b5cf6', label: 'Purple' },
  { value: '#ec4899', label: 'Pink' },
  { value: '#ef4444', label: 'Red' },
  { value: '#f97316', label: 'Orange' },
  { value: '#22c55e', label: 'Green' },
  { value: '#14b8a6', label: 'Teal' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#f59e0b', label: 'Amber' },
  { value: '#64748b', label: 'Slate' },
];
import { getBoardId }         from './board.js';
import { updateColumnCount }  from './board.js';
import { initDragAndDrop }    from './drag.js';

// ─── Real-time listener ───────────────────────────────────────────────────────

/** Holds the onSnapshot unsubscribe function. */
let _unsubscribeCards = null;

/** Last known snapshot of cards — used to re-render after a column change. */
let _lastCards = [];

/**
 * Starts a real-time listener on the cards collection for the active board.
 * Fires `renderCards` every time Firestore pushes an update.
 *
 * Call this once after the board is ready. Calling again would create a
 * duplicate listener — guard with `_unsubscribeCards`.
 */
export function subscribeToCards() {
  if (_unsubscribeCards) _unsubscribeCards();

  const boardId    = getBoardId();
  const cardsQuery = query(
    collection(db, 'cards'),
    where('boardId', '==', boardId),
    orderBy('order', 'asc'),
  );

  _unsubscribeCards = onSnapshot(cardsQuery, (snapshot) => {
    _lastCards = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAllCards(_lastCards);
  });
}

/** Tears down the cards listener (called on sign-out). */
export function unsubscribeFromCards() {
  if (_unsubscribeCards) {
    _unsubscribeCards();
    _unsubscribeCards = null;
  }
}

/**
 * Re-renders cards from the last known snapshot.
 * Call this after renderBoard() rebuilds the column shells so cards reappear.
 */
export function reRenderCards() {
  renderAllCards(_lastCards);
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/**
 * Creates a new card at the bottom of the given column.
 *
 * `order` is set to `(lastCard.order + 1)` — appending is the common case
 * and this avoids a round-trip to compute a midpoint.
 *
 * @param {string} columnId   Target column ('todo' | 'in-progress' | 'done')
 * @param {string} title
 * @param {string} [description='']
 * @param {number} [order=0]
 * @returns {Promise<string>} New card document ID
 */
export async function createCard(columnId, title, description = '', order = 0, checkable = false, subtasks = [], dueDate = null, attachments = [], cardColor = null) {
  const boardId = getBoardId();
  const ref = await addDoc(collection(db, 'cards'), {
    boardId,
    userId:      auth_uid(),
    columnId,
    title:       title.trim(),
    description: description.trim(),
    completed:   false,
    checkable,
    subtasks:    subtasks,
    dueDate:     dueDate || null,
    attachments: attachments,
    cardColor:   cardColor || null,
    order,
    cardHeight: 82,
    createdAt:   serverTimestamp(),
    updatedAt:   serverTimestamp(),
  });
  return ref.id;
}

/**
 * Updates mutable card fields. Only passes changed fields to Firestore.
 *
 * @param {string} cardId
 * @param {{ title?: string, description?: string, columnId?: string, order?: number }} updates
 * @returns {Promise<void>}
 */
export async function updateCard(cardId, updates) {
  const cardRef = doc(db, 'cards', cardId);
  await updateDoc(cardRef, {
    ...updates,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Permanently deletes a card.
 * @param {string} cardId
 * @returns {Promise<void>}
 */
export async function deleteCard(cardId) {
  await deleteDoc(doc(db, 'cards', cardId));
}

/**
 * Moves a card to a new column and/or position.
 * Computes float midpoint order from surrounding card orders.
 *
 * @param {string} cardId
 * @param {string} newColumnId
 * @param {number|null} prevOrder  Order of the card above, or null if top
 * @param {number|null} nextOrder  Order of the card below, or null if bottom
 * @returns {Promise<void>}
 */
export async function moveCard(cardId, newColumnId, prevOrder, nextOrder) {
  let newOrder;
  if (prevOrder === null && nextOrder === null) newOrder = 0;
  else if (prevOrder === null)                  newOrder = nextOrder - 1;
  else if (nextOrder === null)                  newOrder = prevOrder + 1;
  else                                          newOrder = (prevOrder + nextOrder) / 2;

  await updateCard(cardId, { columnId: newColumnId, order: newOrder });
}

// ─── DOM rendering ───────────────────────────────────────────────────────────

/**
 * Full render: clears all card lists then re-populates from the latest snapshot.
 * Called by the onSnapshot listener on every change.
 *
 * Grouped by columnId → sorted by order (query already sorts, this keeps
 * the mapping clean).
 *
 * @param {Array<Object>} cards
 */
function renderAllCards(cards) {
  // Group by column
  const byColumn = {};
  cards.forEach((card) => {
    if (!byColumn[card.columnId]) byColumn[card.columnId] = [];
    byColumn[card.columnId].push(card);
  });

  // Update each column list
  document.querySelectorAll('.card-list').forEach((listEl) => {
    const columnId = listEl.dataset.columnId;
    const colCards = byColumn[columnId] || [];

    listEl.innerHTML = '';
    colCards.forEach((card) => {
      listEl.appendChild(buildCardEl(card));
    });

    updateColumnCount(columnId, colCards.length);
  });

  // Re-init drag handles after every render
  initDragAndDrop();
}

/**
 * Builds the DOM element for a single card.
 * @param {{ id: string, title: string, description: string }} card
 * @returns {HTMLElement}
 */
function buildCardEl(card) {
  const el = document.createElement('div');
  const isCompleted = Boolean(card.completed);
  const subtasks = Array.isArray(card.subtasks) ? card.subtasks : [];
  const attachments = Array.isArray(card.attachments) ? card.attachments : [];
  const dueDate = card.dueDate || null;

  el.className      = [
    'card relative rounded-lg p-2.5 pb-8 cursor-grab active:cursor-grabbing',
    'border border-white/10 shadow-sm',
    'bg-gradient-to-br from-[#141518] via-[#0a0b0d] to-[#050506]',
    'text-white',
    isCompleted ? 'opacity-80' : '',
  ].join(' ');
  el.draggable      = true;
  el.dataset.cardId   = card.id;
  el.dataset.order    = String(card.order ?? 0);
  el.dataset.subtasks = JSON.stringify(subtasks);
  el.dataset.checkable = String(Boolean(card.checkable));
  el.dataset.dueDate  = dueDate || '';
  el.dataset.attachments = JSON.stringify(attachments);
  el.dataset.cardColor = card.cardColor || '';

  // Apply card accent color as a colored left border
  if (card.cardColor) {
    el.style.borderLeftColor = card.cardColor;
    el.style.borderLeftWidth = '3px';
    el.style.borderLeftStyle = 'solid';
  }

  // Due date badge
  let dueDateHtml = '';
  if (dueDate) {
    const today = new Date(); today.setHours(0,0,0,0);
    const due   = new Date(dueDate + 'T00:00:00');
    const isOverdue = !isCompleted && due < today;
    const isToday   = !isCompleted && due.getTime() === today.getTime();
    const label = due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const cls = isOverdue
      ? 'bg-red-500/20 text-red-300 border-red-500/30'
      : isToday
        ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
        : 'bg-white/10 text-white/50 border-white/15';
    dueDateHtml = `<span class="inline-flex items-center gap-1 text-[10px] border rounded px-1.5 py-0.5 ${cls}">
      <svg class="w-2.5 h-2.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/>
      </svg>${label}</span>`;
  }

  // Attachment badge
  let attachBadge = '';
  if (attachments.length) {
    attachBadge = `<span class="inline-flex items-center gap-1 text-[10px] border rounded px-1.5 py-0.5 bg-white/10 text-white/50 border-white/15">
      <svg class="w-2.5 h-2.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/>
      </svg>${attachments.length}</span>`;
  }

  const subtasksHtml = subtasks.map((task) => `
    <label class="flex items-center gap-2 text-[11px] text-white/60 mt-0.5 pl-5 border-l border-white/10 ml-1">
      <input
        type="checkbox"
        class="subtask-check flex-shrink-0 rounded border-white/30 bg-transparent text-brand-500 focus:ring-brand-400"
        data-card-id="${card.id}"
        data-subtask-id="${escapeHtml(task.id)}"
        ${task.completed ? 'checked' : ''}
      />
      <span class="${task.completed ? 'line-through text-white/35' : 'text-white/60'}">${escapeHtml(task.title)}</span>
    </label>
  `).join('');

  el.innerHTML = `
    <div class="flex items-start justify-between gap-2">
      <label class="flex items-start gap-2 flex-1 cursor-pointer">
        ${card.checkable ? `<input
          type="checkbox"
          class="task-check mt-0.5 rounded border-white/40 bg-transparent text-brand-500 focus:ring-brand-400"
          data-card-id="${card.id}"
          ${isCompleted ? 'checked' : ''}
        />` : ''}
        <p class="card-title text-sm font-medium leading-snug ${isCompleted ? 'line-through text-white/60' : 'text-white'}">${escapeHtml(card.title)}${subtasks.length ? `<span class="ml-1.5 text-[10px] font-normal text-white/40 align-middle">${subtasks.filter(t => t.completed).length}/${subtasks.length}</span>` : ''}</p>
      </label>
      <div class="card-actions flex-shrink-0 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button class="add-subtask-btn text-white/45 hover:text-brand-100 p-0.5 rounded" data-card-id="${card.id}" title="Add sub task">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
          </svg>
        </button>
        <button class="edit-card-btn text-white/45 hover:text-brand-100 p-0.5 rounded" data-card-id="${card.id}" title="Edit">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 012.828 0l.172.172a2 2 0 010 2.828L12 16H9v-3z"/>
          </svg>
        </button>
        <button class="delete-card-btn text-white/45 hover:text-red-300 p-0.5 rounded" data-card-id="${card.id}" title="Delete">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
    </div>
    ${card.description ? `<p class="card-desc mt-1 text-xs text-white/60 line-clamp-2">${escapeHtml(card.description)}</p>` : ''}
    ${subtasks.length ? `<div class="mt-1">${subtasksHtml}</div>` : ''}
    ${(dueDateHtml || attachBadge) ? `<div class="flex items-center gap-1.5 flex-wrap mt-1.5">${dueDateHtml}${attachBadge}</div>` : ''}
    <button class="move-card-prev-btn" data-card-id="${card.id}" title="Move to previous column">
      <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M15 19l-7-7 7-7"/>
      </svg>
    </button>
    <button class="move-card-next-btn" data-card-id="${card.id}" title="Move to next column">
      <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/>
      </svg>
    </button>
  `;

  // Show action buttons on hover
  el.addEventListener('mouseenter', () => {
    el.querySelector('.card-actions').classList.remove('opacity-0');
  });
  el.addEventListener('mouseleave', () => {
    el.querySelector('.card-actions').classList.add('opacity-0');
  });

  // Prevent arrow button clicks from accidentally starting a card drag
  el.querySelectorAll('.move-card-prev-btn, .move-card-next-btn').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
  });

  return el;
}

// ─── Event delegation (board-level) ──────────────────────────────────────────

/**
 * Attaches delegated event listeners to the board for card interactions.
 * Called once from main.js after the board is rendered.
 *
 * Using event delegation (one listener on the board) rather than per-card
 * listeners avoids memory leaks when cards are re-rendered.
 *
 * @param {import('firebase/auth').User} user  Authenticated user (for userId field)
 */
/**
 * Sets the current user UID so createCard works without needing a board DOM.
 * Safe to call before the board view is rendered.
 */
export function setCurrentUser(user) {
  _currentUid = user.uid;
}

export function initCardEvents(user) {
  // Store uid for createCard calls
  _currentUid = user.uid;

  const board = document.getElementById('board-root');

  board.addEventListener('click', async (e) => {
    // ── Toggle task complete ─────────────────────────────────────────────
    const taskCheck = e.target.closest('.task-check');
    if (taskCheck) {
      const isCompleted = Boolean(taskCheck.checked);
      await updateCard(taskCheck.dataset.cardId, { completed: isCompleted });
      if (isCompleted) {
        const cardEl = taskCheck.closest('.card');
        const cardTitle = cardEl?.querySelector('.card-title')?.textContent?.replace(/\s*\d+\/\d+$/, '').trim() || '';
        _logCompletion(taskCheck.dataset.cardId, cardTitle, 'task');
      }
      return;
    }

    // ── Toggle sub task complete ─────────────────────────────────────────
    const subtaskCheck = e.target.closest('.subtask-check');
    if (subtaskCheck) {
      const cardEl = subtaskCheck.closest('.card');
      const subtasks = _readSubtasksFromCardEl(cardEl);
      const nextSubtasks = subtasks.map((task) => (
        task.id === subtaskCheck.dataset.subtaskId
          ? { ...task, completed: Boolean(subtaskCheck.checked) }
          : task
      ));
      await updateCard(subtaskCheck.dataset.cardId, { subtasks: nextSubtasks });
      if (subtaskCheck.checked) {
        const cardTitle = cardEl?.querySelector('.card-title')?.textContent?.replace(/\s*\d+\/\d+$/, '').trim() || '';
        const subtaskTitle = subtaskCheck.closest('label')?.querySelector('span')?.textContent?.trim() || '';
        _logCompletion(subtaskCheck.dataset.cardId, cardTitle, 'subtask', { subtaskTitle });
      }
      return;
    }

    // ── Add sub task ─────────────────────────────────────────────────────
    const addSubtaskBtn = e.target.closest('.add-subtask-btn');
    if (addSubtaskBtn) {
      const cardEl = addSubtaskBtn.closest('.card');
      _openAddSubtaskModal(addSubtaskBtn.dataset.cardId, cardEl);
      return;
    }

    // ── Add card ──────────────────────────────────────────────────────────
    const addBtn = e.target.closest('.add-card-btn');
    if (addBtn) {
      openCardModal({ columnId: addBtn.dataset.columnId });
      return;
    }

    // ── Edit card ─────────────────────────────────────────────────────────
    const editBtn = e.target.closest('.edit-card-btn');
    if (editBtn) {
      const cardEl = editBtn.closest('.card');
      let checkable = false;
      let subtasks = [];
      let attachments = [];
      try { checkable = JSON.parse(cardEl.dataset.checkable ?? 'false'); } catch (_) {}
      subtasks = _readSubtasksFromCardEl(cardEl);
      try { attachments = JSON.parse(cardEl.dataset.attachments || '[]'); } catch (_) {}
      openCardModal({
        cardId:      editBtn.dataset.cardId,
        title:       cardEl.querySelector('.card-title').textContent.replace(/\s*\d+\/\d+$/, '').trim(),
        description: cardEl.querySelector('.card-desc')?.textContent || '',
        checkable,
        subtasks,
        dueDate:     cardEl.dataset.dueDate || null,
        attachments,
        cardColor:   cardEl.dataset.cardColor || null,
      });
      return;
    }

    // ── Delete card ───────────────────────────────────────────────────────
    const delBtn = e.target.closest('.delete-card-btn');
    if (delBtn) {
      const cardId    = delBtn.dataset.cardId;
      const cardEl    = delBtn.closest('.card');
      const cardTitle = cardEl?.querySelector('.card-title')?.textContent?.trim() || 'this card';
      _openDeleteCardModal(cardId, cardTitle);
      return;
    }

    // ── Move card to previous column ──────────────────────────────────────
    const movePrevBtn = e.target.closest('.move-card-prev-btn');
    if (movePrevBtn) {
      await _moveCardToAdjacentColumn(movePrevBtn.dataset.cardId, 'prev');
      return;
    }

    // ── Move card to next column ──────────────────────────────────────────
    const moveNextBtn = e.target.closest('.move-card-next-btn');
    if (moveNextBtn) {
      await _moveCardToAdjacentColumn(moveNextBtn.dataset.cardId, 'next');
      return;
    }
  });
}

/**
 * Moves a card to the adjacent column (left or right).
 * Appends it to the bottom of the target column.
 *
 * @param {string} cardId
 * @param {'prev'|'next'} direction
 */
async function _moveCardToAdjacentColumn(cardId, direction) {
  const cardEl = document.querySelector(`.card[data-card-id="${cardId}"]`);
  if (!cardEl) return;

  const allCols    = [...document.querySelectorAll('#columns-wrapper .column')];
  const currentCol = cardEl.closest('.column');
  const currentIdx = allCols.indexOf(currentCol);

  const targetIdx = direction === 'prev' ? currentIdx - 1 : currentIdx + 1;
  if (targetIdx < 0 || targetIdx >= allCols.length) return;

  const targetCol      = allCols[targetIdx];
  const targetColumnId = targetCol.dataset.columnId;

  // Append to bottom of the target column
  const targetCards = [...targetCol.querySelectorAll('.card')];
  const lastCard    = targetCards[targetCards.length - 1];
  const prevOrder   = lastCard ? parseFloat(lastCard.dataset.order ?? 0) : null;

  try {
    await moveCard(cardId, targetColumnId, prevOrder, null);
  } catch (err) {
    console.error('Move card to adjacent column failed:', err);
  }
}

export function openNewCardModal(columnId = 'todo') {
  openCardModal({ columnId });
}

// ─── Subtask modal ────────────────────────────────────────────────────────────

function _openAddSubtaskModal(cardId, cardEl) {
  const modalRoot = document.getElementById('modal-root');

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <h3 class="text-lg font-semibold text-gray-800 mb-4">Add sub tasks</h3>
        <div id="subtask-inputs" class="flex flex-col gap-2 mb-4">
          <input
            type="text"
            placeholder="Sub task name"
            maxlength="200"
            class="subtask-input w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500"
          />
        </div>
        <button id="subtask-add-row"
          class="flex items-center gap-1.5 text-sm text-brand-600 hover:text-brand-700 mb-4 transition-colors">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
          </svg>
          Add another
        </button>
        <div class="flex justify-end gap-2">
          <button type="button" id="subtask-cancel"
            class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">
            Cancel
          </button>
          <button type="button" id="subtask-done"
            class="gold-btn px-4 py-2 text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg transition-colors">
            Done
          </button>
        </div>
      </div>
    </div>
  `;

  const inputsContainer = document.getElementById('subtask-inputs');
  const firstInput = inputsContainer.querySelector('.subtask-input');
  firstInput.focus();

  const addInputRow = () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Sub task name';
    input.maxLength = 200;
    input.className = 'subtask-input w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500';
    inputsContainer.appendChild(input);
    input.focus();
  };

  document.getElementById('subtask-add-row').addEventListener('click', addInputRow);

  // Enter in any input moves focus to the next input or adds a new row
  inputsContainer.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const inputs = [...inputsContainer.querySelectorAll('.subtask-input')];
    const idx = inputs.indexOf(e.target);
    if (idx === inputs.length - 1) {
      addInputRow();
    } else {
      inputs[idx + 1].focus();
    }
  });

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('subtask-cancel').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  document.getElementById('subtask-done').addEventListener('click', async () => {
    const titles = [...inputsContainer.querySelectorAll('.subtask-input')]
      .map((i) => i.value.trim())
      .filter(Boolean);

    if (titles.length === 0) { close(); return; }

    const existing = _readSubtasksFromCardEl(cardEl);
    const nextSubtasks = [
      ...existing,
      ...titles.map((title) => ({
        id: `sub-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        title,
        completed: false,
      })),
    ];

    try {
      await updateCard(cardId, { subtasks: nextSubtasks });
      close();
    } catch (err) {
      console.error('Add subtasks failed:', err);
    }
  });
}

// ─── Completion log ───────────────────────────────────────────────────────────

/**
 * Logs a task or subtask completion event to Firestore.
 * Fire-and-forget — failures are silently swallowed so they never block the UI.
 */
async function _logCompletion(cardId, cardTitle, type, extra = {}) {
  try {
    await addDoc(collection(db, 'completionLog'), {
      cardId,
      cardTitle,
      boardId:     getBoardId(),
      userId:      _currentUid,
      type,
      ...extra,
      completedAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn('Completion log write failed:', err);
  }
}

// ─── Card modal ───────────────────────────────────────────────────────────────

/**
 * Uploads an array of File objects to Firebase Storage and returns their metadata.
 * Path: attachments/{userId}/{timestamp}_{filename}
 */
async function _uploadAttachments(files, userId) {
  const results = [];
  for (const file of files) {
    const path    = `attachments/${userId}/${Date.now()}_${file.name}`;
    const fileRef = storageRef(storage, path);
    await uploadBytes(fileRef, file);
    const url = await getDownloadURL(fileRef);
    results.push({ name: file.name, url, type: file.type, size: file.size });
  }
  return results;
}

/**
 * Opens the card create/edit modal.
 *
 * Rather than a framework component, this is a single lightweight modal
 * template injected into #modal-root. Keeps the DOM minimal and avoids
 * a dependency on a UI library.
 *
 * @param {{ columnId?: string, cardId?: string, title?: string, description?: string }} opts
 */
function openCardModal({ columnId, cardId, title = '', description = '', checkable = false, subtasks = [], dueDate = null, attachments = [], cardColor = null }) {
  const modalRoot = document.getElementById('modal-root');
  const isEdit    = Boolean(cardId);

  // Local mutable copy of subtasks for the edit session
  let editSubtasks = subtasks.map((s) => ({ ...s }));
  // Local mutable copy of attachments
  let editAttachments = attachments.map((a) => ({ ...a }));
  // Pending new files chosen via file input
  let pendingFiles = [];
  // Selected card color
  let selectedCardColor = cardColor || null;

  const _subtaskRowHtml = (s) => `
    <li class="flex items-center gap-2 group" data-subtask-id="${escapeHtml(s.id)}">
      <input type="checkbox" class="modal-subtask-check flex-shrink-0 rounded border-gray-300 text-brand-500 focus:ring-brand-400" ${s.completed ? 'checked' : ''} />
      <input type="text" class="modal-subtask-title flex-1 text-sm border-0 border-b border-transparent focus:border-gray-300 focus:ring-0 bg-transparent px-0 py-0.5 ${s.completed ? 'line-through text-gray-400' : 'text-gray-700'}" value="${escapeHtml(s.title)}" placeholder="Subtask…" maxlength="200" />
      <button type="button" class="modal-subtask-delete flex-shrink-0 text-gray-300 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100" title="Remove">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </li>
  `;

  const _subtasksSectionInner = () => `
    <div class="flex items-center justify-between mb-1">
      <p class="text-sm font-medium text-gray-700">Sub tasks</p>
      <button type="button" id="modal-add-subtask-btn" class="text-brand-500 hover:text-brand-600 text-lg leading-none font-bold px-1" title="Add subtask">+</button>
    </div>
    <ul id="modal-subtask-list" class="flex flex-col gap-1">
      ${editSubtasks.map(_subtaskRowHtml).join('')}
    </ul>
  `;

  const _renderSubtasks = () => {
    const section = document.getElementById('modal-subtasks-section');
    if (section) {
      section.innerHTML = _subtasksSectionInner();
      _bindSubtaskSectionEvents();
    }
  };

  const _addNewSubtaskRow = () => {
    const id = `sub-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    editSubtasks.push({ id, title: '', completed: false });
    _renderSubtasks();
    // Focus the newly added input
    const list = document.getElementById('modal-subtask-list');
    if (list) {
      const inputs = list.querySelectorAll('.modal-subtask-title');
      inputs[inputs.length - 1]?.focus();
    }
  };

  const _bindSubtaskSectionEvents = () => {
    const section = document.getElementById('modal-subtasks-section');
    if (!section) return;

    section.querySelectorAll('.modal-subtask-check').forEach((chk) => {
      chk.addEventListener('change', () => {
        const id = chk.closest('li').dataset.subtaskId;
        editSubtasks = editSubtasks.map((s) => s.id === id ? { ...s, completed: chk.checked } : s);
        // Update strikethrough styling without full re-render
        const titleInput = chk.closest('li').querySelector('.modal-subtask-title');
        if (titleInput) {
          titleInput.classList.toggle('line-through', chk.checked);
          titleInput.classList.toggle('text-gray-400', chk.checked);
          titleInput.classList.toggle('text-gray-700', !chk.checked);
        }
      });
    });

    section.querySelectorAll('.modal-subtask-title').forEach((inp) => {
      inp.addEventListener('input', () => {
        const id = inp.closest('li').dataset.subtaskId;
        editSubtasks = editSubtasks.map((s) => s.id === id ? { ...s, title: inp.value } : s);
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); _addNewSubtaskRow(); }
      });
    });

    section.querySelectorAll('.modal-subtask-delete').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.closest('li').dataset.subtaskId;
        editSubtasks = editSubtasks.filter((s) => s.id !== id);
        _renderSubtasks();
      });
    });

    document.getElementById('modal-add-subtask-btn')?.addEventListener('click', _addNewSubtaskRow);
  };

  // ── Attachments helpers ────────────────────────────────────────────────────

  const _attachmentRowHtml = (a) => `
    <li class="flex items-center gap-2 text-sm group" data-attach-key="${escapeHtml(a.url)}">
      <svg class="w-3.5 h-3.5 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/>
      </svg>
      <a href="${a.url}" target="_blank" rel="noopener noreferrer"
         class="flex-1 text-brand-600 hover:underline truncate text-xs">${escapeHtml(a.name)}</a>
      <button type="button" class="modal-attach-delete flex-shrink-0 text-gray-300 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100" title="Remove">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </li>
  `;

  const _pendingFileRowHtml = (name) => `
    <li class="flex items-center gap-2 text-xs text-gray-500">
      <svg class="w-3 h-3 text-amber-500 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
        <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-12a1 1 0 10-2 0v4a1 1 0 00.293.707l2.828 2.829a1 1 0 101.415-1.415L11 9.586V6z" clip-rule="evenodd"/>
      </svg>
      <span class="truncate">${escapeHtml(name)}</span>
      <span class="text-amber-500 flex-shrink-0">queued</span>
    </li>
  `;

  const _attachmentsSectionInner = () => `
    <div class="flex items-center justify-between mb-1">
      <p class="text-sm font-medium text-gray-700">Attachments</p>
    </div>
    ${editAttachments.length || pendingFiles.length ? `
    <ul id="modal-attach-list" class="flex flex-col gap-1 mb-2">
      ${editAttachments.map(_attachmentRowHtml).join('')}
      ${pendingFiles.map(f => _pendingFileRowHtml(f.name)).join('')}
    </ul>` : ''}
    <label class="flex items-center gap-2 cursor-pointer text-sm text-brand-600 hover:text-brand-700">
      <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
      </svg>
      Add file
      <input id="modal-file-input" type="file" multiple class="hidden" />
    </label>
  `;

  const _renderAttachments = () => {
    const section = document.getElementById('modal-attachments-section');
    if (section) {
      section.innerHTML = _attachmentsSectionInner();
      _bindAttachmentSectionEvents();
    }
  };

  const _bindAttachmentSectionEvents = () => {
    const section = document.getElementById('modal-attachments-section');
    if (!section) return;

    section.querySelectorAll('.modal-attach-delete').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.closest('li').dataset.attachKey;
        editAttachments = editAttachments.filter((a) => a.url !== key);
        _renderAttachments();
      });
    });

    const fileInput = document.getElementById('modal-file-input');
    if (fileInput) {
      fileInput.addEventListener('change', () => {
        pendingFiles = [...pendingFiles, ...Array.from(fileInput.files)];
        _renderAttachments();
      });
    }
  };

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto p-6">
        <h3 class="text-lg font-semibold text-gray-800 mb-4">${isEdit ? 'Edit card' : 'New card'}</h3>
        <form id="card-form" class="flex flex-col gap-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1" for="card-title">Title</label>
            <input
              id="card-title"
              type="text"
              class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500"
              placeholder="What needs to be done?"
              value="${escapeHtml(title)}"
              required
              maxlength="200"
            />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1" for="card-desc">Description <span class="text-gray-400 font-normal">(optional)</span></label>
            <textarea
              id="card-desc"
              class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500 resize-none"
              rows="3"
              placeholder="Add more detail…"
              maxlength="2000"
            >${escapeHtml(description)}</textarea>
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1" for="card-due-date">Due date <span class="text-gray-400 font-normal">(optional)</span></label>
            <input
              id="card-due-date"
              type="date"
              class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500"
              value="${dueDate || ''}"
            />
          </div>
          <label class="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              id="card-checkable"
              type="checkbox"
              class="rounded border-gray-300 text-brand-500 focus:ring-brand-400"
              ${checkable ? 'checked' : ''}
            />
            <span class="text-sm text-gray-600">Make task checkable</span>
          </label>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">Card Color <span class="text-gray-400 font-normal">(optional)</span></label>
            <div class="flex gap-2 flex-wrap items-center" id="card-color-swatches">
              ${CARD_COLORS.map((c) => `<button type="button" data-color="${c.value}"
                class="card-color-swatch w-5 h-5 rounded-full border-2 hover:scale-110 transition-transform"
                style="background:${c.value};border-color:${cardColor === c.value ? '#374151' : 'transparent'};${cardColor === c.value ? `outline:2px solid ${c.value}40;` : ''}"
                title="${c.label}"></button>`).join('')}
              <button type="button" id="card-color-clear"
                class="text-xs text-gray-400 hover:text-gray-600 transition-colors ml-1">Clear</button>
            </div>
            <input type="hidden" id="card-color-value" value="${cardColor || ''}" />
          </div>
          ${isEdit ? `<div id="modal-subtasks-section">${_subtasksSectionInner()}</div>` : ''}
          <div id="modal-attachments-section">${_attachmentsSectionInner()}</div>
          <div class="flex justify-end gap-2 pt-2">
            <button type="button" id="modal-cancel"
              class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">
              Cancel
            </button>
            <button type="submit" id="modal-submit-btn"
              class="gold-btn px-4 py-2 text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg transition-colors">
              ${isEdit ? 'Save changes' : 'Create card'}
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  const form  = document.getElementById('card-form');
  const input = document.getElementById('card-title');
  input.focus();
  _bindSubtaskSectionEvents();
  _bindAttachmentSectionEvents();

  // Card color swatch selection
  document.getElementById('card-color-swatches')?.querySelectorAll('.card-color-swatch').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.card-color-swatch').forEach((b) => {
        b.style.borderColor = 'transparent';
        b.style.outline = 'none';
      });
      btn.style.borderColor = '#374151';
      btn.style.outline = `2px solid ${btn.dataset.color}40`;
      selectedCardColor = btn.dataset.color;
      const hiddenInput = document.getElementById('card-color-value');
      if (hiddenInput) hiddenInput.value = btn.dataset.color;
    });
  });
  document.getElementById('card-color-clear')?.addEventListener('click', () => {
    document.querySelectorAll('.card-color-swatch').forEach((b) => {
      b.style.borderColor = 'transparent';
      b.style.outline = 'none';
    });
    selectedCardColor = null;
    const hiddenInput = document.getElementById('card-color-value');
    if (hiddenInput) hiddenInput.value = '';
  });

  // Close on backdrop click or cancel button
  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('modal-cancel').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
  _bindModalSubmitKeys(form);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newTitle     = input.value.trim();
    const newDesc      = document.getElementById('card-desc').value.trim();
    const newCheckable = document.getElementById('card-checkable').checked;
    const newDueDate   = document.getElementById('card-due-date').value || null;
    const newCardColor = document.getElementById('card-color-value')?.value || null;
    if (!newTitle) return;

    const submitBtn = document.getElementById('modal-submit-btn');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving…'; }

    try {
      // Upload any pending files
      let uploadedAttachments = [];
      if (pendingFiles.length) {
        const uid = _currentUid || auth_uid();
        uploadedAttachments = await _uploadAttachments(pendingFiles, uid);
      }
      const finalAttachments = [...editAttachments, ...uploadedAttachments];

      if (isEdit) {
        const finalSubtasks = editSubtasks.filter((s) => s.title.trim() !== '');
        await updateCard(cardId, {
          title: newTitle, description: newDesc, checkable: newCheckable,
          subtasks: finalSubtasks, dueDate: newDueDate, attachments: finalAttachments,
          cardColor: newCardColor || null,
        });
      } else {
        const listEl    = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
        const lastOrder = listEl?.children.length ?? 0;
        await createCard(columnId, newTitle, newDesc, lastOrder, newCheckable, [], newDueDate, finalAttachments, newCardColor || null);
      }
      close();
    } catch (err) {
      console.error('Card save failed:', err);
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = isEdit ? 'Save changes' : 'Create card'; }
    }
  });
}

// ─── Module-private uid store ─────────────────────────────────────────────────

let _currentUid = null;

/** Returns the current uid for use in createCard. Exposed as a closure. */
function auth_uid() {
  if (!_currentUid) throw new Error('User not set. Call initCardEvents() first.');
  return _currentUid;
}

// ─── Delete card modal ────────────────────────────────────────────────────────

function _openDeleteCardModal(cardId, cardTitle) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  // Escape for display
  const safeTitle = String(cardTitle).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <div class="flex items-start gap-3 mb-5">
          <div class="flex-shrink-0 w-9 h-9 rounded-full bg-red-100 flex items-center justify-center">
            <svg class="w-4.5 h-4.5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6
                   m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
          </div>
          <div>
            <h3 class="text-sm font-semibold text-gray-900">Delete card?</h3>
            <p class="mt-1 text-sm text-gray-500">"<strong>${safeTitle}</strong>" will be permanently deleted.</p>
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <button id="del-card-cancel"
            class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">
            Cancel
          </button>
          <button id="del-card-confirm"
            class="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors">
            Delete
          </button>
        </div>
      </div>
    </div>`;

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('del-card-cancel').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  document.getElementById('del-card-confirm').addEventListener('click', async () => {
    close();
    await deleteCard(cardId);
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

function _bindModalSubmitKeys(form) {
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.defaultPrevented) return;

    const target = e.target;
    const isTextArea = target instanceof HTMLTextAreaElement;
    if (isTextArea && e.shiftKey) return;

    e.preventDefault();
    form.requestSubmit();
  });
}

function _readSubtasksFromCardEl(cardEl) {
  try {
    const parsed = JSON.parse(cardEl?.dataset?.subtasks || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
