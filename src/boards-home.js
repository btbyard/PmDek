/**
 * @module boards-home
 * @description
 * Renders the Boards home page — the first screen after sign-in.
 *
 * Tiles are styled as tall playing cards. Each card has a settings gear (⚙)
 * in the top-right that opens a rename modal. Clicking the card body opens the board.
 */

import { getUserBoards, getCardStatsByUserId, createBoard, renameBoard, updateBoardColor, deleteBoard, archiveBoard, unarchiveBoard, DEFAULT_COLUMNS, setBoardId, DECK_COLORS, PROJECT_TYPES, getDefaultColumnsForProjectType } from './board.js';
import { generateBoard, generateBoardWithTasks }            from './ai.js';
import { createCard, updateAllCardsBackground, setCurrentUser } from './cards.js';
import { getUserProfile }                                   from './users.js';
import { getOrgMembers }                                    from './org.js';
import { getEffectiveUserPlan, BILLING_PLANS }              from './billing.js';

// Store the refresh callback so the rename modal can refresh the grid after saving.
let _onBoardOpen = null;
let _currentUser = null;
let _lastBoards = [];
/** @type {Map<string, {taskCount: number, subtaskCount: number}>} */
let _lastStats = new Map();
let _activeTab = 'current'; // 'current' | 'archived'
let _tabsInited = false;
const BOARDS_LOAD_TIMEOUT_MS = 7000;
const BOARD_WRITE_TIMEOUT_MS = 7000;

// ─── Public API ───────────────────────────────────────────────────────────────

export async function renderBoardsHome(user, onBoardOpen) {
  _currentUser = user;
  _onBoardOpen = onBoardOpen;

  const root = document.getElementById('boards-root');
  if (!root) return;

  _initTabs();
  _updateTabUI();

  if (_lastBoards.length === 0) {
    _lastBoards = _loadPersistedBoards(user.uid);
    _lastStats  = _loadPersistedStats(user.uid);
  }

  if (_lastBoards.length > 0) {
    _renderTiles(root, _lastBoards, { instant: true });
  } else {
    _renderLoadingTiles(root);
  }

  try {
    const [boards, stats] = await Promise.all([
      _withTimeout(getUserBoards(user.uid), BOARDS_LOAD_TIMEOUT_MS, 'Loading boards took too long.'),
      getCardStatsByUserId(user.uid).catch(() => new Map()),
    ]);
    _lastBoards = boards;
    _lastStats  = stats;
    _persistBoards(user.uid, boards);
    _persistStats(user.uid, stats);
    _renderTiles(root, boards);
  } catch (err) {
    console.error('Load boards failed:', err);

    if (_lastBoards.length > 0) {
      _renderTiles(root, _lastBoards, { instant: true });
      _renderBoardsNotice(root, 'Unable to refresh boards right now. Showing your last loaded boards.');
      return;
    }

    _renderBoardsError(root);
  }
}

