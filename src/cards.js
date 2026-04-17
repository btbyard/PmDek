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
  getDocs,
  getDoc,
  doc,
  serverTimestamp,
} from 'firebase/firestore';

import { db }                 from './firebase.js';
import { storage }            from './firebase.js';
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage';
import { getBoardId }         from './board.js';
import { updateColumnCount }  from './board.js';
import { initDragAndDrop }    from './drag.js';

// ─── Real-time listener ───────────────────────────────────────────────────────

/** Holds the onSnapshot unsubscribe function. */
let _unsubscribeCards = null;

/** Last known snapshot of cards — used to re-render after a column change. */
let _lastCards = [];

/** Active search/filter query (lowercase). Empty string = no filter. */
let _filterQuery = '';
/** Active chip filters: set of 'overdue' | 'today' | 'recurring' */
let _filterChips = new Set();

function _isDoneLikeColumnId(columnId) {
  return /\bdone\b|\bfinish(?:ed)?\b|\bcomplete(?:d)?\b|\bdeployment\b|\bresolved\b/i.test(String(columnId || ''));
}

function _isEffectivelyCompleted(card) {
  return Boolean(card?.completed) || _isDoneLikeColumnId(card?.columnId);
}

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

/**
 * Filters visible cards by a search query (title + description).
 * Passing an empty string clears the filter.
 * @param {string} query
 */
export function filterCards(query) {
  _filterQuery = (query || '').toLowerCase().trim();
  renderAllCards(_lastCards);
}

export function getCardsSnapshot() {
  return [..._lastCards];
}

function _applyActiveFilters(cards) {
  const q = _filterQuery;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let visible = q
    ? cards.filter((c) =>
      String(c.title || '').toLowerCase().includes(q)
      || String(c.description || '').toLowerCase().includes(q)
    )
    : [...cards];

  if (_filterChips.has('recurring')) {
    visible = visible.filter((c) => Boolean(c.recurring));
  }
  if (_filterChips.has('overdue')) {
    visible = visible.filter((c) => {
      if (!c.dueDate || _isEffectivelyCompleted(c)) return false;
      return new Date(c.dueDate + 'T00:00:00') < today;
    });
  }
  if (_filterChips.has('today')) {
    visible = visible.filter((c) => {
      if (!c.dueDate || _isEffectivelyCompleted(c)) return false;
      return new Date(c.dueDate + 'T00:00:00').getTime() === today.getTime();
    });
  }
  if (_filterChips.has('my-tasks')) {
    visible = visible.filter((c) => Array.isArray(c.assignees) && c.assignees.includes(_currentUid));
  }

  return visible;
}

