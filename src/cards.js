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
import { getBoardId }         from './board.js';
import { updateColumnCount }  from './board.js';
import { initDragAndDrop }    from './drag.js';

// ─── Real-time listener ───────────────────────────────────────────────────────

/** Holds the onSnapshot unsubscribe function. */
let _unsubscribeCards = null;

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
    const cards = snapshot.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAllCards(cards);
  });
}

/** Tears down the cards listener (called on sign-out). */
export function unsubscribeFromCards() {
  if (_unsubscribeCards) {
    _unsubscribeCards();
    _unsubscribeCards = null;
  }
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
export async function createCard(columnId, title, description = '', order = 0) {
  const boardId = getBoardId();
  const ref = await addDoc(collection(db, 'cards'), {
    boardId,
    userId:      auth_uid(),  // denormalised for security rules
    columnId,
    title:       title.trim(),
    description: description.trim(),
    order,
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
  el.className      = 'card bg-white rounded-lg shadow-sm border border-gray-200 p-3 cursor-grab active:cursor-grabbing';
  el.draggable      = true;
  el.dataset.cardId = card.id;

  el.innerHTML = `
    <div class="flex items-start justify-between gap-2">
      <p class="card-title text-sm font-medium text-gray-800 leading-snug">${escapeHtml(card.title)}</p>
      <div class="card-actions flex-shrink-0 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <button class="edit-card-btn text-gray-400 hover:text-brand-600 p-0.5 rounded" data-card-id="${card.id}" title="Edit">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 012.828 0l.172.172a2 2 0 010 2.828L12 16H9v-3z"/>
          </svg>
        </button>
        <button class="delete-card-btn text-gray-400 hover:text-red-500 p-0.5 rounded" data-card-id="${card.id}" title="Delete">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
    </div>
    ${card.description ? `<p class="card-desc mt-1 text-xs text-gray-500 line-clamp-2">${escapeHtml(card.description)}</p>` : ''}
  `;

  // Show action buttons on hover
  el.addEventListener('mouseenter', () => {
    el.querySelector('.card-actions').classList.remove('opacity-0');
  });
  el.addEventListener('mouseleave', () => {
    el.querySelector('.card-actions').classList.add('opacity-0');
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
export function initCardEvents(user) {
  // Store uid for createCard calls
  _currentUid = user.uid;

  const board = document.getElementById('board-root');

  board.addEventListener('click', async (e) => {
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
      openCardModal({
        cardId:      editBtn.dataset.cardId,
        title:       cardEl.querySelector('.card-title').textContent,
        description: cardEl.querySelector('.card-desc')?.textContent || '',
      });
      return;
    }

    // ── Delete card ───────────────────────────────────────────────────────
    const delBtn = e.target.closest('.delete-card-btn');
    if (delBtn) {
      if (confirm('Delete this card?')) {
        await deleteCard(delBtn.dataset.cardId);
      }
      return;
    }
  });
}

// ─── Card modal ───────────────────────────────────────────────────────────────

/**
 * Opens the card create/edit modal.
 *
 * Rather than a framework component, this is a single lightweight modal
 * template injected into #modal-root. Keeps the DOM minimal and avoids
 * a dependency on a UI library.
 *
 * @param {{ columnId?: string, cardId?: string, title?: string, description?: string }} opts
 */
function openCardModal({ columnId, cardId, title = '', description = '' }) {
  const modalRoot = document.getElementById('modal-root');
  const isEdit    = Boolean(cardId);

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
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
          <div class="flex justify-end gap-2 pt-2">
            <button type="button" id="modal-cancel"
              class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">
              Cancel
            </button>
            <button type="submit"
              class="px-4 py-2 text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg transition-colors">
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

  // Close on backdrop click or cancel button
  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('modal-cancel').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newTitle = input.value.trim();
    const newDesc  = document.getElementById('card-desc').value.trim();
    if (!newTitle) return;

    try {
      if (isEdit) {
        await updateCard(cardId, { title: newTitle, description: newDesc });
      } else {
        // Compute order: peek at how many cards are in this column
        const listEl    = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
        const lastOrder = listEl?.children.length ?? 0;
        await createCard(columnId, newTitle, newDesc, lastOrder);
      }
      close();
    } catch (err) {
      console.error('Card save failed:', err);
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

// ─── Utility ─────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