export async function openCreateBoardModal(user, onCreated) {
  const modalRoot = document.getElementById('modal-root');

  const DEFAULT_COLOR = '#111827';

  // Load org context to determine if visibility selector should appear
  let orgMembers = [];
  let userOrgId  = null;
  try {
    const profile = await getUserProfile(user.uid);
    if (profile?.organizationId) {
      userOrgId  = profile.organizationId;
      orgMembers = await getOrgMembers(profile.organizationId);
    }
  } catch (_) { /* non-blocking — org features simply won't appear */ }

  const swatchesHtml = [
    { value: DEFAULT_COLOR, label: 'Default' },
    ...DECK_COLORS,
  ].map((c) => {
    const isDefault = c.value === DEFAULT_COLOR;
    return `<button type="button" data-color="${c.value}"
      class="deck-color-swatch w-7 h-7 rounded-full border-2 hover:scale-110 transition-transform ring-offset-1 flex-shrink-0"
      style="background:${c.value};border-color:${isDefault ? '#111827' : 'transparent'}${isDefault ? ';outline:2px solid #11182760;outline-offset:2px' : ''}" title="${c.label}"></button>`;
  }).join('');
  const defaultColorVal = DEFAULT_COLOR;
  const plan = await getEffectiveUserPlan(user.uid);
  
  // Helper: determine if a project type is premium
  const freePlanTypes = BILLING_PLANS.free.allowedProjectTypes;
  const isPremiumType = (typeValue) => !freePlanTypes.includes(typeValue);
  const canUseAnyType = plan.allowedProjectTypes === 'all';
  
  // Always show all project types, but mark premium ones
  const projectTypeOptionsHtml = PROJECT_TYPES.map((opt) => {
    const isPremium = isPremiumType(opt.value);
    const isLocked = isPremium && !canUseAnyType;
    const selected = opt.value === 'standard';
    return `
      <option value="${opt.value}" ${selected ? 'selected' : ''} data-is-locked="${isLocked}" data-is-premium="${isPremium}">
        ${opt.label}${isPremium ? ' (Premium)' : ''}
      </option>
    `;
  }).join('');

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <h3 class="text-lg font-semibold text-gray-800 mb-4">Create Deck</h3>
        <form id="create-board-form" class="flex flex-col gap-4">
          <input id="board-title-input" type="text" placeholder="Deck Name"
            required maxlength="60"
            class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500" />
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1" for="board-project-type-input">
              Project Type
            </label>
            <div id="project-type-dropdown-wrapper" class="relative">
              <button id="board-project-type-btn" type="button"
                class="w-full rounded-lg border border-gray-300 text-sm text-left px-3 py-2 focus:ring-brand-500 focus:border-brand-500 flex items-center justify-between bg-white hover:bg-gray-50 transition-colors">
                <span id="project-type-display">Standard</span>
                <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"/>
                </svg>
              </button>
              <select id="board-project-type-input" class="hidden" ${projectTypeOptionsHtml}>
              </select>
              <div id="project-type-options" class="hidden absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-lg shadow-lg max-h-64 overflow-y-auto">
                ${PROJECT_TYPES.map((opt) => {
                  const isPremium = isPremiumType(opt.value);
                  const isLocked = isPremium && !canUseAnyType;
                  const selected = opt.value === 'standard';
                  return `
                    <button type="button" class="project-type-option w-full text-left px-3 py-2.5 hover:bg-gray-100 flex items-center justify-between transition-colors border-b border-gray-100 last:border-0 ${selected ? 'bg-brand-50 text-brand-700' : ''}" 
                      data-value="${opt.value}" data-is-locked="${isLocked}" data-premium="${isPremium}">
                      <span class="flex items-center gap-2">
                        <span>${opt.label}</span>
                        ${isPremium ? `<span class="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-800">Premium</span>` : ''}
                      </span>
                      ${isLocked ? `<span class="text-amber-600">🔒</span>` : ''}
                    </button>
                  `;
                }).join('')}
              </div>
            </div>
          </div>
          ${userOrgId ? `
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1" for="board-visibility-input">
              Visibility
            </label>
            <select id="board-visibility-input"
              class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500">
              <option value="private">Myself</option>
              <option value="org">My Organization</option>
            </select>
          </div>
          <div id="board-member-assign-wrap" class="hidden">
            <label class="block text-sm font-medium text-gray-700 mb-1">
              Assign Organization Members
            </label>
            <div class="max-h-28 overflow-y-auto rounded-lg border border-gray-200 p-2 space-y-1">
              ${orgMembers.map((m) => `
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" class="board-member-check rounded border-gray-300 text-brand-500 focus:ring-brand-400"
                    value="${m.uid}" />
                  <span class="text-xs text-gray-700">${m.displayName ? `${m.displayName} (@${m.username || ''})` : `@${m.username || m.uid}`}</span>
                </label>
              `).join('')}
            </div>
          </div>
          ` : ''}
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">
              Project Due Date <span class="text-gray-400 font-normal">(optional)</span>
            </label>
            <input id="board-due-date-input" type="date"
              class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">
              Deck Color <span class="text-gray-400 font-normal">(optional)</span>
            </label>
            <div class="flex gap-2 flex-wrap" id="deck-color-swatches">
              ${swatchesHtml}
            </div>
            <input type="hidden" id="board-color-value" value="${defaultColorVal}" />
          </div>
          <div class="flex justify-end gap-2">
            <button type="button" id="create-board-cancel"
              class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">
              Cancel
            </button>
            <button type="submit"
              class="gold-btn px-4 py-2 text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg transition-colors">
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

  // Project type dropdown handler
  const projectTypeBtn = document.getElementById('board-project-type-btn');
  const projectTypeOptions = document.getElementById('project-type-options');
  const projectTypeDisplay = document.getElementById('project-type-display');
  const projectTypeInput = document.getElementById('board-project-type-input');
  const projectTypeSelect = document.getElementById('board-project-type-input');

  projectTypeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    projectTypeOptions.classList.toggle('hidden');
  });

  projectTypeOptions.querySelectorAll('.project-type-option').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const value = btn.dataset.value;
      const isLocked = btn.dataset.isLocked === 'true';
      
      // If locked (premium on free tier), show upgrade prompt instead of selecting
      if (isLocked) {
        projectTypeOptions.classList.add('hidden');
        _showUpgradePromptForPremiumType(PROJECT_TYPES.find((p) => p.value === value)?.label || value);
        return;
      }
      
      // Update selection
      projectTypeSelect.value = value;
      const label = PROJECT_TYPES.find((p) => p.value === value)?.label || value;
      projectTypeDisplay.textContent = label;
      
      // Update button styling
      document.querySelectorAll('.project-type-option').forEach((b) => {
        b.classList.remove('bg-brand-50', 'text-brand-700');
      });
      btn.classList.add('bg-brand-50', 'text-brand-700');
      
      projectTypeOptions.classList.add('hidden');
    });
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#project-type-dropdown-wrapper')) {
      projectTypeOptions.classList.add('hidden');
    }
  });

  // Color swatch selection
  document.getElementById('deck-color-swatches').querySelectorAll('.deck-color-swatch').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.deck-color-swatch').forEach((b) => {
        b.style.outline = 'none';
        b.style.borderColor = 'transparent';
      });
      btn.style.borderColor = btn.dataset.color;
      btn.style.outline = `2px solid ${btn.dataset.color}60`;
      btn.style.outlineOffset = '2px';
      document.getElementById('board-color-value').value = btn.dataset.color;
    });
  });

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('create-board-cancel').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  const visibilitySelect = document.getElementById('board-visibility-input');
  const memberWrap = document.getElementById('board-member-assign-wrap');
  if (visibilitySelect && memberWrap) {
    const syncMemberVisibility = () => {
      memberWrap.classList.toggle('hidden', visibilitySelect.value !== 'org');
    };
    visibilitySelect.addEventListener('change', syncMemberVisibility);
    syncMemberVisibility();
  }

  _bindModalSubmitKeys(form);

  let _submitting = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (_submitting) return;
    
    const selectedType = document.getElementById('board-project-type-input')?.value || 'standard';
    const isPremium = isPremiumType(selectedType);
    const isLocked = isPremium && !canUseAnyType;
    
    // Check if trying to use a locked premium type
    if (isLocked) {
      _showUpgradePromptForPremiumType(PROJECT_TYPES.find((p) => p.value === selectedType)?.label || selectedType);
      return;
    }
    
    _submitting = true;
    const submitBtn = form.querySelector('[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    const title   = input.value.trim() || 'My Deck';
    const projectType = document.getElementById('board-project-type-input')?.value || 'standard';
    const defaultCols = getDefaultColumnsForProjectType(projectType);
    const dueDate = document.getElementById('board-due-date-input')?.value || null;
    const color   = document.getElementById('board-color-value')?.value || null;
    const visibility = document.getElementById('board-visibility-input')?.value || 'private';
    const assignedMembers = visibility === 'org'
      ? [...document.querySelectorAll('.board-member-check:checked')].map((el) => el.value)
      : [];
    try {
      const boardId = await _withTimeout(
        createBoard(user, title, defaultCols, dueDate || null, color || null, projectType, {
          visibility,
          orgId: visibility === 'org' ? (userOrgId || null) : null,
          assignedMembers,
        }),
        BOARD_WRITE_TIMEOUT_MS,
        'Creating the board took too long.',
      );
      const board = {
        id: boardId,
        title,
        columns: defaultCols.map((col) => ({ ...col })),
        projectType,
        dueDate: dueDate || null,
        color:   color || null,
        visibility,
        orgId: visibility === 'org' ? (userOrgId || null) : null,
        assignedMembers,
      };
      _upsertCachedBoard(board);
      _persistCurrentBoards();
      if (projectType === 'weekly') {
        try { await _seedWeeklyBoard(boardId, user); } catch (err) { console.warn('Weekly board seeding failed:', err); }
      }
      close();
      onCreated(boardId, board);
    } catch (err) {
      console.error('Create deck failed:', err);
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
        <p class="text-sm text-gray-500 mb-4">Describe your project and AI will create a PM Deck with columns and tasks.</p>
        <form id="ai-board-form" class="flex flex-col gap-4">
          <textarea
            id="ai-board-prompt"
            rows="3"
            placeholder="e.g. Create me a PM Deck for a calculator app project"
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
              class="gold-btn flex items-center gap-2 px-4 py-2 text-sm font-medium text-white
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
  _bindModalSubmitKeys(form);

  let _submitting = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (_submitting) return;
    _submitting = true;

    submitBtn.disabled = true;
    statusEl.classList.remove('hidden');

    const prompt = promptArea.value.trim();
    try {
      const { title, columns } = await generateBoardWithTasks(prompt);
      // Strip tasks from columns before saving the board structure
      const boardColumns = columns.map(({ tasks: _t, ...col }) => col);
      const boardObj = { title, columns: boardColumns };
      const boardId  = await _withTimeout(
        createBoard(user, title, boardColumns),
        BOARD_WRITE_TIMEOUT_MS,
        'Creating the AI board took too long.',
      );

      // Set boardId so createCard can resolve it
      setBoardId(boardId);

      // Create all tasks and subtasks
      statusEl.querySelector('span').textContent = 'Creating tasks…';
      for (const col of columns) {
        if (!Array.isArray(col.tasks)) continue;
        for (let i = 0; i < col.tasks.length; i++) {
          const t = col.tasks[i];
          if (!t.title) continue;
          await createCard(col.id, t.title, t.description || '', i, false, t.subtasks || []);
        }
      }

      _upsertCachedBoard({ id: boardId, ...boardObj });
      _persistCurrentBoards();
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

// ─── Weekly board seeding ─────────────────────────────────────────────────────

/**
 * Seeds a newly-created Weekly board with 5 Day cards in the "Current Week"
 * column. Each card gets 3 starter subtasks (Task 1 / 2 / 3).
 */
async function _seedWeeklyBoard(boardId, user) {
  setBoardId(boardId);
  setCurrentUser(user);
  for (let day = 1; day <= 5; day++) {
    const subtasks = [1, 2, 3].map((n) => ({
      id: `sub-${Date.now()}-d${day}-t${n}-${Math.random().toString(36).slice(2, 6)}`,
      title: `Task ${n}`,
      completed: false,
    }));
    // eslint-disable-next-line no-await-in-loop
    await createCard('current-week', `Day ${day}`, '', day - 1, true, subtasks);
  }
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function _initTabs() {
  if (_tabsInited) return;
  _tabsInited = true;

  document.getElementById('tab-current-btn')?.addEventListener('click', () => {
    _activeTab = 'current';
    _updateTabUI();
    const root = document.getElementById('boards-root');
    if (root) _renderTiles(root, _lastBoards);
  });

  document.getElementById('tab-archived-btn')?.addEventListener('click', () => {
    _activeTab = 'archived';
    _updateTabUI();
    const root = document.getElementById('boards-root');
    if (root) _renderTiles(root, _lastBoards);
  });
}

function _updateTabUI() {
  const currentBtn  = document.getElementById('tab-current-btn');
  const archivedBtn = document.getElementById('tab-archived-btn');
  const actionBtns  = document.getElementById('boards-action-btns');

  const activeClass   = ['border-brand-500', 'text-brand-600'];
  const inactiveClass = ['border-transparent', 'text-gray-500', 'hover:text-gray-700'];

  if (_activeTab === 'current') {
    currentBtn?.classList.add(...activeClass);
    currentBtn?.classList.remove(...inactiveClass);
    archivedBtn?.classList.remove(...activeClass);
    archivedBtn?.classList.add(...inactiveClass);
    if (actionBtns) actionBtns.style.visibility = '';
  } else {
    archivedBtn?.classList.add(...activeClass);
    archivedBtn?.classList.remove(...inactiveClass);
    currentBtn?.classList.remove(...activeClass);
    currentBtn?.classList.add(...inactiveClass);
    if (actionBtns) actionBtns.style.visibility = 'hidden';
  }
}

// ─── Private rendering ────────────────────────────────────────────────────────

function _initColorFilter() {
  if (_colorFilterInited) return;
  _colorFilterInited = true;

  const container = document.getElementById('deck-color-filter');
  if (!container) return;

  const swatchesHtml = DECK_COLORS.map((c) => `
    <button type="button" data-color-filter="${c.value}"
      class="deck-filter-swatch w-5 h-5 rounded-full border-2 border-transparent hover:scale-110 transition-transform flex-shrink-0"
      style="background:${c.value}" title="${c.label}"></button>
  `).join('');

  container.innerHTML = `
    <div class="relative" id="deck-color-filter-wrap">
      <button id="deck-color-filter-btn" type="button"
        class="w-6 h-6 rounded-full border-2 border-gray-300 hover:border-gray-400 transition-all flex items-center justify-center flex-shrink-0"
        title="Filter by deck color" style="">
        <svg class="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <circle cx="6"  cy="12" r="2.5" fill="currentColor" stroke="none"/>
          <circle cx="12" cy="7"  r="2.5" fill="currentColor" stroke="none"/>
          <circle cx="18" cy="12" r="2.5" fill="currentColor" stroke="none"/>
          <circle cx="12" cy="17" r="2.5" fill="currentColor" stroke="none"/>
        </svg>
      </button>
      <div id="deck-color-filter-popup"
        class="hidden absolute left-0 top-8 z-30 bg-white border border-gray-200 rounded-xl shadow-xl p-3 min-w-max">
        <p class="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Filter by color</p>
        <div class="flex flex-wrap gap-2 mb-2">${swatchesHtml}</div>
        <button type="button" id="deck-color-filter-clear"
          class="w-full text-xs text-gray-400 hover:text-gray-700 mt-1 transition-colors">
          Show all
        </button>
      </div>
    </div>`;

  const btn   = container.querySelector('#deck-color-filter-btn');
  const popup = container.querySelector('#deck-color-filter-popup');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    popup.classList.toggle('hidden');
  });

  popup.addEventListener('click', (e) => {
    const swatch = e.target.closest('.deck-filter-swatch');
    if (swatch) {
      const val = swatch.dataset.colorFilter;
      _activeColorFilter = (_activeColorFilter === val) ? null : val;
      _updateColorFilterUI(container, btn, popup);
      const root = document.getElementById('boards-root');
      if (root) _renderTiles(root, _lastBoards);
      popup.classList.add('hidden');
      return;
    }
    if (e.target.closest('#deck-color-filter-clear')) {
      _activeColorFilter = null;
      _updateColorFilterUI(container, btn, popup);
      const root = document.getElementById('boards-root');
      if (root) _renderTiles(root, _lastBoards);
      popup.classList.add('hidden');
    }
  });

  // Close popup on outside click
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) popup.classList.add('hidden');
  });

  _updateColorFilterUI(container, btn, popup);
}