export function renderListView() {
  const listRoot = document.getElementById('board-list-view');
  if (!listRoot) return;

  const cards = _applyActiveFilters(_lastCards);
  if (cards.length === 0) {
    listRoot.innerHTML = '<div class="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-500">No tasks yet.</div>';
    return;
  }

  const sortByDueDate = (a, b) => String(a.dueDate || '9999-12-31').localeCompare(String(b.dueDate || '9999-12-31'));
  const openCards = cards.filter((c) => !_isEffectivelyCompleted(c)).sort(sortByDueDate);
  const doneCards = cards.filter((c) => _isEffectivelyCompleted(c)).sort(sortByDueDate);
  const showAssigneesColumn = _boardAssignedMembers.length > 0;

  const listAssigneesHtml = (card) => {
    const assignees = Array.isArray(card.assignees) ? card.assignees : [];
    if (!assignees.length) return '<span class="text-gray-400 text-xs">Unassigned</span>';

    const profiles = assignees
      .map((uid) => _boardAssignedMembers.find((m) => m.uid === uid))
      .filter(Boolean);

    if (!profiles.length) return '<span class="text-gray-400 text-xs">Unassigned</span>';

    const bubbles = profiles.map((p) => {
      const hoverName = p.displayName || `@${p.username || p.uid}`;
      const altText = p.displayName ? `${p.displayName} (@${p.username || ''})` : `@${p.username || p.uid}`;
      if (p.photoURL) {
        return `<img src="${escapeHtml(p.photoURL)}" alt="${escapeHtml(altText)}" title="${escapeHtml(hoverName)}" class="w-5 h-5 rounded-full object-cover border border-gray-200 flex-shrink-0" />`;
      }
      const bg = _uidToColor(p.uid);
      const initials = (p.displayName || p.username || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
      return `<span title="${escapeHtml(hoverName)}" class="inline-flex items-center justify-center w-5 h-5 rounded-full text-[9px] font-bold text-white flex-shrink-0" style="background:${bg}">${escapeHtml(initials)}</span>`;
    }).join('');

    return `<div class="flex items-center gap-1 flex-wrap">${bubbles}</div>`;
  };

  const subtaskListHtml = (card, muted = false) => {
    const subtasks = Array.isArray(card.subtasks) ? card.subtasks : [];
    if (!subtasks.length) return '';
    return `
      <div class="mt-1.5 pl-3 border-l border-gray-200 space-y-0.5">
        ${subtasks.map((s) => `
          <label class="flex items-center gap-1.5 text-[11px] ${muted ? 'text-gray-400' : 'text-gray-500'} ${s.completed ? 'line-through' : ''}">
            <input type="checkbox" class="list-subtask-check w-3.5 h-3.5 rounded border-gray-300 text-brand-500 focus:ring-brand-400"
              data-card-id="${escapeHtml(card.id || '')}" data-subtask-id="${escapeHtml(s.id || '')}" ${s.completed ? 'checked' : ''} />
            <span>${escapeHtml(s.title || '')}</span>
          </label>
        `).join('')}
      </div>`;
  };

  listRoot.innerHTML = `
    <div class="rounded-xl border border-gray-200 overflow-hidden bg-white">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 text-gray-600">
          <tr>
            <th class="text-left px-3 py-2 w-10"></th>
            <th class="text-left px-3 py-2">Task</th>
            <th class="text-left px-3 py-2">Column</th>
            ${showAssigneesColumn ? '<th class="text-left px-3 py-2">Assignees</th>' : ''}
            <th class="text-left px-3 py-2">Due</th>
            <th class="text-left px-3 py-2">Status</th>
          </tr>
        </thead>
        <tbody>
          ${openCards.map((c) => `
            <tr class="border-t border-gray-100">
              <td class="px-3 py-2 align-top">
                <input type="checkbox" class="list-task-check mt-0.5 w-4 h-4 rounded border-gray-300 text-brand-500 focus:ring-brand-400" data-card-id="${escapeHtml(c.id || '')}" ${c.completed ? 'checked' : ''} />
              </td>
              <td class="px-3 py-2 text-gray-800">
                <p>${escapeHtml(c.title || '')}</p>
                ${subtaskListHtml(c, false)}
              </td>
              <td class="px-3 py-2 text-gray-500">${escapeHtml(c.columnId || '')}</td>
              ${showAssigneesColumn ? `<td class="px-3 py-2 text-gray-500">${listAssigneesHtml(c)}</td>` : ''}
              <td class="px-3 py-2 text-gray-500">${escapeHtml(c.dueDate || 'No due date')}</td>
              <td class="px-3 py-2">${_isEffectivelyCompleted(c) ? '<span class="text-emerald-600">Done</span>' : '<span class="text-amber-600">Open</span>'}</td>
            </tr>
          `).join('')}
          ${doneCards.length ? `
            <tr class="border-t border-gray-200 bg-gray-50/70">
              <td class="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500" colspan="${showAssigneesColumn ? 6 : 5}">Completed</td>
            </tr>
          ` : ''}
          ${doneCards.map((c) => `
            <tr class="border-t border-gray-100 bg-gray-50/40">
              <td class="px-3 py-2 align-top">
                <input type="checkbox" class="list-task-check mt-0.5 w-4 h-4 rounded border-gray-300 text-brand-500 focus:ring-brand-400" data-card-id="${escapeHtml(c.id || '')}" checked />
              </td>
              <td class="px-3 py-2 text-gray-500">
                <p class="line-through">${escapeHtml(c.title || '')}</p>
                ${subtaskListHtml(c, true)}
              </td>
              <td class="px-3 py-2 text-gray-400">${escapeHtml(c.columnId || '')}</td>
              ${showAssigneesColumn ? `<td class="px-3 py-2 text-gray-400">${listAssigneesHtml(c)}</td>` : ''}
              <td class="px-3 py-2 text-gray-400">${escapeHtml(c.dueDate || 'No due date')}</td>
              <td class="px-3 py-2"><span class="text-emerald-600">Done</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>`;

  if (!listRoot.dataset.eventsBound) {
    listRoot.dataset.eventsBound = '1';
    listRoot.addEventListener('change', async (e) => {
      const chk = e.target.closest('.list-task-check');
      if (chk) {
        const cardId = chk.dataset.cardId;
        if (!cardId) return;
        const checked = Boolean(chk.checked);
        const card = _lastCards.find((c) => c.id === cardId);
        const cardEl = document.querySelector(`.card[data-card-id="${cardId}"]`);
        try {
          await _applyTaskCompletionToggle(cardId, checked, cardEl, card?.title || '');
        } catch (err) {
          console.error('List task toggle failed:', err);
        }
        return;
      }

      const subChk = e.target.closest('.list-subtask-check');
      if (subChk) {
        const cardId = subChk.dataset.cardId;
        const subId = subChk.dataset.subtaskId;
        if (!cardId || !subId) return;

        const checked = Boolean(subChk.checked);
        const card = _lastCards.find((c) => c.id === cardId);
        if (!card) return;

        const subtasks = Array.isArray(card.subtasks) ? card.subtasks : [];
        const nextSubtasks = subtasks.map((s) => (
          s.id === subId ? { ...s, completed: checked } : s
        ));

        try {
          await updateCard(cardId, { subtasks: nextSubtasks });
          if (checked) {
            const doneSub = subtasks.find((s) => s.id === subId);
            _logCompletion(cardId, card.title || '', 'subtask', { subtaskTitle: doneSub?.title || '' });
          }
        } catch (err) {
          console.error('List subtask toggle failed:', err);
        }
      }
    });
  }
}

export function renderCalendarView() {
  const calRoot = document.getElementById('board-calendar-view');
  if (!calRoot) return;

  const calendarAssigneesHtml = (card) => {
    if (_boardAssignedMembers.length === 0) return '';
    const assignees = Array.isArray(card.assignees) ? card.assignees : [];
    if (!assignees.length) return '';

    const profiles = assignees
      .map((uid) => _boardAssignedMembers.find((m) => m.uid === uid))
      .filter(Boolean);
    if (!profiles.length) return '';

    const bubbles = profiles.map((p) => {
      const hoverName = p.displayName || `@${p.username || p.uid}`;
      const altText = p.displayName ? `${p.displayName} (@${p.username || ''})` : `@${p.username || p.uid}`;
      if (p.photoURL) {
        return `<img src="${escapeHtml(p.photoURL)}" alt="${escapeHtml(altText)}" title="${escapeHtml(hoverName)}" class="w-5 h-5 rounded-full object-cover border border-sky-200 flex-shrink-0" />`;
      }
      const bg = _uidToColor(p.uid);
      const initials = (p.displayName || p.username || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
      return `<span title="${escapeHtml(hoverName)}" class="inline-flex items-center justify-center w-5 h-5 rounded-full text-[9px] font-bold text-white flex-shrink-0" style="background:${bg}">${escapeHtml(initials)}</span>`;
    }).join('');

    return `<div class="mt-1.5 flex items-center gap-1 flex-wrap">${bubbles}</div>`;
  };

  const byDate = new Map();
  _applyActiveFilters(_lastCards).forEach((c) => {
    if (!c.dueDate) return;
    if (!byDate.has(c.dueDate)) byDate.set(c.dueDate, []);
    byDate.get(c.dueDate).push(c);
  });

  const dates = [...byDate.keys()].sort();
  if (dates.length === 0) {
    calRoot.innerHTML = '<div class="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-500">No dated tasks to plot on the calendar.</div>';
    return;
  }

  calRoot.innerHTML = `
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      ${dates.map((d) => `
        <div class="rounded-lg border border-gray-200 bg-white p-3">
          <p class="text-xs font-semibold text-gray-500 mb-2">${escapeHtml(d)}</p>
          <div class="space-y-2">
            ${byDate.get(d).map((c) => `
              <div class="rounded-md border border-sky-200 bg-sky-50 px-2 py-1.5">
                <p class="text-sm text-sky-900">${escapeHtml(c.title || '')}</p>
                ${calendarAssigneesHtml(c)}
                <div class="mt-1 h-1.5 rounded bg-sky-200 overflow-hidden">
                  <div class="h-full bg-sky-500" style="width:${c.completed ? '100' : '55'}%"></div>
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      `).join('')}
    </div>`;
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
export async function createCard(columnId, title, description = '', order = 0, checkable = false, subtasks = [], dueDate = null, attachments = [], cardColor = null, cardBgColor = null, recurring = false, recurrenceFrequency = null, startDate = null) {
  const boardId = getBoardId();
  let resolvedCardBgColor = cardBgColor || null;

  // If caller did not provide a task color, inherit the board-level task color.
  if (!resolvedCardBgColor) {
    try {
      const boardSnap = await getDoc(doc(db, 'boards', boardId));
      resolvedCardBgColor = boardSnap.exists() ? (boardSnap.data()?.taskBgColor || null) : null;
    } catch (_) {
      resolvedCardBgColor = null;
    }
  }

  const ref = await addDoc(collection(db, 'cards'), {
    boardId,
    userId:      auth_uid(),
    columnId,
    title:       title.trim(),
    description: description.trim(),
    completed:   false,
    checkable,
    subtasks:    subtasks,
    startDate:   startDate || null,
    dueDate:     dueDate || null,
    recurring:   Boolean(recurring),
    recurrenceFrequency: recurring ? (recurrenceFrequency || 'weekly') : null,
    attachments: attachments,
    cardColor:   cardColor || null,
    cardBgColor: resolvedCardBgColor,
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
 * Sets cardColor on every card belonging to the given board.
 * @param {string} boardId
 * @param {string|null} color  Hex string or null to clear.
 * @returns {Promise<void>}
 */
export async function updateAllCardsColor(boardId, color) {
  const q    = query(collection(db, 'cards'), where('boardId', '==', boardId));
  const snap = await getDocs(q);
  await Promise.all(snap.docs.map((d) => updateDoc(d.ref, { cardColor: color || null })));
}

/**
 * Sets cardBgColor on every card belonging to the given board.
 * @param {string} boardId
 * @param {string|null} color  Hex string or null to clear.
 * @returns {Promise<void>}
 */
export async function updateAllCardsBackground(boardId, color) {
  const q    = query(collection(db, 'cards'), where('boardId', '==', boardId));
  const snap = await getDocs(q);
  await Promise.all(snap.docs.map((d) => updateDoc(d.ref, { cardBgColor: color || null })));
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
  const visible = _applyActiveFilters(cards);
  const q = _filterQuery;

  // Update filter count badge
  const countEl = document.getElementById('board-filter-count');
  const hasFilter = q || _filterChips.size > 0;
  if (countEl) {
    if (hasFilter) {
      countEl.textContent = `${visible.length} of ${cards.length} cards`;
      countEl.classList.remove('hidden');
    } else {
      countEl.classList.add('hidden');
    }
  }
  const clearBtn = document.getElementById('filter-clear-btn');
  if (clearBtn) clearBtn.classList.toggle('hidden', !hasFilter);

  // Group by column
  const byColumn = {};
  visible.forEach((card) => {
    if (!byColumn[card.columnId]) byColumn[card.columnId] = [];
    byColumn[card.columnId].push(card);
  });

  // Update each column list
  document.querySelectorAll('.card-list').forEach((listEl) => {
    const columnId = listEl.dataset.columnId;
    const colCards = byColumn[columnId] || [];

    // Detect if this column is a "done" type column
    const colEl = listEl.closest('.column');
    const colTitleRaw = colEl?.querySelector('.col-title-input')?.value
      || colEl?.querySelector('.col-title-input')?.dataset?.original
      || columnId || '';
    const isDoneColumn = /\bdone\b|\bfinished\b|\bcomplete[d]?\b|\bdeployment\b|\bresolved\b/i.test(colTitleRaw);

    listEl.innerHTML = '';
    colCards.forEach((card) => {
      listEl.appendChild(buildCardEl(card, isDoneColumn));
    });

    updateColumnCount(columnId, colCards.length);
  });

  // Re-init drag handles after every render
  initDragAndDrop();

  if (!document.getElementById('board-list-view')?.classList.contains('hidden')) {
    renderListView();
  }
  if (!document.getElementById('board-calendar-view')?.classList.contains('hidden')) {
    renderCalendarView();
  }
}

/**
 * Builds the DOM element for a single card.
 * @param {{ id: string, title: string, description: string }} card
 * @param {boolean} [isDoneColumn=false]
 * @returns {HTMLElement}
 */
function buildCardEl(card, isDoneColumn = false) {
  const el = document.createElement('div');
  const isCompleted = Boolean(card.completed) || isDoneColumn;
  const subtasks = Array.isArray(card.subtasks) ? card.subtasks : [];
  const attachments = Array.isArray(card.attachments) ? card.attachments : [];
  const dueDate = card.dueDate || null;
  const recurring = Boolean(card.recurring);
  const recurrenceFrequency = String(card.recurrenceFrequency || 'weekly');

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
  el.dataset.recurring = String(recurring);
  el.dataset.recurrenceFrequency = recurrenceFrequency;
  el.dataset.attachments = JSON.stringify(attachments);
  el.dataset.cardColor = card.cardColor || '';
  el.dataset.cardBgColor = card.cardBgColor || '';

  if (card.cardBgColor) {
    el.style.background = `linear-gradient(160deg, ${card.cardBgColor}f0 0%, ${card.cardBgColor}c7 70%, ${card.cardBgColor}a3 100%)`;
  }

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

  let recurringBadge = '';
  if (recurring) {
    recurringBadge = `<span class="inline-flex items-center gap-1 text-[10px] border rounded px-1.5 py-0.5 bg-emerald-500/15 text-emerald-200 border-emerald-400/25" title="Recurring ${_formatRecurrenceFrequency(recurrenceFrequency)}">
      <svg class="w-2.5 h-2.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v6h6M20 20v-6h-6M20 10a8 8 0 00-14.9-4M4 14a8 8 0 0014.9 4"/>
      </svg>${_formatRecurrenceFrequency(recurrenceFrequency)}</span>`;
  }

  // Attachment badge
  let attachBadge = '';
  if (attachments.length) {
    attachBadge = `<button type="button" class="preview-attachments-btn inline-flex items-center gap-1 text-[10px] border rounded px-1.5 py-0.5 bg-white/10 text-white/50 border-white/15 hover:bg-white/20 hover:text-white transition-colors" data-attachment-index="0" title="Preview attachments">
      <svg class="w-2.5 h-2.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"/>
      </svg>${attachments.length}</button>`;
  }

  const subtasksHtml = subtasks.map((task) => `
    <label class="flex items-center gap-2 text-[11px] text-white/60 mt-0.5 pl-5 border-l border-white/10 ml-1">
      <input
        type="checkbox"
        class="subtask-check w-3.5 h-3.5 flex-shrink-0 rounded border-white/30 bg-transparent text-brand-500 focus:ring-brand-400"
        data-card-id="${card.id}"
        data-subtask-id="${escapeHtml(task.id)}"
        ${task.completed ? 'checked' : ''}
      />
      <span class="${task.completed ? 'line-through text-white/35' : 'text-white/60'}">${escapeHtml(task.title)}</span>
      ${task.assignee ? `<span class="text-[10px] text-white/40">@${escapeHtml(_boardAssignedMembers.find((m) => m.uid === task.assignee)?.username || 'member')}</span>` : ''}
    </label>
  `).join('');

  el.innerHTML = `
    <div class="flex items-start justify-between gap-2">
      <label class="flex items-start gap-2 flex-1 cursor-pointer">
        ${card.checkable ? `<input
          type="checkbox"
          class="task-check w-3.5 h-3.5 mt-0.5 rounded border-white/40 bg-transparent text-brand-500 focus:ring-brand-400"
          data-card-id="${card.id}"
          ${isCompleted ? 'checked' : ''}
        />` : ''}
        <p class="card-title text-sm font-medium leading-snug ${isCompleted ? 'line-through text-white/60' : 'text-white'}">${isDoneColumn ? '<svg class="inline-block w-3.5 h-3.5 mr-1 text-emerald-400 -mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>' : ''}${escapeHtml(card.title)}${subtasks.length ? `<span class="ml-1.5 text-[10px] font-normal text-white/40 align-middle">${subtasks.filter(t => t.completed).length}/${subtasks.length}</span>` : ''}</p>
      </label>
      <div class="card-actions flex-shrink-0 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity relative">
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
        <button class="clone-card-btn text-white/45 hover:text-brand-100 p-0.5 rounded" data-card-id="${card.id}" title="Clone card">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
          </svg>
        </button>
        <button class="delete-card-btn text-white/45 hover:text-red-300 p-0.5 rounded" data-card-id="${card.id}" title="Delete">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
      <!-- Mobile dropdown toggle and menu (positioned in top right) -->
      <div class="card-mobile-actions md:hidden">
        <button class="card-actions-mobile-toggle text-white/60 hover:text-brand-100 p-1 rounded" data-card-id="${card.id}" title="Actions">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"/>
          </svg>
        </button>
        <!-- Mobile dropdown menu -->
        <div class="card-actions-mobile-menu hidden absolute top-full right-0 mt-1 bg-gray-900 border border-white/20 rounded-lg shadow-xl z-50 w-36 py-1">
          <button class="add-subtask-btn-mobile w-full text-left px-3 py-2 text-xs text-white/80 hover:bg-white/10 flex items-center gap-2" data-card-id="${card.id}">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
            </svg>
            Add subtask
          </button>
          <button class="edit-card-btn-mobile w-full text-left px-3 py-2 text-xs text-white/80 hover:bg-white/10 flex items-center gap-2" data-card-id="${card.id}">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 012.828 0l.172.172a2 2 0 010 2.828L12 16H9v-3z"/>
            </svg>
            Edit
          </button>
          <button class="clone-card-btn-mobile w-full text-left px-3 py-2 text-xs text-white/80 hover:bg-white/10 flex items-center gap-2" data-card-id="${card.id}">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
            </svg>
            Clone
          </button>
          <div class="border-t border-white/10 my-1"></div>
          <button class="delete-card-btn-mobile w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-red-500/20 flex items-center gap-2" data-card-id="${card.id}">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
            Delete
          </button>
        </div>
      </div>
    </div>
    ${card.description ? `<p class="card-desc mt-1 text-xs text-white/60 line-clamp-2">${escapeHtml(card.description)}</p>` : ''}
    ${subtasks.length ? `<div class="mt-1">${subtasksHtml}</div>` : ''}
    ${(dueDateHtml || recurringBadge || attachBadge) ? `<div class="flex items-center gap-1.5 flex-wrap mt-1.5">${dueDateHtml}${recurringBadge}${attachBadge}</div>` : ''}
    ${_buildAssigneeChips(card.assignees)}
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
  _currentUserDisplayName = user.displayName || user.email || 'User';
}

export function initCardEvents(user) {
  // Store uid for createCard calls
  _currentUid = user.uid;

  // Reset search filter on every board open
  _filterQuery = '';
  _filterChips = new Set();
  const searchInput = document.getElementById('board-search-input');
  if (searchInput) {
    searchInput.value = '';
    searchInput.addEventListener('input', () => filterCards(searchInput.value));
  }

  // Chip filter buttons
  const CHIP_IDS = [
    { id: 'filter-overdue-btn',    key: 'overdue',    activeClass: 'border-red-400 text-red-600 bg-red-50' },
    { id: 'filter-today-btn',      key: 'today',      activeClass: 'border-amber-400 text-amber-600 bg-amber-50' },
    { id: 'filter-recurring-btn',  key: 'recurring',  activeClass: 'border-emerald-400 text-emerald-600 bg-emerald-50' },
    { id: 'filter-my-tasks-btn',   key: 'my-tasks',   activeClass: 'border-blue-400 text-blue-600 bg-blue-50' },
  ];
  const INACTIVE = 'border-gray-200 bg-white text-gray-500';

  CHIP_IDS.forEach(({ id, key, activeClass }) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (_filterChips.has(key)) {
        _filterChips.delete(key);
        btn.className = btn.className.replace(activeClass, INACTIVE);
      } else {
        _filterChips.add(key);
        btn.className = btn.className.replace(INACTIVE, activeClass);
      }
      renderAllCards(_lastCards);
    });
  });

  document.getElementById('filter-clear-btn')?.addEventListener('click', () => {
    _filterQuery = '';
    _filterChips = new Set();
    if (searchInput) searchInput.value = '';
    CHIP_IDS.forEach(({ id, key, activeClass }) => {
      const btn = document.getElementById(id);
      if (btn) btn.className = btn.className.replace(activeClass, INACTIVE);
    });
    renderAllCards(_lastCards);
  });

  const board = document.getElementById('board-root');

  // Close any open mobile action menus when clicking outside them
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.card-actions-mobile-menu') && !e.target.closest('.card-actions-mobile-toggle')) {
      document.querySelectorAll('.card-actions-mobile-menu').forEach((m) => m.classList.add('hidden'));
    }
    if (!e.target.closest('.col-quick-color-wrap') && !e.target.closest('.col-quick-bg-wrap')) {
      document.querySelectorAll('.col-quick-color-popup').forEach((p) => p.classList.add('hidden'));
      document.querySelectorAll('.col-quick-bg-popup').forEach((p) => p.classList.add('hidden'));
    }
  });

  board.addEventListener('click', async (e) => {
    // ── Toggle task complete ─────────────────────────────────────────────
    const taskCheck = e.target.closest('.task-check');
    if (taskCheck) {
      const isCompleted = Boolean(taskCheck.checked);
      const cardEl = taskCheck.closest('.card');
      const cardTitle = cardEl?.querySelector('.card-title')?.textContent?.replace(/\s*\d+\/\d+$/, '').trim() || '';
      await _applyTaskCompletionToggle(taskCheck.dataset.cardId, isCompleted, cardEl, cardTitle);
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

    // ── Preview attachments ──────────────────────────────────────────────
    const previewAttachBtn = e.target.closest('.preview-attachments-btn');
    if (previewAttachBtn) {
      const cardEl = previewAttachBtn.closest('.card');
      let attachments = [];
      try { attachments = JSON.parse(cardEl?.dataset.attachments || '[]'); } catch (_) {}
      const startIdx = Number(previewAttachBtn.dataset.attachmentIndex || 0);
      _openAttachmentPreviewModal(attachments, startIdx);
      return;
    }

    // ── Quick column card-color trigger button ────────────────────────────
    const quickBtn = e.target.closest('.col-quick-color-btn');
    if (quickBtn) {
      const popup = quickBtn.parentElement?.querySelector('.col-quick-color-popup');
      if (popup) {
        popup.classList.toggle('hidden');
        e.stopPropagation();
      }
      return;
    }

    // ── Quick column card-background trigger button ─────────────────────
    const quickBgBtn = e.target.closest('.col-quick-bg-btn');
    if (quickBgBtn) {
      const popup = quickBgBtn.parentElement?.querySelector('.col-quick-bg-popup');
      if (popup) {
        popup.classList.toggle('hidden');
        e.stopPropagation();
      }
      return;
    }

    // ── Quick column card-color swatch (inside popup) ─────────────────────
    const quickSwatch = e.target.closest('.col-quick-swatch');
    if (quickSwatch) {
      const wrap = quickSwatch.closest('.col-quick-color-wrap');
      const btn  = wrap?.querySelector('.col-quick-color-btn');
      const popup = wrap?.querySelector('.col-quick-color-popup');
      if (!btn) return;
      const prev = btn.dataset.selectedColor;
      const next = quickSwatch.dataset.color;
      const selected = (prev === next) ? '' : next;
      btn.dataset.selectedColor = selected;
      // Update trigger button appearance
      if (selected) {
        btn.style.background = selected;
        btn.style.borderColor = selected;
        btn.innerHTML = '';
      } else {
        btn.style.background = '#050506';
        btn.style.borderColor = 'rgba(255,255,255,0.4)';
        btn.innerHTML = `<svg class="col-quick-color-icon w-2.5 h-2.5 text-white/40" fill="currentColor" viewBox="0 0 24 24"><circle cx="6" cy="12" r="2.5"/><circle cx="12" cy="7" r="2.5"/><circle cx="18" cy="12" r="2.5"/><circle cx="12" cy="17" r="2.5"/></svg>`;
      }
      // Highlight active swatch
      wrap?.querySelectorAll('.col-quick-swatch').forEach((s) => {
        const active = selected && s.dataset.color === selected;
        s.style.outline = active ? `2px solid ${s.dataset.color || 'white'}` : '';
        s.style.outlineOffset = active ? '2px' : '';
      });
      popup?.classList.add('hidden');
      return;
    }

    // ── Quick column card-background swatch (inside popup) ──────────────
    const quickBgSwatch = e.target.closest('.col-quick-bg-swatch');
    if (quickBgSwatch) {
      const wrap = quickBgSwatch.closest('.col-quick-bg-wrap');
      const btn  = wrap?.querySelector('.col-quick-bg-btn');
      const popup = wrap?.querySelector('.col-quick-bg-popup');
      if (!btn) return;
      const prev = btn.dataset.selectedColor;
      const next = quickBgSwatch.dataset.color;
      const selected = (prev === next) ? '' : next;
      btn.dataset.selectedColor = selected;
      if (selected) {
        btn.style.background = selected;
        btn.style.borderColor = selected;
        btn.innerHTML = '';
      } else {
        btn.style.background = '#050506';
        btn.style.borderColor = 'rgba(255,255,255,0.4)';
        btn.innerHTML = `<svg class="col-quick-bg-icon w-2.5 h-2.5 text-white/40" fill="currentColor" viewBox="0 0 24 24"><rect x="5" y="7" width="14" height="10" rx="2"/></svg>`;
      }
      wrap?.querySelectorAll('.col-quick-bg-swatch').forEach((s) => {
        const active = selected && s.dataset.color === selected;
        s.style.outline = active ? `2px solid ${s.dataset.color || 'white'}` : '';
        s.style.outlineOffset = active ? '2px' : '';
      });
      popup?.classList.add('hidden');
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
      let recurring = false;
      let recurrenceFrequency = 'weekly';
      try { checkable = JSON.parse(cardEl.dataset.checkable ?? 'false'); } catch (_) {}
      subtasks = _readSubtasksFromCardEl(cardEl);
      try { attachments = JSON.parse(cardEl.dataset.attachments || '[]'); } catch (_) {}
      try { recurring = JSON.parse(cardEl.dataset.recurring ?? 'false'); } catch (_) {}
      recurrenceFrequency = cardEl.dataset.recurrenceFrequency || 'weekly';
      const fullCard = _lastCards.find((c) => c.id === editBtn.dataset.cardId) || {};
      openCardModal({
        cardId:      editBtn.dataset.cardId,
        title:       cardEl.querySelector('.card-title').textContent.replace(/\s*\d+\/\d+$/, '').trim(),
        description: cardEl.querySelector('.card-desc')?.textContent || '',
        checkable,
        subtasks,
        startDate:   fullCard.startDate || null,
        dueDate:     cardEl.dataset.dueDate || null,
        recurring,
        recurrenceFrequency,
        attachments,
        comments:    Array.isArray(fullCard.comments) ? fullCard.comments : [],
        assignees:   Array.isArray(fullCard.assignees) ? fullCard.assignees : [],
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

    // ── Clone card ────────────────────────────────────────────────────────
    const cloneBtn = e.target.closest('.clone-card-btn');
    if (cloneBtn) {
      const cardEl = cloneBtn.closest('.card');
      await _cloneCard(cloneBtn.dataset.cardId, cardEl);
      return;
    }

    // ── Mobile actions dropdown toggle ───────────────────────────────────
    const mobileToggle = e.target.closest('.card-actions-mobile-toggle');
    if (mobileToggle) {
      const cardEl = mobileToggle.closest('.card');
      const menu = cardEl?.querySelector('.card-actions-mobile-menu');
      if (menu) {
        menu.classList.toggle('hidden');
        e.stopPropagation();
      }
      return;
    }

    // ── Mobile add subtask ───────────────────────────────────────────────
    const addSubtaskBtnMobile = e.target.closest('.add-subtask-btn-mobile');
    if (addSubtaskBtnMobile) {
      const cardEl = addSubtaskBtnMobile.closest('.card');
      cardEl?.querySelector('.card-actions-mobile-menu')?.classList.add('hidden');
      _openAddSubtaskModal(addSubtaskBtnMobile.dataset.cardId, cardEl);
      return;
    }

    // ── Mobile edit card ─────────────────────────────────────────────────
    const editBtnMobile = e.target.closest('.edit-card-btn-mobile');
    if (editBtnMobile) {
      const cardEl = editBtnMobile.closest('.card');
      cardEl?.querySelector('.card-actions-mobile-menu')?.classList.add('hidden');
      let checkable = false;
      let subtasks = [];
      let attachments = [];
      let recurring = false;
      let recurrenceFrequency = 'weekly';
      try { checkable = JSON.parse(cardEl.dataset.checkable ?? 'false'); } catch (_) {}
      subtasks = _readSubtasksFromCardEl(cardEl);
      try { attachments = JSON.parse(cardEl.dataset.attachments || '[]'); } catch (_) {}
      try { recurring = JSON.parse(cardEl.dataset.recurring ?? 'false'); } catch (_) {}
      recurrenceFrequency = cardEl.dataset.recurrenceFrequency || 'weekly';
      const fullCard = _lastCards.find((c) => c.id === editBtnMobile.dataset.cardId) || {};
      openCardModal({
        cardId:      editBtnMobile.dataset.cardId,
        title:       cardEl.querySelector('.card-title').textContent.replace(/\s*\d+\/\d+$/, '').trim(),
        description: cardEl.querySelector('.card-desc')?.textContent || '',
        checkable,
        subtasks,
        startDate:   fullCard.startDate || null,
        dueDate:     cardEl.dataset.dueDate || null,
        recurring,
        recurrenceFrequency,
        attachments,
        comments:    Array.isArray(fullCard.comments) ? fullCard.comments : [],
        assignees:   Array.isArray(fullCard.assignees) ? fullCard.assignees : [],
      });
      return;
    }

    // ── Mobile clone card ────────────────────────────────────────────────
    const cloneBtnMobile = e.target.closest('.clone-card-btn-mobile');
    if (cloneBtnMobile) {
      const cardEl = cloneBtnMobile.closest('.card');
      cardEl?.querySelector('.card-actions-mobile-menu')?.classList.add('hidden');
      await _cloneCard(cloneBtnMobile.dataset.cardId, cardEl);
      return;
    }

    // ── Mobile delete card ───────────────────────────────────────────────
    const delBtnMobile = e.target.closest('.delete-card-btn-mobile');
    if (delBtnMobile) {
      const cardId    = delBtnMobile.dataset.cardId;
      const cardEl    = delBtnMobile.closest('.card');
      cardEl?.querySelector('.card-actions-mobile-menu')?.classList.add('hidden');
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

async function _applyTaskCompletionToggle(cardId, isCompleted, cardEl = null, fallbackTitle = '') {
  await updateCard(cardId, { completed: isCompleted });
  if (!isCompleted) return;

  const cardTitle = cardEl?.querySelector('.card-title')?.textContent?.replace(/\s*\d+\/\d+$/, '').trim()
    || fallbackTitle
    || '';
  _logCompletion(cardId, cardTitle, 'task');

  // Recurring automation: clone card into first column with next due date
  if (cardEl?.dataset?.recurring === 'true') {
    _handleRecurringComplete(cardId, cardEl).catch((err) =>
      console.warn('Recurring clone failed:', err)
    );
  }
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

function _attachmentPreviewHtml(attachment) {
  const file = attachment || {};
  const url = String(file.url || '');
  const type = String(file.type || '').toLowerCase();
  const lowerUrl = url.toLowerCase();

  const isImage = type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/.test(lowerUrl);
  if (isImage) {
    return `<img src="${escapeHtml(url)}" alt="${escapeHtml(file.name || 'Attachment preview')}" class="max-h-[60vh] w-auto max-w-full object-contain rounded-lg mx-auto" />`;
  }

  const isPdf = type === 'application/pdf' || /\.pdf(\?|$)/.test(lowerUrl);
  if (isPdf) {
    return `<iframe src="${escapeHtml(url)}" class="w-full h-[60vh] rounded-lg border border-gray-200 bg-white" title="PDF preview"></iframe>`;
  }

  const isVideo = type.startsWith('video/') || /\.(mp4|webm|ogg|mov)(\?|$)/.test(lowerUrl);
  if (isVideo) {
    return `<video controls src="${escapeHtml(url)}" class="w-full max-h-[60vh] rounded-lg bg-black"></video>`;
  }

  const isAudio = type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a)(\?|$)/.test(lowerUrl);
  if (isAudio) {
    return `<audio controls src="${escapeHtml(url)}" class="w-full"></audio>`;
  }

  return `
    <div class="rounded-lg border border-gray-200 bg-white p-6 text-center">
      <p class="text-sm text-gray-700 mb-2">Preview not available for this file type.</p>
      <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline">Open file in new tab</a>
    </div>
  `;
}

function _openAttachmentPreviewModal(attachments, startIndex = 0) {
  if (!Array.isArray(attachments) || attachments.length === 0) return;

  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  let activeIndex = Math.min(Math.max(startIndex, 0), attachments.length - 1);

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden">
        <div class="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <h3 class="text-sm font-semibold text-gray-800">Attachment preview</h3>
          <button id="attachment-preview-close" class="p-1 text-gray-400 hover:text-gray-600 transition-colors rounded-lg hover:bg-gray-100" aria-label="Close preview">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
        <div id="attachment-preview-tabs" class="px-4 py-2 border-b border-gray-100 flex flex-wrap gap-2"></div>
        <div id="attachment-preview-body" class="flex-1 overflow-auto p-4 bg-slate-50"></div>
        <div class="px-4 py-3 border-t border-gray-100 flex items-center justify-between gap-3">
          <p id="attachment-preview-meta" class="text-xs text-gray-500 truncate"></p>
          <a id="attachment-preview-open" href="#" target="_blank" rel="noopener noreferrer" class="text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline">Open in new tab</a>
        </div>
      </div>
    </div>
  `;

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('attachment-preview-close')?.addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  const tabsEl = document.getElementById('attachment-preview-tabs');
  const bodyEl = document.getElementById('attachment-preview-body');
  const openEl = document.getElementById('attachment-preview-open');
  const metaEl = document.getElementById('attachment-preview-meta');

  const render = () => {
    const current = attachments[activeIndex] || {};
    if (tabsEl) {
      tabsEl.innerHTML = attachments.map((a, idx) => {
        const active = idx === activeIndex;
        return `<button type="button" class="attachment-tab px-2.5 py-1 rounded-md text-xs border transition-colors ${active ? 'bg-brand-50 text-brand-700 border-brand-200' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}" data-index="${idx}" title="${escapeHtml(a.name || 'Attachment')}">${escapeHtml(a.name || `Attachment ${idx + 1}`)}</button>`;
      }).join('');
      tabsEl.querySelectorAll('.attachment-tab').forEach((btn) => {
        btn.addEventListener('click', () => {
          activeIndex = Number(btn.dataset.index || 0);
          render();
        });
      });
    }

    if (bodyEl) bodyEl.innerHTML = _attachmentPreviewHtml(current);
    if (openEl) openEl.href = current.url || '#';
    if (metaEl) {
      const sizeKb = Number(current.size) ? `${Math.max(1, Math.round(Number(current.size) / 1024))} KB` : '';
      const type = current.type || 'Unknown type';
      metaEl.textContent = [current.name || 'Attachment', type, sizeKb].filter(Boolean).join(' • ');
    }
  };

  render();
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
        assignee: null,
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
  // Always append to local timeline cache so Timeline works even when
  // Firestore completionLog permissions are not deployed yet.
  try {
    const key = 'pmdek-completion-log';
    const current = JSON.parse(localStorage.getItem(key) || '[]');
    current.push({
      id: `local-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      cardId,
      cardTitle,
      boardId: getBoardId(),
      userId: _currentUid,
      type,
      ...extra,
      completedAtIso: new Date().toISOString(),
    });
    // Keep most recent 1000 events to cap storage growth.
    localStorage.setItem(key, JSON.stringify(current.slice(-1000)));
  } catch (_) {
    // ignore local storage failures
  }

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
function openCardModal({ columnId, cardId, title = '', description = '', checkable = false, subtasks = [], startDate = null, dueDate = null, recurring = false, recurrenceFrequency = 'weekly', attachments = [], comments = [], assignees = [] }) {
  const modalRoot = document.getElementById('modal-root');
  const isEdit    = Boolean(cardId);

  // Local mutable copy of subtasks for the edit session
  let editSubtasks = subtasks.map((s) => ({ ...s }));
  // Local mutable copy of attachments
  let editAttachments = attachments.map((a) => ({ ...a }));
  // Local mutable copy of comments
  let editComments = Array.isArray(comments) ? [...comments] : [];
  // Pending new files chosen via file input
  let pendingFiles = [];
  // Local mutable set of assigned UIDs (only relevant in edit mode)
  let editAssignees = new Set(Array.isArray(assignees) ? assignees : []);

  // ── Assignees helpers ──────────────────────────────────────────────────────
  const _memberInitials = (member) => {
    const source = member?.displayName || member?.username || member?.email || '?';
    return source.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  };

  const _memberLabel = (member) => (
    member?.displayName
      ? `${member.displayName}${member.username ? ` (@${member.username})` : ''}`
      : `@${member?.username || member?.uid || 'member'}`
  );

  const _memberAvatar = (member, sizeClass = 'w-7 h-7', textClass = 'text-[10px]') => {
    const hoverName = member?.displayName || `@${member?.username || member?.uid || 'member'}`;
    if (member?.photoURL) {
      return `<img src="${escapeHtml(member.photoURL)}" alt="${escapeHtml(_memberLabel(member))}" title="${escapeHtml(hoverName)}" class="${sizeClass} rounded-full object-cover border border-white/25" />`;
    }
    const bg = _uidToColor(member?.uid || 'fallback');
    return `<span class="inline-flex items-center justify-center ${sizeClass} rounded-full ${textClass} font-bold text-white" style="background:${bg}" title="${escapeHtml(hoverName)}">${escapeHtml(_memberInitials(member))}</span>`;
  };

  const _assignedProfiles = () => {
    const selected = [...editAssignees]
      .map((uid) => _boardAssignedMembers.find((m) => m.uid === uid))
      .filter(Boolean);
    selected.sort((a, b) => _memberLabel(a).toLowerCase().localeCompare(_memberLabel(b).toLowerCase()));
    return selected;
  };

  const _assigneesSectionInner = () => {
    if (!isEdit || _boardAssignedMembers.length === 0) return '';
    const selected = _assignedProfiles();
    return `
      <div class="flex items-center justify-between mb-2">
        <p class="text-sm font-medium text-gray-700">Assignees</p>
        <button type="button" id="modal-add-assignee-btn"
          class="inline-flex items-center justify-center w-7 h-7 rounded-full border border-gray-300 text-gray-600 hover:bg-gray-50 hover:text-gray-900 transition-colors"
          title="Add assignee">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
        </button>
      </div>
      <div id="modal-assignees-picked" class="flex flex-wrap gap-2">
        ${selected.length
          ? selected.map((m) => `
            <span class="relative inline-flex" title="${escapeHtml(_memberLabel(m))}">
              ${_memberAvatar(m)}
              <button type="button" class="modal-assignee-remove absolute -top-1 -right-1 w-4 h-4 rounded-full bg-black/70 text-white text-[9px] leading-none hover:bg-red-600 transition-colors"
                data-uid="${escapeHtml(m.uid)}" aria-label="Remove ${escapeHtml(_memberLabel(m))}">×</button>
            </span>
          `).join('')
          : '<p class="text-xs text-gray-400">No assignees yet. Click + to add people.</p>'}
      </div>`;
  };

  const _openAssigneePickerModal = () => {
    const existing = document.getElementById('assignee-picker-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'assignee-picker-overlay';
    overlay.className = 'fixed inset-0 bg-black/30 flex items-center justify-center z-[60] p-4';

    const close = () => overlay.remove();

    const render = (term = '') => {
      const q = term.trim().toLowerCase();
      const available = _boardAssignedMembers
        .filter((m) => !editAssignees.has(m.uid))
        .filter((m) => {
          if (!q) return true;
          const hay = `${m.displayName || ''} ${m.username || ''} ${m.email || ''}`.toLowerCase();
          return hay.includes(q);
        })
        .sort((a, b) => _memberLabel(a).toLowerCase().localeCompare(_memberLabel(b).toLowerCase()));

      overlay.innerHTML = `
        <div class="bg-white rounded-xl shadow-xl w-full max-w-md p-4">
          <div class="flex items-center justify-between mb-3">
            <h4 class="text-sm font-semibold text-gray-800">Add Assignee</h4>
            <button type="button" id="assignee-picker-close" class="text-gray-400 hover:text-gray-700">✕</button>
          </div>
          <input id="assignee-picker-search" type="text" value="${escapeHtml(term)}" placeholder="Search users by name or @username"
            class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500 mb-3" />
          <div class="max-h-72 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100">
            ${available.length
              ? available.map((m) => `
                <button type="button" class="assignee-picker-add w-full flex items-center justify-between px-3 py-2 hover:bg-gray-50 text-left" data-uid="${escapeHtml(m.uid)}">
                  <span class="flex items-center gap-2 min-w-0">
                    ${_memberAvatar(m, 'w-6 h-6', 'text-[9px]')}
                    <span class="text-sm text-gray-700 truncate">${escapeHtml(_memberLabel(m))}</span>
                  </span>
                  <span class="text-xs text-brand-600 font-medium">Add</span>
                </button>
              `).join('')
              : '<p class="px-3 py-4 text-xs text-gray-400">No matching users.</p>'}
          </div>
        </div>`;

      overlay.querySelector('#assignee-picker-close')?.addEventListener('click', close);
      overlay.querySelector('#assignee-picker-search')?.addEventListener('input', (e) => render(e.target.value));
      overlay.querySelectorAll('.assignee-picker-add').forEach((btn) => {
        btn.addEventListener('click', () => {
          editAssignees.add(btn.dataset.uid);
          _renderAssignees();
          close();
        });
      });
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    document.body.appendChild(overlay);
    render('');
    overlay.querySelector('#assignee-picker-search')?.focus();
  };

  const _bindAssigneeSectionEvents = () => {
    document.getElementById('modal-add-assignee-btn')?.addEventListener('click', _openAssigneePickerModal);
    document.querySelectorAll('.modal-assignee-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        editAssignees.delete(btn.dataset.uid);
        _renderAssignees();
      });
    });
  };

  const _renderAssignees = () => {
    const section = document.getElementById('modal-assignees-section');
    if (!section) return;
    section.innerHTML = _assigneesSectionInner();
    _bindAssigneeSectionEvents();
  };

  const _subtaskRowHtml = (s) => `
    <li class="flex items-center gap-2 group" data-subtask-id="${escapeHtml(s.id)}">
      <input type="checkbox" class="modal-subtask-check flex-shrink-0 rounded border-gray-300 text-brand-500 focus:ring-brand-400" ${s.completed ? 'checked' : ''} />
      <input type="text" class="modal-subtask-title flex-1 text-sm border-0 border-b border-transparent focus:border-gray-300 focus:ring-0 bg-transparent px-0 py-0.5 ${s.completed ? 'line-through text-gray-400' : 'text-gray-700'}" value="${escapeHtml(s.title)}" placeholder="Subtask…" maxlength="200" />
      ${_boardAssignedMembers.length > 0 ? `
        <select class="modal-subtask-assignee rounded border-gray-300 text-xs focus:ring-brand-500 focus:border-brand-500" data-subtask-id="${escapeHtml(s.id)}">
          <option value="">Unassigned</option>
          ${_boardAssignedMembers.map((m) => `<option value="${escapeHtml(m.uid)}" ${s.assignee === m.uid ? 'selected' : ''}>${escapeHtml(m.displayName || `@${m.username || m.uid}`)}</option>`).join('')}
        </select>
      ` : ''}
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
    editSubtasks.push({ id, title: '', completed: false, assignee: null });
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

    section.querySelectorAll('.modal-subtask-assignee').forEach((sel) => {
      sel.addEventListener('change', () => {
        const id = sel.dataset.subtaskId;
        editSubtasks = editSubtasks.map((s) => s.id === id ? { ...s, assignee: sel.value || null } : s);
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

  // ── Comments helpers ───────────────────────────────────────────────────────

  const _commentRowHtml = (c) => `
    <li class="flex flex-col gap-0.5 py-2 border-b border-gray-100 last:border-0">
      <div class="flex items-center gap-2">
        <span class="text-xs font-semibold text-gray-800">${escapeHtml(c.displayName || 'User')}</span>
        <span class="text-[10px] text-gray-400">${_formatCommentTime(c.createdAt)}</span>
      </div>
      <p class="text-sm text-gray-600 whitespace-pre-wrap">${escapeHtml(c.text || '')}</p>
    </li>
  `;

  const _commentsSectionInner = () => `
    <div class="flex items-center justify-between mb-1">
      <p class="text-sm font-medium text-gray-700">Comments</p>
    </div>
    ${editComments.length ? `<ul id="modal-comments-list" class="flex flex-col mb-3 max-h-48 overflow-y-auto">${editComments.map(_commentRowHtml).join('')}</ul>` : '<p class="text-xs text-gray-400 mb-2">No comments yet.</p>'}
    <div class="flex gap-2">
      <input id="modal-comment-input" type="text" placeholder="Add a comment…" maxlength="500"
        class="flex-1 rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500" />
      <button type="button" id="modal-comment-submit"
        class="px-3 py-1.5 text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg transition-colors flex-shrink-0">
        Post
      </button>
    </div>
  `;

  const _renderComments = () => {
    const section = document.getElementById('modal-comments-section');
    if (section) {
      section.innerHTML = _commentsSectionInner();
      _bindCommentEvents();
    }
  };

  const _bindCommentEvents = () => {
    const submitBtn = document.getElementById('modal-comment-submit');
    submitBtn?.addEventListener('click', async () => {
      const input = document.getElementById('modal-comment-input');
      const text = (input?.value || '').trim();
      if (!text || !cardId) return;
      submitBtn.disabled = true;
      // Read freshest comments from live snapshot
      const freshCard = _lastCards.find((c) => c.id === cardId) || {};
      const freshComments = Array.isArray(freshCard.comments) ? freshCard.comments : [];
      const newComment = {
        id: `cmnt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        userId: _currentUid || '',
        displayName: _currentUserDisplayName || 'User',
        text,
        createdAt: new Date().toISOString(),
      };
      editComments = [...freshComments, newComment];
      try {
        await updateCard(cardId, { comments: editComments });
        if (input) input.value = '';
        _renderComments();
      } catch (err) {
        console.error('Comment save failed:', err);
      } finally {
        submitBtn.disabled = false;
      }
    });
    document.getElementById('modal-comment-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('modal-comment-submit')?.click(); }
    });
  };

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-xl md:max-w-2xl lg:max-w-3xl max-h-[90vh] overflow-y-auto p-6">
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
            <label class="block text-sm font-medium text-gray-700 mb-1" for="card-start-date">Start date <span class="text-gray-400 font-normal">(optional)</span></label>
            <input
              id="card-start-date"
              type="date"
              class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500"
              value="${startDate || ''}"
            />
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
          <div>
            <label class="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                id="card-recurring"
                type="checkbox"
                class="rounded border-gray-300 text-brand-500 focus:ring-brand-400"
                ${recurring ? 'checked' : ''}
              />
              <span class="text-sm text-gray-600">Recurring</span>
            </label>
            <div id="card-recurrence-wrap" class="mt-2 ${recurring ? '' : 'hidden'}">
              <label class="block text-sm font-medium text-gray-700 mb-1" for="card-recurrence-frequency">Frequency</label>
              <select id="card-recurrence-frequency"
                class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500">
                <option value="daily" ${recurrenceFrequency === 'daily' ? 'selected' : ''}>Daily</option>
                <option value="weekly" ${recurrenceFrequency === 'weekly' ? 'selected' : ''}>Weekly</option>
                <option value="monthly" ${recurrenceFrequency === 'monthly' ? 'selected' : ''}>Monthly</option>
                <option value="quarterly" ${recurrenceFrequency === 'quarterly' ? 'selected' : ''}>Quarterly</option>
                <option value="annual" ${recurrenceFrequency === 'annual' ? 'selected' : ''}>Annual</option>
              </select>
            </div>
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
          ${isEdit ? `<div id="modal-subtasks-section">${_subtasksSectionInner()}</div>` : ''}
          <div id="modal-attachments-section">${_attachmentsSectionInner()}</div>
            ${isEdit && _boardAssignedMembers.length > 0 ? `<div id="modal-assignees-section" class="border-t border-gray-100 pt-3">${_assigneesSectionInner()}</div>` : ''}
            ${isEdit ? `<div id="modal-comments-section" class="border-t border-gray-100 pt-3">${_commentsSectionInner()}</div>` : ''}
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
  if (isEdit) _bindCommentEvents();
  if (isEdit) _bindAssigneeSectionEvents();

  const recurringCheckbox = document.getElementById('card-recurring');
  const recurrenceWrap = document.getElementById('card-recurrence-wrap');
  const recurrenceSelect = document.getElementById('card-recurrence-frequency');
  const _toggleRecurrenceVisibility = () => {
    if (!recurrenceWrap) return;
    const checked = Boolean(recurringCheckbox?.checked);
    recurrenceWrap.classList.toggle('hidden', !checked);
    if (checked && recurrenceSelect && !recurrenceSelect.value) recurrenceSelect.value = 'weekly';
  };
  recurringCheckbox?.addEventListener('change', _toggleRecurrenceVisibility);
  _toggleRecurrenceVisibility();

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
    const newStartDate = document.getElementById('card-start-date').value || null;
    const newDueDate   = document.getElementById('card-due-date').value || null;
    const newRecurring = Boolean(document.getElementById('card-recurring')?.checked);
    const newRecurrenceFrequency = newRecurring
      ? (document.getElementById('card-recurrence-frequency')?.value || 'weekly')
      : null;
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
          subtasks: finalSubtasks, startDate: newStartDate, dueDate: newDueDate, attachments: finalAttachments,
          recurring: newRecurring,
          recurrenceFrequency: newRecurrenceFrequency,
            assignees: [...editAssignees],
        });
      } else {
        const listEl    = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
        const lastOrder = listEl?.children.length ?? 0;
        await createCard(columnId, newTitle, newDesc, lastOrder, newCheckable, [], newDueDate, finalAttachments, null, null, newRecurring, newRecurrenceFrequency, newStartDate);
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
let _currentUserDisplayName = '';

/** Returns the current uid for use in createCard. Exposed as a closure. */
function auth_uid() {
  if (!_currentUid) throw new Error('User not set. Call initCardEvents() first.');
  return _currentUid;
}

/**
 * Builds tiny assignee initials bubbles for the card tile footer.
 * Only renders the first 3 assignees, then shows a "+N" overflow badge.
 * @param {string[]} assignees  Array of UIDs
 * @returns {string} HTML string
 */
function _buildAssigneeChips(assignees) {
  if (!Array.isArray(assignees) || assignees.length === 0) return '';
  const profiles = assignees
    .map((uid) => _boardAssignedMembers.find((m) => m.uid === uid))
    .filter(Boolean);
  if (profiles.length === 0) return '';

  const initials = (p) => {
    const name = p.displayName || p.username || p.email || '?';
    return name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  };

  const chips = profiles.map((p) => {
    const hoverName = p.displayName || `@${p.username || p.uid}`;
    const altText = p.displayName ? `${p.displayName} (@${p.username || ''})` : `@${p.username || p.uid}`;
    if (p.photoURL) {
      return `<img src="${escapeHtml(p.photoURL)}" alt="${escapeHtml(altText)}" class="w-5 h-5 rounded-full object-cover border border-white/25 flex-shrink-0" title="${escapeHtml(hoverName)}" />`;
    }
    const bg = _uidToColor(p.uid);
    return `<span class="inline-flex items-center justify-center w-5 h-5 rounded-full text-[9px] font-bold text-white flex-shrink-0" style="background:${bg}" title="${escapeHtml(hoverName)}">${escapeHtml(initials(p))}</span>`;
  }).join('');
  return `<div class="flex items-center gap-0.5 mt-1.5 flex-wrap">${chips}</div>`;
}

/** Deterministic color from a UID string for assignee bubbles. */
function _uidToColor(uid) {
  const COLORS = ['#6366f1','#8b5cf6','#ec4899','#ef4444','#f97316','#d97706','#22c55e','#14b8a6','#3b82f6'];
  let hash = 0;
  for (let i = 0; i < uid.length; i++) hash = (hash * 31 + uid.charCodeAt(i)) >>> 0;
  return COLORS[hash % COLORS.length];
}

/** Member profiles assigned to the current board — passed in from main.js. */
let _boardAssignedMembers = [];

/**
 * Sets the list of member profiles for the currently open board.
 * Called by main.js after loading board.assignedMembers profiles.
 * @param {object[]} profiles  Array of user profile objects from /users/{uid}
 */
export function setBoardAssignedMembers(profiles) {
  _boardAssignedMembers = Array.isArray(profiles) ? profiles : [];
}

export function getBoardAssignedMembers() {
  return [..._boardAssignedMembers];
}

function _formatRecurrenceFrequency(value) {
  const map = {
    daily: 'Daily',
    weekly: 'Weekly',
    monthly: 'Monthly',
    quarterly: 'Quarterly',
    annual: 'Annual',
  };
  return map[String(value || '').toLowerCase()] || 'Weekly';
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

// ─── Recurring automation ─────────────────────────────────────────────────────

/**
 * When a recurring card is checked complete, clone it into the first board
 * column with its subtasks reset and the next due date applied.
 */
async function _handleRecurringComplete(cardId, cardEl) {
  const firstCol = document.querySelector('#columns-wrapper .column');
  const firstColumnId = firstCol?.dataset.columnId;
  if (!firstColumnId) return;

  const title = cardEl.querySelector('.card-title')?.textContent?.replace(/\s*\d+\/\d+$/, '').trim() || '';
  const desc = cardEl.querySelector('.card-desc')?.textContent?.trim() || '';
  const freq = cardEl.dataset.recurrenceFrequency || 'weekly';
  const currentDue = cardEl.dataset.dueDate || null;
  const nextDue = _computeNextDueDate(currentDue, freq);

  let subtasks = [];
  try { subtasks = JSON.parse(cardEl.dataset.subtasks || '[]'); } catch (_) {}
  const freshSubtasks = subtasks.map((s) => ({
    ...s,
    id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    completed: false,
  }));

  const lastOrder = firstCol.querySelectorAll('.card').length;
  await createCard(firstColumnId, title, desc, lastOrder, Boolean(cardEl.dataset.checkable === 'true'), freshSubtasks, nextDue, [], null, null, true, freq);
}

function _computeNextDueDate(currentDue, frequency) {
  const base = currentDue ? new Date(currentDue + 'T00:00:00') : new Date();
  switch (frequency) {
    case 'daily':     base.setDate(base.getDate() + 1); break;
    case 'weekly':    base.setDate(base.getDate() + 7); break;
    case 'monthly':   base.setMonth(base.getMonth() + 1); break;
    case 'quarterly': base.setMonth(base.getMonth() + 3); break;
    case 'annual':    base.setFullYear(base.getFullYear() + 1); break;
    default:          base.setDate(base.getDate() + 7);
  }
  return base.toISOString().split('T')[0];
}

// ─── Clone card ───────────────────────────────────────────────────────────────

async function _cloneCard(cardId, cardEl) {
  const columnId = cardEl.closest('.card-list')?.dataset.columnId;
  if (!columnId) return;

  const title = cardEl.querySelector('.card-title')?.textContent?.replace(/\s*\d+\/\d+$/, '').trim() || '';
  const desc = cardEl.querySelector('.card-desc')?.textContent?.trim() || '';
  let subtasks = [], attachments = [];
  let recurring = false;
  let recurrenceFrequency = 'weekly';
  try { subtasks = JSON.parse(cardEl.dataset.subtasks || '[]'); } catch (_) {}
  try { attachments = JSON.parse(cardEl.dataset.attachments || '[]'); } catch (_) {}
  try { recurring = JSON.parse(cardEl.dataset.recurring || 'false'); } catch (_) {}
  recurrenceFrequency = cardEl.dataset.recurrenceFrequency || 'weekly';

  const freshSubtasks = subtasks.map((s) => ({
    ...s,
    id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    completed: false,
  }));

  const listEl = document.querySelector(`.card-list[data-column-id="${columnId}"]`);
  const lastOrder = listEl?.children.length ?? 0;

  await createCard(
    columnId, `${title} (copy)`, desc, lastOrder,
    Boolean(cardEl.dataset.checkable === 'true'),
    freshSubtasks, cardEl.dataset.dueDate || null,
    attachments, null, null, recurring, recurrenceFrequency,
  );
}

// ─── Comment time helper ──────────────────────────────────────────────────────

function _formatCommentTime(isoString) {
  try {
    const d = new Date(isoString);
    const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1)  return 'just now';
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24)   return `${diffH}h ago`;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch { return ''; }
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
