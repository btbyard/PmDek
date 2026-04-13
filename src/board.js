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
  orderBy,
  startAfter,
  limit,
  documentId,
  getDocs,
  serverTimestamp,
} from 'firebase/firestore';

import { db } from './firebase.js';
import { reRenderCards, updateAllCardsBackground } from './cards.js';
import { canCreateDeck, assertProjectTypeAllowed } from './billing.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Palette shared across boards-home tile accents and the in-deck color selector. */
export const DECK_COLORS = [
  { value: '#6366f1', label: 'Indigo' },
  { value: '#8b5cf6', label: 'Purple' },
  { value: '#ec4899', label: 'Pink'   },
  { value: '#ef4444', label: 'Red'    },
  { value: '#fdba74', label: 'Peach'  },
  { value: '#f97316', label: 'Orange' },
  { value: '#d97706', label: 'Amber'  },
  { value: '#22c55e', label: 'Green'  },
  { value: '#14b8a6', label: 'Teal'   },
  { value: '#7dd3fc', label: 'Sky'    },
  { value: '#93c5fd', label: 'Light Blue' },
  { value: '#3b82f6', label: 'Blue'   },
  { value: '#cbd5e1', label: 'Light Gray' },
  { value: '#9ca3af', label: 'Gray'   },
  { value: '#64748b', label: 'Slate'  },
];

/** Default columns created with every new board. Order value drives left-to-right display. */
export const DEFAULT_COLUMNS = [
  { id: 'todo',        title: 'Todo',        order: 0 },
  { id: 'in-progress', title: 'In Progress', order: 1 },
  { id: 'done',        title: 'Done',        order: 2 },
];

/** Project type options shown in Create Deck. */
export const PROJECT_TYPES = [
  { value: 'standard',       label: 'Standard' },
  { value: 'weekly',         label: 'Weekly' },
  { value: 'recurring',      label: 'Recurring' },
  { value: 'scrum',          label: 'Scrum' },
  { value: 'waterfall-se',   label: 'Waterfall' },
  { value: 'agile-se',       label: 'Agile' },
  { value: 'sdlc',           label: 'SDLC' },
  { value: 'cybersecurity',  label: 'Cybersecurity' },
  { value: 'data-analyst',   label: 'Data Analyst' },
  { value: 'data-engineering', label: 'Data Engineering' },
  { value: 'licensing',        label: 'Licensing' },
];