function _updateColorFilterUI(container, btn, popup) {
  // If called without btn/popup refs (e.g. from outside), look them up
  const b = btn ?? container?.querySelector('#deck-color-filter-btn');
  if (!b) return;

  if (_activeColorFilter) {
    b.style.background = _activeColorFilter;
    b.style.borderColor = _activeColorFilter;
    b.innerHTML = '';
  } else {
    b.style.background = '';
    b.style.borderColor = '';
    b.innerHTML = `<svg class="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <circle cx="6"  cy="12" r="2.5" fill="currentColor" stroke="none"/>
      <circle cx="12" cy="7"  r="2.5" fill="currentColor" stroke="none"/>
      <circle cx="18" cy="12" r="2.5" fill="currentColor" stroke="none"/>
      <circle cx="12" cy="17" r="2.5" fill="currentColor" stroke="none"/>
    </svg>`;
  }
}

function _renderTiles(root, boards, { instant = false } = {}) {
  root.innerHTML = '';

  const filtered = boards.filter((b) =>
    (_activeTab === 'archived' ? b.archived === true : !b.archived)
  );

  if (filtered.length === 0) {
    root.innerHTML = _activeTab === 'archived'
      ? `<div class="flex flex-col items-center justify-center py-20 text-center">
          <div class="text-5xl mb-4">🗄️</div>
          <p class="text-gray-500 text-sm">No archived decks.</p>
        </div>`
      : `<div class="flex flex-col items-center justify-center py-20 text-center">
          <div class="text-5xl mb-4">📋</div>
          <p class="text-gray-500 text-sm">No boards yet.</p>
          <p class="text-gray-400 text-sm">Click <strong>Create Deck</strong> to get started.</p>
        </div>`;
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'boards-grid flex flex-wrap gap-12 justify-center';

  filtered.forEach((board, index) => {
    grid.appendChild(_buildCard(board, index, instant, _lastStats.get(board.id)));
  });

  root.appendChild(grid);
}

function _renderLoadingTiles(root) {
  const grid = document.createElement('div');
  grid.className = 'boards-grid flex flex-wrap gap-12 justify-center';

  for (let i = 0; i < 4; i += 1) {
    const shell = document.createElement('div');
    shell.className = 'board-tile-shell board-tile-shell-ready relative w-40 h-56 flex-shrink-0';
    shell.style.setProperty('--tile-index', String(i));
    shell.innerHTML = `
      <div class="board-tile board-tile-loading w-full h-full rounded-[1.5rem] overflow-hidden">
        <div class="board-tile-band h-16 w-full relative overflow-hidden">
          <div class="board-tile-loading-shimmer"></div>
        </div>
        <div class="board-tile-body flex-1 p-3 pb-4 flex flex-col justify-end gap-2">
          <div class="board-tile-loading-line w-12"></div>
          <div class="board-tile-loading-line w-24"></div>
          <div class="board-tile-loading-line w-20 opacity-70"></div>
        </div>
      </div>
    `;
    grid.appendChild(shell);
  }

  root.innerHTML = '';
  root.appendChild(grid);
}

function _renderBoardsError(root) {
  root.innerHTML = `
    <div class="rounded-2xl border border-amber-200 bg-amber-50/80 px-5 py-4 text-sm text-amber-900">
      <p class="font-medium">Boards failed to load.</p>
      <p class="mt-1 text-amber-800">Check your Firebase connection, Auth session, or Firestore permissions and try again.</p>
    </div>
  `;
}

function _renderBoardsNotice(root, message) {
  const existing = root.querySelector('.boards-root-notice');
  if (existing) existing.remove();

  const notice = document.createElement('div');
  notice.className = 'boards-root-notice mb-4 rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-900';
  notice.textContent = message;
  root.prepend(notice);
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
function _buildCard(board, index = 0, instant = false, stats = null) {
  const wrapper = document.createElement('div');
  // Fixed playing-card proportions: 160px wide × 224px tall
  wrapper.className = 'board-tile-shell relative group w-40 h-56 flex-shrink-0';
  wrapper.style.setProperty('--tile-index', String(index));
  if (instant) wrapper.classList.add('board-tile-shell-ready');

  const backLayer1 = document.createElement('div');
  backLayer1.className = 'board-tile-back board-tile-back-1';
  backLayer1.setAttribute('aria-hidden', 'true');

  const backLayer2 = document.createElement('div');
  backLayer2.className = 'board-tile-back board-tile-back-2';
  backLayer2.setAttribute('aria-hidden', 'true');

  // Clickable card body (opens board)
  const card = document.createElement('button');
  card.className = [
    'board-tile relative w-full h-full flex flex-col rounded-[1.5rem] overflow-hidden',
    'hover:-translate-y-1',
    'transition-all duration-150 text-left',
  ].join(' ');
  card.dataset.boardId = board.id;
  card.setAttribute('aria-label', `Open board: ${board.title}`);
  const projectTypeLabel = _getProjectTypeLabel(board.projectType);

  card.innerHTML = `
    <!-- PM corner mark — top-left (playing card style) -->
    <div class="board-tile-corner-top z-10 flex flex-col items-center gap-px" aria-hidden="true">
      <span class="board-tile-mark" style="color:rgba(255,255,255,0.85)">PM</span><span style="font-size:0.6rem;color:rgba(255,255,255,0.7);line-height:1;margin-left:2px">&#9824;</span>
    </div>
    <!-- DEK corner mark — bottom-right, rotated 180° like a playing card -->
    <div class="board-tile-corner-bottom z-10 flex flex-col items-center gap-px" aria-hidden="true">
      <span class="board-tile-mark" style="color:rgba(255,255,255,0.85)">DEK</span><span style="font-size:0.6rem;color:rgba(255,255,255,0.7);line-height:1;margin-left:2px">&#9824;</span>
    </div>
    <!-- Top suit band -->
    <div class="board-tile-band h-[4.5rem] w-full flex-shrink-0 relative overflow-hidden flex flex-col"
         ${board.color ? `style="background: linear-gradient(135deg, ${board.color}ee 0%, ${board.color} 60%, ${board.color}99 100%) !important; border-bottom: 1px solid rgba(255,255,255,0.15);"` : ''}>
      <div class="board-tile-sheen"></div>
      <div class="flex-1"></div>
      <div class="relative z-10 px-2.5 pb-1.5 w-full text-center">
        <span class="inline-block max-w-full truncate rounded-full border border-white/20 bg-black/30 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-white/90 backdrop-blur-sm" title="${escapeHtml(projectTypeLabel)}">
          ${escapeHtml(projectTypeLabel)}
        </span>
      </div>
    </div>
    <div class="board-tile-body flex-1 flex flex-col justify-between p-3 pb-4">
      <div>
        <p class="board-tile-kicker">Project Deck</p>
        <h2 class="board-tile-title text-sm font-semibold leading-snug">
        ${escapeHtml(board.title || 'Untitled Deck')}
        </h2>
        <p class="mt-1 text-xs" style="color:rgba(255,255,255,0.72)">${stats?.taskCount ?? 0} Card${(stats?.taskCount ?? 0) !== 1 ? 's' : ''}</p>
        ${stats != null ? `<p class="mt-0.5 text-[10px]" style="color:rgba(255,255,255,0.6)">${stats.taskCount} Task${stats.taskCount !== 1 ? 's' : ''}${stats.subtaskCount > 0 ? ` &bull; ${stats.subtaskCount} Sub-Task${stats.subtaskCount !== 1 ? 's' : ''}` : ''}</p>` : ''}
        ${board.dueDate ? `<p class="mt-0.5 text-[10px]" style="color:rgba(255,255,255,0.5)">Due ${_formatDeckDate(board.dueDate)}</p>` : ''}
      </div>
    </div>
  `;

  card.addEventListener('click', () => {
    if (wrapper.dataset.opening === 'true') return;
    wrapper.dataset.opening = 'true';
    wrapper.classList.add('board-tile-shell-opening');
    setTimeout(() => _onBoardOpen(board.id, board), 180);
  });

  // Settings gear (top-right of card, absolutely positioned over the colour band)
  const gear = document.createElement('button');
  gear.className = [
    'absolute top-2 right-2 z-10',
    'w-6 h-6 flex items-center justify-center rounded-full',
    'bg-white/10 hover:bg-white/20 text-white transition-colors border border-white/10 backdrop-blur-sm',
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

  wrapper.appendChild(backLayer2);
  wrapper.appendChild(backLayer1);
  wrapper.appendChild(card);
  wrapper.appendChild(gear);

  if (!instant) {
    requestAnimationFrame(() => {
      wrapper.classList.add('board-tile-shell-ready');
    });
  }

  return wrapper;
}

// ─── Settings dropdown ───────────────────────────────────────────────────────

/**
 * Shows a tiny positioned dropdown below the gear button with Edit / Delete.
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

  menu.innerHTML = board.archived
    ? `
    <button data-action="restore"
      class="w-full text-left px-4 py-2 hover:bg-green-50 text-green-700 transition-colors flex items-center gap-2">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/>
      </svg>
      Restore
    </button>
    <div class="my-1 border-t border-gray-100"></div>
    <button data-action="delete"
      class="w-full text-left px-4 py-2 hover:bg-red-50 text-red-600 transition-colors flex items-center gap-2">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6
             m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
      </svg>
      Delete
    </button>`
    : `
    <button data-action="rename"
      class="w-full text-left px-4 py-2 hover:bg-gray-50 transition-colors flex items-center gap-2">
      <svg class="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5
             m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
      </svg>
      Edit
    </button>
    <button data-action="color"
      class="w-full text-left px-4 py-2 hover:bg-gray-50 transition-colors flex items-center gap-2">
      <span class="w-3.5 h-3.5 rounded-full border-2 flex-shrink-0"
        style="${board.color ? `background:${board.color};border-color:${board.color}` : 'border-color:#d1d5db;background:transparent'}"></span>
      Change Color
    </button>
    <button data-action="archive"
      class="w-full text-left px-4 py-2 hover:bg-amber-50 text-amber-700 transition-colors flex items-center gap-2">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8l1 12a2 2 0 002 2h8a2 2 0 002-2L19 8"/>
      </svg>
      Archive Deck
    </button>
    <div class="my-1 border-t border-gray-100"></div>
    <button data-action="delete"
      class="w-full text-left px-4 py-2 hover:bg-red-50 text-red-600 transition-colors flex items-center gap-2">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6
             m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
      </svg>
      Delete Deck
    </button>`;

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

  menu.querySelector('[data-action="rename"]')?.addEventListener('click', () => {
    menu.remove();
    document.removeEventListener('click', closeMenu, true);
    _openRenameBoardModal(board);
  });

  menu.querySelector('[data-action="color"]')?.addEventListener('click', () => {
    menu.remove();
    document.removeEventListener('click', closeMenu, true);
    _openChangeDeckColorModal(board);
  });

  menu.querySelector('[data-action="archive"]')?.addEventListener('click', () => {
    menu.remove();
    document.removeEventListener('click', closeMenu, true);
    _openArchiveBoardModal(board);
  });

  menu.querySelector('[data-action="restore"]')?.addEventListener('click', () => {
    menu.remove();
    document.removeEventListener('click', closeMenu, true);
    _doRestoreBoard(board);
  });

  menu.querySelector('[data-action="delete"]').addEventListener('click', () => {
    menu.remove();
    document.removeEventListener('click', closeMenu, true);
    _openDeleteBoardModal(board);
  });
}

// ─── Rename modal ─────────────────────────────────────────────────────────────

async function _openRenameBoardModal(board) {
  const modalRoot = document.getElementById('modal-root');

  // Load org context for visibility selector
  let orgMembers = [];
  let userOrgId  = null;
  try {
    const profile = await getUserProfile(_currentUser.uid);
    if (profile?.organizationId) {
      userOrgId  = profile.organizationId;
      orgMembers = await getOrgMembers(profile.organizationId);
    }
  } catch (_) { /* non-blocking */ }

  const currentVisibility = board.visibility || 'private';
  const currentAssigned = board.assignedMembers || [];

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <h3 class="text-lg font-semibold text-gray-800 mb-4">Edit Deck</h3>
        <form id="rename-board-form" class="flex flex-col gap-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1" for="rename-board-input">Deck Name</label>
          <input id="rename-board-input" type="text"
            value="${escapeHtml(board.title)}"
            required maxlength="100"
            class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500" />
          </div>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1" for="rename-board-due-date-input">
              Project Due Date <span class="text-gray-400 font-normal">(optional)</span>
            </label>
            <input id="rename-board-due-date-input" type="date"
              value="${board.dueDate || ''}"
              class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500" />
          </div>
          ${userOrgId ? `
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1" for="edit-board-visibility-input">
              Visibility
            </label>
            <select id="edit-board-visibility-input"
              class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500">
              <option value="private" ${currentVisibility === 'private' ? 'selected' : ''}>Myself</option>
              <option value="org" ${currentVisibility === 'org' ? 'selected' : ''}>My Organization</option>
            </select>
          </div>
          <div id="edit-board-member-assign-wrap" class="${currentVisibility === 'org' ? '' : 'hidden'}">
            <label class="block text-sm font-medium text-gray-700 mb-1">
              Assign Organization Members
            </label>
            <div class="max-h-28 overflow-y-auto rounded-lg border border-gray-200 p-2 space-y-1">
              ${orgMembers.map((m) => `
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" class="edit-board-member-check rounded border-gray-300 text-brand-500 focus:ring-brand-400"
                    value="${m.uid}" ${currentAssigned.includes(m.uid) ? 'checked' : ''} />
                  <span class="text-xs text-gray-700">${m.displayName ? `${m.displayName} (@${m.username || ''})` : `@${m.username || m.uid}`}</span>
                </label>
              `).join('')}
            </div>
          </div>
          ` : ''}
          <div class="flex justify-end gap-2">
            <button type="button" id="rename-board-cancel"
              class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">
              Cancel
            </button>
            <button type="submit"
              class="gold-btn px-4 py-2 text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg transition-colors">
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

  // Wire visibility toggle
  const editVisSelect = document.getElementById('edit-board-visibility-input');
  const editMemberWrap = document.getElementById('edit-board-member-assign-wrap');
  if (editVisSelect && editMemberWrap) {
    const syncVis = () => editMemberWrap.classList.toggle('hidden', editVisSelect.value !== 'org');
    editVisSelect.addEventListener('change', syncVis);
  }

  _bindModalSubmitKeys(form);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newTitle = input.value.trim();
    const newDueDate = document.getElementById('rename-board-due-date-input')?.value || null;
    if (!newTitle) return;

    const visibility = document.getElementById('edit-board-visibility-input')?.value || 'private';
    const assignedMembers = visibility === 'org'
      ? [...document.querySelectorAll('.edit-board-member-check:checked')].map((el) => el.value)
      : [];

    try {
      await renameBoard(board.id, newTitle, newDueDate, {
        visibility,
        orgId: visibility === 'org' ? (userOrgId || null) : null,
        assignedMembers,
      });
      _upsertCachedBoard({ ...board, title: newTitle, dueDate: newDueDate, visibility, orgId: visibility === 'org' ? (userOrgId || null) : null, assignedMembers });
      _persistCurrentBoards();
      close();
      await renderBoardsHome(_currentUser, _onBoardOpen);
    } catch (err) {
      console.error('Rename board failed:', err);
    }
  });
}

