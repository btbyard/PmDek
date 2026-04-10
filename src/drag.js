/**
 * @module drag
 * @description
 * Drag-and-drop for Kanban cards using the native HTML5 Drag and Drop API.
 *
 * Why native DnD instead of a library?
 *  - Zero dependencies
 *  - Works on desktop (touch is a v0.2 concern)
 *  - The Kanban use case is simple enough that the API surface is manageable
 *
 * How it works:
 *  1. `initDragAndDrop()` attaches dragstart/dragend to every `.card`
 *     and dragover/dragleave/drop to every `.card-list`.
 *  2. On dragstart we store the dragged card's id and its source column.
 *  3. On drop we compute the target card (the one we're hovering over, if any),
 *     read its order neighbours, and call `moveCard()` to persist the change.
 *  4. Visual feedback: a `.drag-over` class highlights the drop target column.
 *
 * Called from `cards.js` after every DOM re-render so new card elements
 * always get fresh listeners.
 */

import { moveCard } from './cards.js';

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {{ cardId: string, sourceColumnId: string } | null} */
let dragging = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Attaches DnD event listeners to all `.card` and `.card-list` elements
 * currently in the DOM.
 *
 * Safe to call repeatedly — listeners are added to elements that do not yet
 * have the `data-dnd-init` attribute, preventing duplicate handlers.
 */
export function initDragAndDrop() {
  document.querySelectorAll('.card:not([data-dnd-init])').forEach((card) => {
    card.setAttribute('data-dnd-init', '1');
    card.addEventListener('dragstart', onDragStart);
    card.addEventListener('dragend',   onDragEnd);
  });

  document.querySelectorAll('.card-list:not([data-dnd-init])').forEach((list) => {
    list.setAttribute('data-dnd-init', '1');
    list.addEventListener('dragover',  onDragOver);
    list.addEventListener('dragleave', onDragLeave);
    list.addEventListener('drop',      onDrop);
  });
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/** @param {DragEvent} e */
function onDragStart(e) {
  dragging = {
    cardId:       this.dataset.cardId,
    sourceColumn: this.closest('.card-list').dataset.columnId,
  };

  // Ghost image has a slight delay so the original card starts fading.
  setTimeout(() => this.classList.add('opacity-40'), 0);

  e.dataTransfer.effectAllowed  = 'move';
  e.dataTransfer.setData('text/plain', dragging.cardId); // required for Firefox
}

/** @param {DragEvent} _e */
function onDragEnd(_e) {
  this.classList.remove('opacity-40');
  removeDragOver();
  dragging = null;
}

/** @param {DragEvent} e */
function onDragOver(e) {
  e.preventDefault(); // required to allow drop
  e.dataTransfer.dropEffect = 'move';

  const list = e.currentTarget;
  list.classList.add('drag-over', 'bg-brand-50', 'ring-2', 'ring-brand-200');

  // Show a drop indicator line before the card under the cursor
  clearDropIndicators();
  const afterCard = getDragAfterElement(list, e.clientY);
  const indicator = createDropIndicator();
  if (afterCard == null) {
    list.appendChild(indicator);
  } else {
    list.insertBefore(indicator, afterCard);
  }
}

/** @param {DragEvent} e */
function onDragLeave(e) {
  // Only clear if we actually left the list (not entered a child)
  if (!e.currentTarget.contains(e.relatedTarget)) {
    e.currentTarget.classList.remove('drag-over', 'bg-brand-50', 'ring-2', 'ring-brand-200');
    clearDropIndicators();
  }
}

/** @param {DragEvent} e */
async function onDrop(e) {
  e.preventDefault();
  if (!dragging) return;

  const list         = e.currentTarget;
  const targetColumn = list.dataset.columnId;

  removeDragOver();
  clearDropIndicators();

  // Determine position among existing cards (excluding the indicator)
  const cards     = [...list.querySelectorAll('.card')];
  const afterCard = getDragAfterElement(list, e.clientY);

  // afterCard is the card BELOW the drop position; we want the card ABOVE.
  const afterIndex = afterCard ? cards.indexOf(afterCard) - 1 : cards.length - 1;

  const prevEl    = cards[afterIndex];
  const nextEl    = afterCard instanceof HTMLElement && afterCard.classList.contains('card')
                      ? afterCard
                      : null;

  const prevOrder = prevEl  ? parseFloat(prevEl.dataset.order  ?? prevEl.style.order ?? 0) : null;
  const nextOrder = nextEl  ? parseFloat(nextEl.dataset.order  ?? nextEl.style.order ?? 0) : null;

  // Bail out if dropped in same position in same column
  const isSameColumn = targetColumn === dragging.sourceColumn;
  if (isSameColumn && prevEl?.dataset.cardId === dragging.cardId) return;

  try {
    await moveCard(dragging.cardId, targetColumn, prevOrder, nextOrder);
  } catch (err) {
    console.error('Move card failed:', err);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the card element that the dragged card should be inserted before,
 * based on the mouse Y position.
 *
 * @param {HTMLElement} container
 * @param {number} y  e.clientY
 * @returns {HTMLElement | undefined}
 */
function getDragAfterElement(container, y) {
  const draggableCards = [...container.querySelectorAll('.card:not([data-dnd-dragging])')];

  return draggableCards.reduce(
    (closest, child) => {
      const box    = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset, element: child };
      }
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY },
  ).element;
}

/** Creates the visual drop position indicator. */
function createDropIndicator() {
  const el = document.createElement('div');
  el.className = 'drop-indicator h-0.5 bg-brand-500 rounded mx-1 my-1';
  return el;
}

function clearDropIndicators() {
  document.querySelectorAll('.drop-indicator').forEach((el) => el.remove());
}

function removeDragOver() {
  document.querySelectorAll('.card-list').forEach((l) => {
    l.classList.remove('drag-over', 'bg-brand-50', 'ring-2', 'ring-brand-200');
  });
}