const PROJECT_TYPE_COLUMNS = {
  standard: [
    { id: 'todo',        title: 'Todo',        order: 0 },
    { id: 'in-progress', title: 'In Progress', order: 1 },
    { id: 'done',        title: 'Done',        order: 2 },
  ],
  weekly: [
    { id: 'last-week',    title: 'Last Week',    order: 0 },
    { id: 'current-week', title: 'Current Week', order: 1 },
    { id: 'next-week',    title: 'Next Week',    order: 2 },
  ],
  recurring: [
    { id: 'upcoming',      title: 'Upcoming',      order: 0 },
    { id: 'ready-this-week', title: 'Ready This Week', order: 1 },
    { id: 'in-progress',   title: 'In Progress',   order: 2 },
    { id: 'blocked',       title: 'Blocked',       order: 3 },
    { id: 'done-cycle',    title: 'Completed This Cycle', order: 4 },
  ],
  'waterfall-se': [
    { id: 'requirements',  title: 'Requirements',  order: 0 },
    { id: 'design',        title: 'Design',        order: 1 },
    { id: 'implementation',title: 'Implementation',order: 2 },
    { id: 'verification',  title: 'Verification',  order: 3 },
    { id: 'maintenance',   title: 'Maintenance',   order: 4 },
  ],
  'agile-se': [
    { id: 'backlog',      title: 'Backlog',      order: 0 },
    { id: 'sprint-ready', title: 'Sprint Ready', order: 1 },
    { id: 'in-progress',  title: 'In Progress',  order: 2 },
    { id: 'review',       title: 'Review',       order: 3 },
    { id: 'done',         title: 'Done',         order: 4 },
  ],
  sdlc: [
    { id: 'planning',    title: 'Planning',    order: 0 },
    { id: 'analysis',    title: 'Analysis',    order: 1 },
    { id: 'design',      title: 'Design',      order: 2 },
    { id: 'development', title: 'Development', order: 3 },
    { id: 'testing',     title: 'Testing',     order: 4 },
    { id: 'deployment',  title: 'Deployment',  order: 5 },
    { id: 'maintenance', title: 'Maintenance', order: 6 },
  ],
  scrum: [
    { id: 'product-backlog', title: 'Product Backlog', order: 0 },
    { id: 'sprint-backlog',  title: 'Sprint Backlog',  order: 1 },
    { id: 'in-progress',     title: 'In Progress',     order: 2 },
    { id: 'in-review',       title: 'In Review',       order: 3 },
    { id: 'done',            title: 'Done',            order: 4 },
  ],
  cybersecurity: [
    { id: 'monitoring',   title: 'Monitoring',         order: 0 },
    { id: 'detected',     title: 'Threat Detected',    order: 1 },
    { id: 'investigating',title: 'Investigating',       order: 2 },
    { id: 'containing',   title: 'Containing',         order: 3 },
    { id: 'resolved',     title: 'Resolved',           order: 4 },
  ],
  'data-analyst': [
    { id: 'questions',       title: 'Business Questions', order: 0 },
    { id: 'data-prep',       title: 'Data Prep',          order: 1 },
    { id: 'analysis',        title: 'Analysis',           order: 2 },
    { id: 'insights-review', title: 'Insights Review',    order: 3 },
    { id: 'reporting',       title: 'Reporting',          order: 4 },
  ],
  'data-engineering': [
    { id: 'intake',        title: 'Source Intake',     order: 0 },
    { id: 'pipeline-dev',  title: 'Pipeline Dev',      order: 1 },
    { id: 'quality-check', title: 'Quality Checks',    order: 2 },
    { id: 'orchestration', title: 'Orchestration',     order: 3 },
    { id: 'published',     title: 'Published',         order: 4 },
  ],
  licensing: [
    { id: 'active',         title: 'Active Licenses',      order: 0 },
    { id: 'expiring-soon',  title: 'Expiring Soon',        order: 1 },
    { id: 'renewal-review', title: 'Renewal Review',       order: 2 },
    { id: 'pending-approval', title: 'Pending Approval',   order: 3 },
    { id: 'renewed',        title: 'Renewed',              order: 4 },
    { id: 'expired',        title: 'Expired / Deprecated', order: 5 },
  ],
};

/**
 * Returns a deep-ish copy of default columns for a project type.
 * Falls back to Standard for unknown values.
 *
 * @param {string} projectType
 * @returns {Array<{id: string, title: string, order: number}>}
 */
export function getDefaultColumnsForProjectType(projectType = 'standard') {
  const cols = PROJECT_TYPE_COLUMNS[projectType] || PROJECT_TYPE_COLUMNS.standard;
  return cols.map((c) => ({ ...c }));
}

// Module-level cache — set once after board is loaded, read by cards.js.
let _boardId = null;

// Track whether the deck-color outside-click listener has been initialised.
let _deckColorListenerInited = false;

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
 * @param {Array<{id: string, title: string, order: number}>} [columns=DEFAULT_COLUMNS]
 * @param {string|null} [dueDate=null]
 * @param {string|null} [color=null]
 * @param {string} [projectType='standard']
 * @returns {Promise<string>} boardId
 */