function _openChangeDeckColorModal(board) {
  const modalRoot = document.getElementById('modal-root');

  const swatchesHtml = [
    { value: null, label: 'None' },
    ...DECK_COLORS,
  ].map((c) => {
    const active = board.color === c.value;
    const style = c.value
      ? `background:${c.value}`
      : 'background:transparent;border:2px dashed #9ca3af';
    return `<button type="button" data-color="${c.value ?? ''}"
      class="deck-color-edit-swatch w-7 h-7 rounded-full hover:scale-110 transition-transform"
      style="${style}${active ? ';outline:2px solid #374151;outline-offset:2px' : ''}" title="${c.label}"></button>`;
  }).join('');

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-xs p-6">
        <h3 class="text-base font-semibold text-gray-800 mb-4">Deck Color</h3>
        <div class="flex flex-wrap gap-2 mb-6">${swatchesHtml}</div>
        <div class="flex justify-end">
          <button id="deck-color-cancel"
            class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  `;

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('deck-color-cancel').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  modalRoot.querySelectorAll('.deck-color-edit-swatch').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const newColor = btn.dataset.color || null;
      close();
      try {
        await Promise.all([
          updateBoardColor(board.id, newColor),
          updateAllCardsBackground(board.id, newColor),
        ]);
        _upsertCachedBoard({ ...board, color: newColor });
        _persistCurrentBoards();
        await renderBoardsHome(_currentUser, _onBoardOpen);
      } catch (err) {
        console.error('Change deck color failed:', err);
      }
    });
  });
}

// ─── Premium type upgrade prompt ──────────────────────────────────────────────

function _showUpgradePromptForPremiumType(typeName) {
  const modalRoot = document.getElementById('modal-root');
  
  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <div class="flex items-start gap-3 mb-4">
          <div class="flex-shrink-0 w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center">
            <span class="text-lg">🔒</span>
          </div>
          <div>
            <h3 class="text-lg font-semibold text-gray-800">Upgrade to use ${typeName}</h3>
            <p class="mt-1 text-sm text-gray-600">
              The <strong>${typeName}</strong> project type is available on premium plans.
            </p>
          </div>
        </div>
        <div class="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <p class="text-sm text-amber-900"><strong>Premium Features:</strong></p>
          <ul class="mt-2 space-y-1 text-xs text-amber-800">
            <li>✓ All advanced project types (Scrum, Waterfall, Agile, SDLC, etc.)</li>
            <li>✓ Up to 75 decks (vs 10 on free)</li>
            <li>✓ 40 AI requests/day (vs 2 on free)</li>
            <li>✓ Team collaboration with organizations</li>
          </ul>
        </div>
        <div class="flex justify-between gap-2">
          <button id="upgrade-modal-cancel"
            class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">
            Cancel
          </button>
          <button id="upgrade-modal-upgrade"
            class="gold-btn px-4 py-2 text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg transition-colors">
            View Plans
          </button>
        </div>
      </div>
    </div>
  `;

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('upgrade-modal-cancel').addEventListener('click', close);
  document.getElementById('upgrade-modal-upgrade').addEventListener('click', async () => {
    close();
    // Dynamically import main.js to access the billing modal
    const mainModule = await import('./main.js');
    if (mainModule._openBillingModal) {
      mainModule._openBillingModal();
    }
  });
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
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
      _removeCachedBoard(board.id);
      _persistCurrentBoards();
      close();
      await renderBoardsHome(_currentUser, _onBoardOpen);
    } catch (err) {
      console.error('Delete board failed:', err);
    }
  });
}