export async function createBoard(user, title = 'My Board', columns = DEFAULT_COLUMNS, dueDate = null, color = null, projectType = 'standard', { visibility = 'private', orgId = null, assignedMembers = [], projectDeckOwnerId = null } = {}) {
  const deckGate = await canCreateDeck(user.uid);
  if (!deckGate.allowed) {
    throw new Error(`Deck limit reached for ${deckGate.plan.label} (${deckGate.limit}).`);
  }
  await assertProjectTypeAllowed(user.uid, projectType || 'standard');

  const ref = await addDoc(collection(db, 'boards'), {
    userId:    user.uid,
    title:     title.trim() || 'My Board',
    columns:   columns,
    dueDate:   dueDate || null,
    color:     color || null,
    projectType: projectType || 'standard',
    visibility:      visibility || 'private',
    orgId:           orgId || null,
    assignedMembers: Array.isArray(assignedMembers) ? assignedMembers : [],
    projectDeckOwnerId: visibility === 'org' ? (projectDeckOwnerId || user.uid || null) : null,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

/**
 * Fetches org-visible boards for one or more organizations.
 * Uses chunked "in" queries to stay within Firestore constraints.
 *
 * @param {string[]} orgIds
 * @returns {Promise<Array<object>>}
 */
export async function getOrgBoards(orgIds = []) {
  if (!Array.isArray(orgIds) || orgIds.length === 0) return [];

  const cleanOrgIds = [...new Set(orgIds.filter(Boolean))];
  if (cleanOrgIds.length === 0) return [];

  const seen = new Set();
  const boards = [];
  await Promise.all(cleanOrgIds.map(async (orgId) => {
    let cursor = null;

    while (true) {
      const constraints = [
        where('orgId', '==', orgId),
        where('visibility', '==', 'org'),
        orderBy(documentId()),
        limit(10),
      ];
      if (cursor) constraints.push(startAfter(cursor));

      const snap = await getDocs(query(collection(db, 'boards'), ...constraints));
      if (snap.empty) break;

      snap.docs.forEach((d) => {
        if (seen.has(d.id)) return;
        const data = d.data() || {};
        seen.add(d.id);
        boards.push({ id: d.id, ...data });
      });

      if (snap.size < 10) break;
      cursor = snap.docs[snap.docs.length - 1];
    }
  }));

  boards.sort((a, b) => (a.createdAt?.seconds ?? 0) - (b.createdAt?.seconds ?? 0));
  return boards;
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
 * Returns per-board task and subtask counts for all cards owned by a user.
 *
 * @param {string} userId
 * @returns {Promise<Map<string, {taskCount: number, subtaskCount: number}>>}
 */
export async function getCardStatsByUserId(userId) {
  const q    = query(collection(db, 'cards'), where('userId', '==', userId));
  const snap = await getDocs(q);
  /** @type {Map<string, {taskCount: number, subtaskCount: number}>} */
  const stats = new Map();
  snap.docs.forEach((d) => {
    const { boardId, subtasks } = d.data();
    if (!boardId) return;
    const entry = stats.get(boardId) ?? { taskCount: 0, subtaskCount: 0 };
    entry.taskCount += 1;
    entry.subtaskCount += Array.isArray(subtasks) ? subtasks.length : 0;
    stats.set(boardId, entry);
  });
  return stats;
}

/**
 * Returns per-board task and subtask counts for a specific board ID set.
 *
 * @param {string[]} boardIds
 * @returns {Promise<Map<string, {taskCount: number, subtaskCount: number}>>}
 */
export async function getCardStatsByBoardIds(boardIds = []) {
  const cleanBoardIds = [...new Set((Array.isArray(boardIds) ? boardIds : []).filter(Boolean))];
  if (cleanBoardIds.length === 0) return new Map();

  const chunks = [];
  for (let i = 0; i < cleanBoardIds.length; i += 10) {
    chunks.push(cleanBoardIds.slice(i, i + 10));
  }

  const stats = new Map();
  const snaps = await Promise.all(
    chunks.map((chunk) => getDocs(query(collection(db, 'cards'), where('boardId', 'in', chunk))))
  );

  snaps.forEach((snap) => {
    snap.docs.forEach((d) => {
      const { boardId, subtasks } = d.data();
      if (!boardId) return;
      const entry = stats.get(boardId) ?? { taskCount: 0, subtaskCount: 0 };
      entry.taskCount += 1;
      entry.subtaskCount += Array.isArray(subtasks) ? subtasks.length : 0;
      stats.set(boardId, entry);
    });
  });

  return stats;
}

/**
 * Renames a board document.
 * @param {string} boardId
 * @param {string} newTitle
 * @param {string|null} [dueDate=null]
 * @returns {Promise<void>}
 */
export async function renameBoard(boardId, newTitle, dueDate = null, { visibility, orgId, assignedMembers, projectDeckOwnerId } = {}) {
  const data = {
    title: newTitle.trim() || 'My Board',
    dueDate: dueDate || null,
  };
  if (visibility !== undefined) {
    data.visibility = visibility;
    data.orgId = visibility === 'org' ? (orgId || null) : null;
    data.assignedMembers = visibility === 'org' ? (assignedMembers || []) : [];
    data.projectDeckOwnerId = visibility === 'org' ? (projectDeckOwnerId || null) : null;
  }
  await updateDoc(doc(db, 'boards', boardId), data);
}

/**
 * Updates the colour of a board.
 * @param {string} boardId
 * @param {string|null} color  Hex string or null to clear.
 * @returns {Promise<void>}
 */
export async function updateBoardColor(boardId, color) {
  await updateDoc(doc(db, 'boards', boardId), { color: color || null });
}

/**
 * Updates the board column surface color used for column panels.
 * @param {string} boardId
 * @param {string|null} color
 * @returns {Promise<void>}
 */
export async function updateBoardColumnColor(boardId, color) {
  await updateDoc(doc(db, 'boards', boardId), { columnBgColor: color || null });
}

/**
 * Updates the board-level default task background color.
 * @param {string} boardId
 * @param {string|null} color
 * @returns {Promise<void>}
 */
export async function updateBoardTaskBgColor(boardId, color) {
  await updateDoc(doc(db, 'boards', boardId), { taskBgColor: color || null });
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
 * Archives a board by setting archived: true on the document.
 * @param {string} boardId
 * @returns {Promise<void>}
 */
export async function archiveBoard(boardId) {
  await updateDoc(doc(db, 'boards', boardId), { archived: true, archivedAt: serverTimestamp() });
}

/**
 * Restores an archived board by clearing the archived flag.
 * @param {string} boardId
 * @returns {Promise<void>}
 */
export async function unarchiveBoard(boardId) {
  await updateDoc(doc(db, 'boards', boardId), { archived: false, archivedAt: null });
}

/**
 * Creates a new column block on the active board and persists it.
 * Used by the top "Create Card" action (deck-level column creation).
 *
 * @param {string} [title='New Column']
 * @returns {Promise<void>}
 */
export async function createColumnBlock(title = 'New Card') {
  const boardId = getBoardId();
  const rawTitle = (title || '').trim() || 'New Card';

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
  reRenderCards();
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
  columnsWrapper.className = 'flex gap-4 items-start justify-center overflow-x-auto overflow-y-visible pb-4 px-4';
  columnsWrapper.id = 'columns-wrapper';

  columns.forEach((col) => {
    columnsWrapper.appendChild(buildColumnEl(col, board.id, columns));
  });
  _applyColumnSurfaceColor(board.columnBgColor, columnsWrapper);

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
  addColBtn.title = 'Add card';
  addColBtn.innerHTML = `
    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
    </svg>
  `;
  addColBtn.addEventListener('click', () => createColumnBlock());
  const actionStack = document.createElement('div');
  actionStack.className = 'flex flex-col gap-2 flex-shrink-0 self-start';
  actionStack.appendChild(addColBtn);

  // ── Global column-panel color selector (top button) ───────────────────
  const colBgWrap = document.createElement('div');
  colBgWrap.className = 'relative flex-shrink-0 self-start';

  const colBgBtn = document.createElement('button');
  colBgBtn.id        = 'deck-column-bg-btn';
  colBgBtn.className = 'w-10 h-10 mt-1 flex items-center justify-center rounded-full border-2 transition-all duration-150';
  _applyDeckColorBtnStyle(colBgBtn, board.columnBgColor, {
    title: 'Set column background color',
    icon: 'column',
  });

  const paletteSwatchesHtml = [
    { value: null,  label: 'Default (Black)' },
    ...DECK_COLORS,
  ].map((c) => {
    const active = board.columnBgColor === c.value;
    const style  = c.value
      ? `background:${c.value}`
      : 'background:#050506;border:2px solid rgba(255,255,255,0.45)';
    return `<button type="button" data-color="${c.value ?? ''}"
      class="deck-column-swatch w-7 h-7 rounded-full flex-shrink-0 hover:scale-110 transition-transform${active ? ' ring-2 ring-offset-2' : ''}"
      style="${style}${active && c.value ? `;outline:2px solid ${c.value};outline-offset:2px` : ''}" title="${c.label ?? 'None'}"></button>`;
  }).join('');

  const colBgPopup = document.createElement('div');
  colBgPopup.id        = 'deck-column-bg-popup';
  colBgPopup.className = 'deck-global-color-popup hidden absolute right-0 top-12 z-40 bg-white border border-gray-200 rounded-xl shadow-xl p-3 min-w-max';
  colBgPopup.innerHTML = `
    <p class="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Column panel color</p>
    <div class="flex flex-wrap gap-2" style="max-width:200px">${paletteSwatchesHtml}</div>
  `;

  colBgBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.deck-global-color-popup').forEach((p) => p.classList.add('hidden'));
    colBgPopup.classList.toggle('hidden');
  });

  colBgPopup.addEventListener('click', async (e) => {
    const swatch = e.target.closest('.deck-column-swatch');
    if (!swatch) return;
    const newColor = swatch.dataset.color || null;
    colBgPopup.classList.add('hidden');
    _applyDeckColorBtnStyle(colBgBtn, newColor, {
      title: 'Set column background color',
      icon: 'column',
    });
    board.columnBgColor = newColor;
    _applyColumnSurfaceColor(newColor, columnsWrapper);
    try {
      await updateBoardColumnColor(board.id, newColor);
    } catch (err) {
      console.error('Failed to update column panel color:', err);
    }
  });

  // ── Global task-card background selector (second button) ───────────────
  const taskBgWrap = document.createElement('div');
  taskBgWrap.className = 'relative flex-shrink-0 self-start';

  const taskBgBtn = document.createElement('button');
  taskBgBtn.id        = 'deck-task-bg-btn';
  taskBgBtn.className = 'w-10 h-10 flex items-center justify-center rounded-full border-2 transition-all duration-150';
  _applyDeckColorBtnStyle(taskBgBtn, board.taskBgColor, {
    title: 'Set task block color',
    icon: 'task',
  });

  const taskBgSwatchesHtml = [
    { value: null,  label: 'Default (Black)' },
    ...DECK_COLORS,
  ].map((c) => {
    const active = board.taskBgColor === c.value;
    const style  = c.value
      ? `background:${c.value}`
      : 'background:#050506;border:2px solid rgba(255,255,255,0.45)';
    return `<button type="button" data-color="${c.value ?? ''}"
      class="deck-task-bg-swatch w-7 h-7 rounded-full flex-shrink-0 hover:scale-110 transition-transform${active ? ' ring-2 ring-offset-2' : ''}"
      style="${style}${active && c.value ? `;outline:2px solid ${c.value};outline-offset:2px` : ''}" title="${c.label ?? 'None'}"></button>`;
  }).join('');

  const taskBgPopup = document.createElement('div');
  taskBgPopup.id        = 'deck-task-bg-popup';
  taskBgPopup.className = 'deck-global-color-popup hidden absolute right-0 top-10 z-40 bg-white border border-gray-200 rounded-xl shadow-xl p-3 min-w-max';
  taskBgPopup.innerHTML = `
    <p class="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Task block color</p>
    <div class="flex flex-wrap gap-2" style="max-width:200px">${taskBgSwatchesHtml}</div>
  `;

  taskBgBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.deck-global-color-popup').forEach((p) => p.classList.add('hidden'));
    taskBgPopup.classList.toggle('hidden');
  });

  taskBgPopup.addEventListener('click', async (e) => {
    const swatch = e.target.closest('.deck-task-bg-swatch');
    if (!swatch) return;
    const newColor = swatch.dataset.color || null;
    taskBgPopup.classList.add('hidden');
    _applyDeckColorBtnStyle(taskBgBtn, newColor, {
      title: 'Set task block color',
      icon: 'task',
    });
    board.taskBgColor = newColor;
    try {
      await Promise.all([
        updateBoardTaskBgColor(board.id, newColor),
        updateAllCardsBackground(board.id, newColor),
      ]);
    } catch (err) {
      console.error('Failed to update task block color:', err);
    }
  });

  _initDeckColorListener();
  colBgWrap.appendChild(colBgBtn);
  colBgWrap.appendChild(colBgPopup);
  taskBgWrap.appendChild(taskBgBtn);
  taskBgWrap.appendChild(taskBgPopup);
  actionStack.appendChild(colBgWrap);
  actionStack.appendChild(taskBgWrap);
  columnsWrapper.appendChild(actionStack);

  boardRoot.appendChild(columnsWrapper);
  _initColumnDrag(board.id, columns);
}

/** Applies visual style to the deck color toggle button. */
function _applyDeckColorBtnStyle(btn, color, opts = {}) {
  const title = opts.title || 'Set color';
  const icon = opts.icon || 'dots';
  if (color) {
    btn.style.background   = color;
    btn.style.borderColor  = color;
    btn.style.borderStyle  = 'solid';
    btn.style.boxShadow    = '0 4px 10px rgba(0,0,0,0.15)';
    btn.innerHTML          = '';
    btn.title              = title;
  } else {
    // Unset means default dark surface in this UI.
    btn.style.background   = '#050506';
    btn.style.borderColor  = 'rgba(255,255,255,0.45)';
    btn.style.borderStyle  = 'solid';
    btn.style.boxShadow    = '0 4px 12px rgba(0,0,0,0.12)';
    btn.title              = title;
    btn.innerHTML = '';
  }
}

function _applyColumnSurfaceColor(color, scopeEl = document) {
  const columns = scopeEl.querySelectorAll('.column');
  columns.forEach((colEl) => {
    if (color) {
      colEl.style.background = `linear-gradient(165deg, ${color}f0 0%, ${color}c9 55%, ${color}a8 100%)`;
      colEl.style.borderColor = 'rgba(255,255,255,0.22)';
    } else {
      colEl.style.background = '';
      colEl.style.borderColor = '';
    }
  });
}

/** Registers a single document click listener to close the deck-color popup. */
function _initDeckColorListener() {
  if (_deckColorListenerInited) return;
  _deckColorListenerInited = true;
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#deck-column-bg-btn') && !e.target.closest('#deck-column-bg-popup')
        && !e.target.closest('#deck-task-bg-btn') && !e.target.closest('#deck-task-bg-popup')) {
      document.querySelectorAll('.deck-global-color-popup').forEach((p) => p.classList.add('hidden'));
    }
  });
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
  delBtn.addEventListener('click', () => {
    const cardCount = el.querySelectorAll('.card').length;
    _openDeleteColumnModal(col, cardCount, async () => {
      const next = allColumns.filter((c) => c.id !== col.id);
      try {
        await saveColumns(boardId, next);
        renderBoard({ id: boardId, title: document.getElementById('board-title-display')?.textContent?.trim() || '', columns: next });
        reRenderCards();
      } catch (err) {
        console.error('Delete column failed:', err);
      }
    });
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
 * Shows a styled confirmation modal before deleting a column.
 * @param {{ id: string, title: string }} col
 * @param {number} cardCount
 * @param {() => Promise<void>} onConfirm
 */
function _openDeleteColumnModal(col, cardCount, onConfirm) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  const label = cardCount > 0
    ? `"${col.title}" and all <strong>${cardCount} task${cardCount !== 1 ? 's' : ''}</strong> will be permanently removed.`
    : `"${col.title}" will be permanently removed.`;

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <div class="flex items-start gap-3 mb-5">
          <div class="flex-shrink-0 w-9 h-9 rounded-full bg-red-100 flex items-center justify-center">
            <svg class="w-4 h-4 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
            </svg>
          </div>
          <div>
            <h3 class="text-sm font-semibold text-gray-900">Delete column?</h3>
            <p class="mt-1 text-sm text-gray-500">${label} This cannot be undone.</p>
          </div>
        </div>
        <div class="flex justify-end gap-2">
          <button id="del-col-cancel" class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">Cancel</button>
          <button id="del-col-confirm" class="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors">Delete</button>
        </div>
      </div>
    </div>`;

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('del-col-cancel').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
  document.getElementById('del-col-confirm').addEventListener('click', async () => {
    close();
    await onConfirm();
  });
}

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