// ─── Archive / Restore ────────────────────────────────────────────────────────

function _openArchiveBoardModal(board) {
  const modalRoot = document.getElementById('modal-root');

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <h3 class="text-base font-semibold text-gray-900 mb-2">Archive "${escapeHtml(board.title)}"?</h3>
        <p class="text-sm text-gray-500 mb-6">This deck will be moved to Archived Decks. You can restore it any time.</p>
        <div class="flex justify-end gap-2">
          <button id="archive-board-cancel"
            class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">
            Cancel
          </button>
          <button id="archive-board-confirm"
            class="px-4 py-2 text-sm font-medium text-amber-900 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded-lg transition-colors">
            Archive Deck
          </button>
        </div>
      </div>
    </div>
  `;

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('archive-board-cancel').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  document.getElementById('archive-board-confirm').addEventListener('click', async () => {
    try {
      await archiveBoard(board.id);
      _upsertCachedBoard({ ...board, archived: true });
      _persistCurrentBoards();
      close();
      await renderBoardsHome(_currentUser, _onBoardOpen);
    } catch (err) {
      console.error('Archive board failed:', err);
    }
  });
}

async function _doRestoreBoard(board) {
  try {
    await unarchiveBoard(board.id);
    _upsertCachedBoard({ ...board, archived: false });
    _persistCurrentBoards();
    _activeTab = 'current';
    await renderBoardsHome(_currentUser, _onBoardOpen);
  } catch (err) {
    console.error('Restore board failed:', err);
  }
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

function _formatDeckDate(dateStr) {
  if (!dateStr) return '';
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return dateStr; }
}

function _getProjectTypeLabel(projectType) {
  return PROJECT_TYPES.find((type) => type.value === projectType)?.label || 'Standard';
}

function _upsertCachedBoard(board) {
  const index = _lastBoards.findIndex((item) => item.id === board.id);
  if (index === -1) {
    _lastBoards = [..._lastBoards, board];
    return;
  }

  _lastBoards = _lastBoards.map((item) => (item.id === board.id ? board : item));
}

function _removeCachedBoard(boardId) {
  _lastBoards = _lastBoards.filter((board) => board.id !== boardId);
}

function _persistCurrentBoards() {
  if (!_currentUser) return;
  _persistBoards(_currentUser.uid, _lastBoards);
}

function _persistBoards(userId, boards) {
  try {
    const payload = boards.map((board) => ({
      id:       board.id,
      title:    board.title,
      columns:  Array.isArray(board.columns) ? board.columns : [],
      projectType: board.projectType || 'standard',
      archived: board.archived || false,
      dueDate:  board.dueDate || null,
      color:    board.color || null,
    }));
    window.localStorage.setItem(_getBoardsStorageKey(userId), JSON.stringify(payload));
  } catch {
    // Ignore storage failures and continue with in-memory data.
  }
}

function _loadPersistedBoards(userId) {
  try {
    const raw = window.localStorage.getItem(_getBoardsStorageKey(userId));
    if (!raw) return [];

    const boards = JSON.parse(raw);
    if (!Array.isArray(boards)) return [];

    return boards.filter((board) => board && typeof board.id === 'string');
  } catch {
    return [];
  }
}

function _getBoardsStorageKey(userId) {
  return `pmdek:boards:${userId}`;
}

function _persistStats(userId, stats) {
  try {
    const obj = {};
    stats.forEach((val, key) => { obj[key] = val; });
    window.localStorage.setItem(`pmdek:cardstats:${userId}`, JSON.stringify(obj));
  } catch { /* ignore */ }
}

function _loadPersistedStats(userId) {
  try {
    const raw = window.localStorage.getItem(`pmdek:cardstats:${userId}`);
    if (!raw) return new Map();
    const obj = JSON.parse(raw);
    return new Map(Object.entries(obj));
  } catch {
    return new Map();
  }
}

function _withTimeout(promise, timeoutMs, message) {
  let timerId;

  const timeoutPromise = new Promise((_, reject) => {
    timerId = window.setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    window.clearTimeout(timerId);
  });
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

