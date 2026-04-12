/**
 * @module main
 * @description
 * Application entry point. Orchestrates view transitions and module wiring.
 *
 * Three views:
 *  - landing    — unauthenticated sign-in page
 *  - boards     — authenticated home: grid of board tiles
 *  - board      — individual Kanban board
 *
 * Flow:
 *  Sign in → boards view
 *  Click tile / create board → board view
 *  Back button → boards view
 *  Sign out → landing view
 */

import {
  initAuth, signInWithGoogle, signInWithGitHub, signOutUser,
  signInWithEmail, registerWithEmail, resetPassword, deleteAccount,
} from './auth.js';
import { renderBoard, setBoardId, createColumnBlock, resetColumnWidths } from './board.js';
import { subscribeToCards, unsubscribeFromCards, initCardEvents, setBoardAssignedMembers, renderListView, renderCalendarView, getCardsSnapshot } from './cards.js';
import { renderBoardsHome, openCreateBoardModal }                 from './boards-home.js';
import { initAiChat, setAiChatMode, toggleAiChat, openAiChatWithPrompt, collapseAiChat } from './ai-chat.js';
import { doc, getDoc }                                             from 'firebase/firestore';
import { db }                                                      from './firebase.js';
import { ensureUserProfile, claimUsername, validateUsername, checkUsernameAvailable, updateUserDisplayName, getUserProfile, getAllUsers, setUserAdminStatus } from './users.js';
import { createOrg, getOrgById, getOrgMembers, addMemberByUsername, removeMember, setOrgMemberAdminStatus, getAllOrganizations } from './org.js';
import { BILLING_PLANS, getUserPlan, ensureBillingDefaults }      from './billing.js';
import { httpsCallable }                                           from 'firebase/functions';
import { functions }                                               from './firebase.js';

// ─── Module state ─────────────────────────────────────────────────────────────

/** Authenticated user, set on sign-in and cleared on sign-out. */
let _user = null;
let _userProfile = null;

// Tracks whether the email form is in sign-in or register mode.
let _emailMode = 'signin'; // 'signin' | 'register'

// Ordered list of boards for prev/next navigation.
let _boardsList = [];
let _currentBoardId = null;
let _boardViewMode = 'kanban';

// ─── Auth lifecycle ───────────────────────────────────────────────────────────

initAuth(
  async (user) => {
    _user = user;
    window.__PMDEK_UID = user.uid;
    _userProfile = await ensureUserProfile(user);
    await ensureBillingDefaults(user.uid);
    if (!_userProfile?.username) {
      await _openUsernamePickerModal();
      _userProfile = await getUserProfile(user.uid);
    }
    _updateUserUI(user);
    initAiChat(user, {
      onBoardCreated: (boardId, board) => {
        _boardsList = _getLastBoards();
        _openBoard(boardId, board);
      },
    });
    await _showBoardsHome();
  },
  () => {
    _user = null;
    window.__PMDEK_UID = '';
    _userProfile = null;
    unsubscribeFromCards();
    _showView('landing');
  },
);

// ─── Boards home ──────────────────────────────────────────────────────────────

async function _showBoardsHome() {
  _showView('boards');
  setAiChatMode('boards');
  await renderBoardsHome(_user, (boardId, board) => {
    // Capture the boards list at the time of click for navigation
    _boardsList = _getLastBoards();
    _openBoard(boardId, board);
  });
  _boardsList = _getLastBoards();
}

function _getLastBoards() {
  // boards-home caches the list; grab it from the DOM tile order as fallback
  const tiles = [...document.querySelectorAll('[data-board-id]')];
  return tiles.map((t) => ({ id: t.dataset.boardId, title: t.querySelector('.board-tile-title')?.textContent?.trim() || '' }));
}

document.getElementById('create-board-btn')?.addEventListener('click', () => {
  openCreateBoardModal(_user, (boardId, title) => _openBoard(boardId, title));
});

document.getElementById('ai-board-btn')?.addEventListener('click', () => {
  toggleAiChat();
});

// ─── Board (Kanban) view ──────────────────────────────────────────────────────

async function _openBoard(boardId, board) {
  // board may be a plain {id, title, columns} object from the tile click,
  // or just a title string from the create-board flow — normalise both.
  let boardObj = (typeof board === 'object' && board !== null)
    ? board
    : { id: boardId, title: board, columns: [] };

  // Always prefer live board data so deck navigation paths (prev/next/dropdown)
  // render the real saved column template instead of DEFAULT_COLUMNS.
  try {
    const liveBoardSnap = await getDoc(doc(db, 'boards', boardId));
    if (liveBoardSnap.exists()) {
      boardObj = { id: liveBoardSnap.id, ...liveBoardSnap.data() };
    }
  } catch (err) {
    console.warn('Could not load live board doc, using provided board object:', err);
  }

  _currentBoardId = boardId;
  // Refresh nav arrows
  _updateDeckNavArrows();

  // Update the topbar board title
  const titleEl = document.getElementById('board-title-display');
  if (titleEl) titleEl.textContent = boardObj.title;

  // Update due date display
  const dueDateEl = document.getElementById('board-due-date-display');
  if (dueDateEl) {
    if (boardObj.dueDate) {
      const d = new Date(boardObj.dueDate + 'T00:00:00');
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const isOverdue = d < today;
      const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      dueDateEl.textContent = `Due ${label}`;
      dueDateEl.className = isOverdue
        ? 'text-xs mt-0.5 text-red-500 font-medium'
        : 'text-xs mt-0.5 text-gray-400';
      dueDateEl.classList.remove('hidden');
    } else {
      dueDateEl.classList.add('hidden');
    }
  }

  setBoardId(boardId);
  renderBoard(boardObj);

  // Load assignee profiles for this board so card tiles/modals can resolve names.
  try {
    const memberIds = Array.isArray(boardObj?.assignedMembers) ? boardObj.assignedMembers : [];
    const memberProfiles = await Promise.all(memberIds.map((uid) => getUserProfile(uid)));
    setBoardAssignedMembers(memberProfiles.filter(Boolean));
  } catch (err) {
    console.warn('Could not load board assignees:', err);
    setBoardAssignedMembers([]);
  }

  subscribeToCards();
  initCardEvents(_user);
  _applyBoardView(_boardViewMode);
  setAiChatMode('board');
  _showView('board');
}

function _applyBoardView(mode = 'kanban') {
  _boardViewMode = mode;
  const boardRoot = document.getElementById('board-root');
  const listRoot = document.getElementById('board-list-view');
  const calRoot = document.getElementById('board-calendar-view');
  const timelineRoot = document.getElementById('board-timeline-view');
  if (!boardRoot || !listRoot || !calRoot || !timelineRoot) return;

  boardRoot.classList.toggle('hidden', mode !== 'kanban');
  listRoot.classList.toggle('hidden', mode !== 'list');
  calRoot.classList.toggle('hidden', mode !== 'calendar');
  timelineRoot.classList.toggle('hidden', mode !== 'timeline');

  document.getElementById('board-kanban-view-btn')?.classList.toggle('bg-gray-900', mode === 'kanban');
  document.getElementById('board-kanban-view-btn')?.classList.toggle('text-white', mode === 'kanban');
  document.getElementById('board-list-view-btn')?.classList.toggle('bg-gray-900', mode === 'list');
  document.getElementById('board-list-view-btn')?.classList.toggle('text-white', mode === 'list');
  document.getElementById('board-calendar-view-btn')?.classList.toggle('bg-gray-900', mode === 'calendar');
  document.getElementById('board-calendar-view-btn')?.classList.toggle('text-white', mode === 'calendar');
  document.getElementById('project-timeline-btn')?.classList.toggle('bg-gray-900', mode === 'timeline');
  document.getElementById('project-timeline-btn')?.classList.toggle('text-white', mode === 'timeline');

  if (mode === 'list') renderListView();
  if (mode === 'calendar') renderCalendarView();
  if (mode === 'timeline') _renderTimelineInPage();
}

function _openAiDashboardPage() {
  _renderAiDashboardPage();
  _showView('ai-dashboard');
  setAiChatMode('dashboard');
  collapseAiChat();
  const dashTitle = document.getElementById('ai-dashboard-title-display');
  const current = _boardsList.find((b) => b.id === _currentBoardId);
  if (dashTitle) dashTitle.textContent = current?.title || document.getElementById('board-title-display')?.textContent || 'Current Deck';
  _updateDeckNavArrows();
}

function _renderAiDashboardPage() {
  const cards = getCardsSnapshot();
  const root = document.getElementById('ai-dashboard-root');
  if (!root) return;
  const isEffectivelyCompleted = (c) => Boolean(c?.completed) || /\bdone\b|\bfinish(?:ed)?\b|\bcomplete(?:d)?\b|\bdeployment\b|\bresolved\b/i.test(String(c?.columnId || ''));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const in7 = new Date(today); in7.setDate(in7.getDate() + 7);
  const in14 = new Date(today); in14.setDate(in14.getDate() + 14);

  const total = cards.length;
  const doneCards = cards.filter((c) => isEffectivelyCompleted(c));
  const openCards = cards.filter((c) => !isEffectivelyCompleted(c));
  const done = doneCards.length;
  const overdue = openCards.filter((c) => c.dueDate && new Date(c.dueDate + 'T00:00:00') < today);
  const dueSoon = openCards.filter((c) => c.dueDate && new Date(c.dueDate + 'T00:00:00') >= today && new Date(c.dueDate + 'T00:00:00') <= in7);
  const recurring = openCards.filter((c) => Boolean(c.recurring));
  const noDueDate = openCards.filter((c) => !c.dueDate);
  const blocked = openCards.filter((c) => /blocked|risk|hold|waiting/i.test(String(c.columnId || '')));

  const completionRate = total > 0 ? Math.round((done / total) * 100) : 0;
  const overdueRate = openCards.length > 0 ? Math.round((overdue.length / openCards.length) * 100) : 0;
  const noDueRate = openCards.length > 0 ? Math.round((noDueDate.length / openCards.length) * 100) : 0;
  const blockedRate = openCards.length > 0 ? Math.round((blocked.length / openCards.length) * 100) : 0;
  const healthScore = Math.max(0, Math.min(100,
    Math.round(55 + (completionRate * 0.45) - (overdueRate * 0.45) - (noDueRate * 0.25) - (blockedRate * 0.2))
  ));

  const allSubtasks = cards.flatMap((c) => Array.isArray(c.subtasks) ? c.subtasks : []);
  const openSubtasks = allSubtasks.filter((s) => !s.completed);

  const workloadMap = new Map();
  cards.forEach((c) => {
    const assignees = Array.isArray(c.assignees) && c.assignees.length ? c.assignees : ['Unassigned'];
    assignees.forEach((uid) => {
      const key = uid || 'Unassigned';
      const prev = workloadMap.get(key) || { tasks: 0, overdue: 0, dueSoon: 0 };
      prev.tasks += isEffectivelyCompleted(c) ? 0 : 1;
      if (!isEffectivelyCompleted(c) && c.dueDate) {
        const due = new Date(c.dueDate + 'T00:00:00');
        if (due < today) prev.overdue += 1;
        if (due >= today && due <= in7) prev.dueSoon += 1;
      }
      workloadMap.set(key, prev);
    });
  });
  openSubtasks.forEach((s) => {
    const key = s.assignee || 'Unassigned';
    const prev = workloadMap.get(key) || { tasks: 0, overdue: 0, dueSoon: 0 };
    prev.tasks += 0.25;
    workloadMap.set(key, prev);
  });

  const topWorkload = [...workloadMap.entries()]
    .map(([owner, stats]) => ({ owner, ...stats }))
    .sort((a, b) => b.tasks - a.tasks)
    .slice(0, 8);

  const upcomingMilestones = openCards
    .filter((c) => c.dueDate)
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
    .slice(0, 10);

  const forecastBuckets = [];
  for (let i = 0; i < 14; i += 1) {
    const day = new Date(today);
    day.setDate(today.getDate() + i);
    const key = day.toISOString().slice(0, 10);
    const count = openCards.filter((c) => c.dueDate === key).length;
    forecastBuckets.push({ key, count });
  }
  const peakLoad = Math.max(1, ...forecastBuckets.map((b) => b.count));

  const recs = [];
  if (overdue.length > 0) recs.push(`Clear ${overdue.length} overdue task${overdue.length === 1 ? '' : 's'} immediately.`);
  if (dueSoon.length > 0) recs.push(`Prioritize ${dueSoon.length} task${dueSoon.length === 1 ? '' : 's'} due in the next 7 days.`);
  if (noDueDate.length > 0) recs.push(`Assign due dates to ${noDueDate.length} open task${noDueDate.length === 1 ? '' : 's'} to improve forecasting.`);
  if (blocked.length > 0) recs.push(`Unblock ${blocked.length} task${blocked.length === 1 ? '' : 's'} currently marked blocked/risk/hold.`);
  if (recurring.length > 0) recs.push(`Batch-plan ${recurring.length} recurring task${recurring.length === 1 ? '' : 's'} for this week.`);
  if (topWorkload[0] && topWorkload[0].tasks >= 5) recs.push(`Redistribute workload from ${_escHtml(topWorkload[0].owner)} to avoid bottlenecks.`);

  const overdueNames = overdue.slice(0, 4).map((c) => c.title || 'Untitled').join(', ');
  const dueSoonNames = dueSoon.slice(0, 5).map((c) => `${c.title || 'Untitled'} (${c.dueDate || 'no date'})`).join(', ');
  const blockedNames = blocked.slice(0, 4).map((c) => c.title || 'Untitled').join(', ');
  const sprintNames = openCards
    .filter((c) => c.dueDate && new Date(c.dueDate + 'T00:00:00') <= in14)
    .slice(0, 6)
    .map((c) => `${c.title || 'Untitled'} (${c.dueDate || 'no date'})`)
    .join(', ');

  const quickPrompts = [
    overdue.length
      ? `Build a 3-day recovery plan for these overdue tasks: ${overdueNames}.`
      : 'No tasks are overdue. What should I improve next for schedule risk?',
    dueSoon.length
      ? `Rank these due-soon tasks by risk and urgency, and explain why: ${dueSoonNames}.`
      : 'No tasks are due in the next 7 days. What should I pull forward?',
    blocked.length
      ? `Give mitigation steps for these blocked tasks: ${blockedNames}.`
      : 'No blocked tasks found. What are likely hidden blockers to check?',
    sprintNames
      ? `Create a 14-day execution plan for: ${sprintNames}.`
      : 'Create a 14-day sprint plan for the highest-value open tasks in this deck.',
  ];

  const healthTone = healthScore >= 80 ? 'text-emerald-600' : healthScore >= 60 ? 'text-amber-600' : 'text-rose-600';

  root.innerHTML = `
    <div class="w-full rounded-2xl overflow-hidden border border-gray-200 bg-white text-gray-800 shadow-sm">
      <div class="p-5 border-b border-gray-100 bg-gradient-to-r from-amber-50 via-white to-sky-50">
        <div class="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p class="text-xs uppercase tracking-wide text-amber-700/80">AI Program Intelligence</p>
            <h3 class="text-xl font-semibold text-gray-800">Project Health Command Center</h3>
            <p class="mt-1 text-xs text-gray-500">Dashboard AI is in answer-only mode. Ask for analysis, prioritization, and recommendations. It will not create tasks here.</p>
          </div>
          <div class="text-right">
            <p class="text-xs text-gray-500">Health Score</p>
            <p class="text-3xl font-bold ${healthTone}">${healthScore}</p>
          </div>
        </div>
      </div>

      <div class="p-5 grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-3 border-b border-gray-100 bg-white">
        ${[
          ['Total', total],
          ['Open', openCards.length],
          ['Done', done],
          ['Overdue', overdue.length],
          ['Due 7d', dueSoon.length],
          ['Blocked', blocked.length],
          ['Recurring', recurring.length],
          ['Open Subtasks', openSubtasks.length],
        ].map(([k, v]) => `<div class="rounded-lg border border-gray-200 bg-gray-50/80 p-3"><p class="text-[11px] text-gray-500">${k}</p><p class="text-xl font-semibold text-gray-800">${v}</p></div>`).join('')}
      </div>

      <div class="p-5 grid grid-cols-1 xl:grid-cols-3 gap-4 border-b border-gray-100">
        <div class="xl:col-span-2 rounded-lg border border-gray-200 bg-gray-50/70 p-4">
          <div class="flex items-center justify-between mb-2">
            <p class="text-sm font-medium">Smart Recommendations</p>
            <span class="text-[11px] text-gray-500">Auto-generated</span>
          </div>
          <div class="space-y-2 max-h-56 overflow-y-auto pr-1">
            ${(recs.length ? recs : ['No major risks detected. Keep momentum and close open due-soon tasks.']).map((r, i) => `
              <div class="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2">
                <div class="flex items-start justify-between gap-3">
                  <p class="text-sm text-gray-700"><span class="text-amber-700 mr-1">${i + 1}.</span>${_escHtml(r)}</p>
                  <button class="ai-dash-ask-btn flex-shrink-0 px-2 py-1 text-[11px] font-medium text-amber-800 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded-md transition-colors" data-prompt="Explain this recommendation and give me exact next actions: ${_escHtml(r)}">
                    Ask AI
                  </button>
                </div>
              </div>`).join('')}
          </div>
        </div>

        <div class="rounded-lg border border-gray-200 bg-gray-50/70 p-4">
          <p class="text-sm font-medium mb-2">AI Quick Actions</p>
          <div class="space-y-2">
            ${quickPrompts.map((p, i) => `
              <button class="ai-dash-prompt-btn w-full text-left rounded-md border border-amber-300 bg-amber-50 hover:bg-amber-100 px-3 py-2 text-xs text-amber-900" data-prompt="${_escHtml(p)}">
                ${i + 1}. ${_escHtml(p)}
              </button>
            `).join('')}
          </div>
        </div>
      </div>

      <div class="p-5 grid grid-cols-1 xl:grid-cols-2 gap-4 border-b border-gray-100">
        <div class="rounded-lg border border-gray-200 bg-gray-50/70 p-4">
          <div class="flex items-center justify-between mb-2">
            <p class="text-sm font-medium">Assignee Workload Heat</p>
            <span class="text-[11px] text-gray-500">Tasks + weighted subtasks</span>
          </div>
          <div class="space-y-2 max-h-64 overflow-y-auto pr-1">
            ${(topWorkload.length ? topWorkload : [{ owner: 'Unassigned', tasks: 0, overdue: 0, dueSoon: 0 }]).map((w) => {
              const pct = Math.min(100, Math.round((w.tasks / Math.max(1, (topWorkload[0]?.tasks || 1))) * 100));
              return `
                <div class="rounded-md border border-gray-200 bg-white px-3 py-2">
                  <div class="flex items-center justify-between text-xs mb-1">
                    <span class="text-gray-700">${_escHtml(w.owner)}</span>
                    <span class="text-gray-500">${w.tasks.toFixed(2)} load • ${w.overdue} overdue • ${w.dueSoon} due soon</span>
                  </div>
                  <div class="h-2 rounded bg-gray-200 overflow-hidden">
                    <div class="h-full bg-gradient-to-r from-amber-400 to-brand-500" style="width:${pct}%"></div>
                  </div>
                </div>`;
            }).join('')}
          </div>
        </div>

        <div class="rounded-lg border border-gray-200 bg-gray-50/70 p-4">
          <div class="flex items-center justify-between mb-2">
            <p class="text-sm font-medium">14-Day Delivery Forecast</p>
            <span class="text-[11px] text-gray-500">Dated open tasks/day</span>
          </div>
          <div class="grid grid-cols-7 gap-1.5">
            ${forecastBuckets.map((b) => {
              const h = Math.max(8, Math.round((b.count / peakLoad) * 54));
              return `
                <div class="rounded border border-gray-200 bg-white p-1 text-center">
                  <p class="text-[9px] text-gray-500">${b.key.slice(5)}</p>
                  <div class="mt-1 mx-auto w-4 rounded bg-gray-200 flex items-end justify-center" style="height:58px;">
                    <div class="w-4 rounded bg-gradient-to-t from-brand-500 to-amber-300" style="height:${b.count > 0 ? h : 2}px"></div>
                  </div>
                  <p class="text-[10px] mt-1 text-gray-700">${b.count}</p>
                </div>`;
            }).join('')}
          </div>
        </div>
      </div>

      <div class="p-5">
        <p class="text-sm font-medium mb-2">Upcoming Milestones</p>
        <div class="space-y-2 max-h-64 overflow-y-auto pr-1">
          ${(upcomingMilestones.length ? upcomingMilestones : openCards.slice(0, 8)).map((c) => `
            <div class="rounded-md border border-gray-200 bg-gray-50/70 px-3 py-2">
              <div class="flex items-center justify-between gap-3">
                <p class="text-sm truncate text-gray-800">${_escHtml(c.title || '')}</p>
                <span class="text-[11px] text-gray-500">${_escHtml(c.dueDate || 'No due date')}</span>
              </div>
              <p class="text-xs text-gray-500 truncate">${_escHtml(c.description || 'No description')}</p>
              <div class="mt-2">
                <button class="ai-dash-ask-btn px-2 py-1 text-[11px] font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded-md transition-colors" data-prompt="Help me plan this milestone: ${_escHtml(c.title || 'Untitled')} due ${_escHtml(c.dueDate || 'No due date')}. Include risk checks and next 3 actions.">
                  Ask AI About This
                </button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>`;

  root.querySelectorAll('.ai-dash-prompt-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prompt = btn.dataset.prompt || '';
      openAiChatWithPrompt(prompt, { expand: true });
    });
  });

  root.querySelectorAll('.ai-dash-ask-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prompt = btn.dataset.prompt || '';
      openAiChatWithPrompt(prompt, { expand: true });
    });
  });
}

function _updateDeckNavArrows() {
  const idx      = _boardsList.findIndex((b) => b.id === _currentBoardId);
  const prevBtn  = document.getElementById('deck-prev-btn');
  const nextBtn  = document.getElementById('deck-next-btn');
  const prevDashBtn = document.getElementById('ai-dashboard-deck-prev-btn');
  const nextDashBtn = document.getElementById('ai-dashboard-deck-next-btn');
  if (prevBtn) prevBtn.disabled = idx <= 0;
  if (nextBtn) nextBtn.disabled = idx < 0 || idx >= _boardsList.length - 1;
  if (prevDashBtn) prevDashBtn.disabled = idx <= 0;
  if (nextDashBtn) nextDashBtn.disabled = idx < 0 || idx >= _boardsList.length - 1;
}

function _openDeckTitlePicker(triggerBtn, onSelectBoard = (id, board) => _openBoard(id, board)) {
  document.querySelectorAll('.deck-picker-dropdown').forEach((m) => m.remove());

  const rect = triggerBtn.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'deck-picker-dropdown fixed z-50 bg-white rounded-xl shadow-lg border border-gray-100 py-1 text-sm w-72 max-h-80 overflow-y-auto';

  const desiredLeft = rect.left + (rect.width / 2) - 144;
  const clampedLeft = Math.max(10, Math.min(desiredLeft, window.innerWidth - 298));
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${clampedLeft}px`;

  if (!_boardsList.length) {
    menu.innerHTML = '<p class="px-3 py-2 text-xs text-gray-500">No decks found.</p>';
  } else {
    menu.innerHTML = _boardsList.map((b) => {
      const active = b.id === _currentBoardId;
      return `
        <button data-board-id="${_escHtml(b.id)}"
          class="w-full text-left px-3 py-2 transition-colors ${active ? 'bg-brand-50 text-brand-700' : 'hover:bg-gray-50 text-gray-700'}">
          <span class="block truncate">${_escHtml(b.title || 'Untitled Deck')}</span>
        </button>`;
    }).join('');
  }

  document.body.appendChild(menu);

  const close = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('click', close, true);
    }
  };
  setTimeout(() => document.addEventListener('click', close, true), 0);

  menu.querySelectorAll('[data-board-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextId = btn.dataset.boardId;
      const nextBoard = _boardsList.find((b) => b.id === nextId);
      menu.remove();
      if (!nextId || !nextBoard) return;
      onSelectBoard(nextId, nextBoard);
    });
  });
}

async function _openBoardInDashboard(boardId, board) {
  await _openBoard(boardId, board);
  _openAiDashboardPage();
}

document.getElementById('back-to-boards-btn')?.addEventListener('click', () => {
  unsubscribeFromCards();
  _showBoardsHome();
});

document.getElementById('deck-prev-btn')?.addEventListener('click', () => {
  const idx = _boardsList.findIndex((b) => b.id === _currentBoardId);
  if (idx > 0) _openBoard(_boardsList[idx - 1].id, _boardsList[idx - 1]);
});

document.getElementById('deck-next-btn')?.addEventListener('click', () => {
  const idx = _boardsList.findIndex((b) => b.id === _currentBoardId);
  if (idx >= 0 && idx < _boardsList.length - 1) _openBoard(_boardsList[idx + 1].id, _boardsList[idx + 1]);
});

document.getElementById('board-title-picker-btn')?.addEventListener('click', (e) => {
  _openDeckTitlePicker(e.currentTarget);
});

document.getElementById('ai-dashboard-title-picker-btn')?.addEventListener('click', (e) => {
  _openDeckTitlePicker(e.currentTarget, _openBoardInDashboard);
});

document.getElementById('ai-dashboard-deck-prev-btn')?.addEventListener('click', () => {
  const idx = _boardsList.findIndex((b) => b.id === _currentBoardId);
  if (idx > 0) _openBoardInDashboard(_boardsList[idx - 1].id, _boardsList[idx - 1]);
});

document.getElementById('ai-dashboard-deck-next-btn')?.addEventListener('click', () => {
  const idx = _boardsList.findIndex((b) => b.id === _currentBoardId);
  if (idx >= 0 && idx < _boardsList.length - 1) _openBoardInDashboard(_boardsList[idx + 1].id, _boardsList[idx + 1]);
});

document.getElementById('ai-trigger-btn')?.addEventListener('click', () => {
  toggleAiChat();
});

document.getElementById('board-kanban-view-btn')?.addEventListener('click', () => _applyBoardView('kanban'));
document.getElementById('board-list-view-btn')?.addEventListener('click', () => _applyBoardView('list'));
document.getElementById('board-calendar-view-btn')?.addEventListener('click', () => _applyBoardView('calendar'));
document.getElementById('ai-dashboard-btn')?.addEventListener('click', () => _openAiDashboardPage());
document.getElementById('back-to-board-from-ai-dashboard')?.addEventListener('click', () => {
  setAiChatMode('board');
  _showView('board');
});
document.getElementById('refresh-ai-dashboard-btn')?.addEventListener('click', () => _renderAiDashboardPage());

// ─── AI help modals (? buttons) ───────────────────────────────────────────────

const _BOARDS_HELP_EXAMPLES = [
  'Create a PM deck for a mobile e-commerce app',
  'Set up a deck for a machine learning data pipeline project',
  'Build a Kanban board for launching a SaaS product',
  'Create a deck for a REST API backend service',
  'Design a project plan for a mobile calculator app',
];

const _BOARDS_HELP_STEPS = [
  '1. Describe the project outcome and scope in one sentence.',
  '2. Include key phases you expect (for example: planning, build, QA, launch).',
  '3. Mention constraints like deadline, team size, or stack when relevant.',
  '4. AI creates columns and starter tasks mapped to those phases.',
];

const _BOARD_HELP_EXAMPLES = [
  'Create a new card for writing unit tests',
  'Add a task to set up CI/CD with GitHub Actions',
  'Add sub task testerman to task Fix Bug',
  'Add task Finish setup to Done',
  'Add task Validate API retries to In Progress',
  'Add a new task: implement user login',
  'Add sub task write edge-case checks to card Build App',
];

const _BOARD_HELP_STEPS = [
  '1. If no column is specified, AI defaults to TODO (first column).',
  '2. To target a column, include: "to Done", "to In Progress", or the exact column name.',
  '3. To target a specific card as sub-task, use: "add sub task <name> to task <card title>".',
  '4. Use quotes around card titles when possible for exact matching.',
];

function _openAiHelpModal(examples, heading, steps = []) {
  const modalRoot = document.getElementById('modal-root');
  const items = examples.map((ex) => `
    <li class="flex items-start gap-2 text-sm text-gray-700">
      <span class="text-amber-500 mt-0.5 flex-shrink-0">✨</span>
      <span class="italic">"${ex}"</span>
    </li>`).join('');
  const stepsHtml = steps.map((step) => `
    <li class="text-xs text-gray-600 leading-relaxed">${step}</li>
  `).join('');

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <div class="flex items-center gap-2 mb-4">
          <span class="text-lg">✨</span>
          <h3 class="text-base font-semibold text-gray-800">${heading}</h3>
        </div>
        ${steps.length ? `
          <div class="mb-4 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5">
            <p class="text-[11px] font-semibold uppercase tracking-wide text-amber-700 mb-1.5">Inference steps</p>
            <ol class="list-decimal pl-4 space-y-1">${stepsHtml}</ol>
          </div>
        ` : ''}
        <p class="text-xs text-gray-500 mb-3">Here are some example prompts you can type in the AI chat:</p>
        <ul class="flex flex-col gap-2.5 mb-5">${items}</ul>
        <div class="flex justify-end">
          <button id="ai-help-close"
            class="gold-btn px-5 py-2 text-sm font-medium rounded-lg">Got it</button>
        </div>
      </div>
    </div>`;

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('ai-help-close').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
}

document.getElementById('ai-board-help-btn')?.addEventListener('click', () => {
  _openAiHelpModal(_BOARDS_HELP_EXAMPLES, 'Example prompts — Boards', _BOARDS_HELP_STEPS);
});
document.getElementById('ai-board-help-btn-board')?.addEventListener('click', () => {
  _openAiHelpModal(_BOARD_HELP_EXAMPLES, 'Example prompts — Board tasks', _BOARD_HELP_STEPS);
});

document.getElementById('reset-col-widths-btn')?.addEventListener('click', () => {
  resetColumnWidths();
});

document.getElementById('project-timeline-btn')?.addEventListener('click', () => {
  _applyBoardView('timeline');
});

function _readLocalCompletionLogs(boardId) {
  try {
    const all = JSON.parse(localStorage.getItem('pmdek-completion-log') || '[]');
    return all
      .filter((log) => log?.boardId === boardId)
      .sort((a, b) => new Date(b.completedAtIso || 0) - new Date(a.completedAtIso || 0));
  } catch (_) {
    return [];
  }
}

function _readCompletionLogsFromCards() {
  const logs = getCardsSnapshot()
    .filter((c) => Boolean(c.completed))
    .map((c) => {
      const completedAtIso = c.completedAt?.toDate?.()?.toISOString?.()
        || c.updatedAt?.toDate?.()?.toISOString?.()
        || c.createdAt?.toDate?.()?.toISOString?.()
        || new Date().toISOString();
      return {
        id: `card-${c.id}`,
        cardId: c.id,
        cardTitle: c.title || 'Untitled task',
        type: 'task',
        completedAtIso,
      };
    })
    .sort((a, b) => new Date(b.completedAtIso || 0) - new Date(a.completedAtIso || 0));

  return logs;
}

async function _renderTimelineInPage() {
  const body = document.getElementById('board-timeline-view');
  if (!body) return;
  const cards = getCardsSnapshot();
  const datedCards = cards.filter((c) => Boolean(c.dueDate));

  if (!datedCards.length) {
    body.innerHTML = `
      <div class="rounded-xl border border-gray-200 bg-white p-8 text-center">
        <div class="text-4xl mb-3">📅</div>
        <p class="text-sm text-gray-600">No dated tasks yet for Timeline/Gantt.</p>
        <p class="text-xs text-gray-400 mt-1">Add due dates to cards to render the Gantt view.</p>
      </div>`;
    return;
  }

  const rows = datedCards.map((c) => {
    const due = new Date(`${c.dueDate}T00:00:00`);
    const startField = c.startDate ? new Date(`${c.startDate}T00:00:00`) : null;
    const created = c.createdAt?.toDate?.() || null;
    const startSource = startField || created;
    const start = startSource && startSource <= due
      ? new Date(startSource.getFullYear(), startSource.getMonth(), startSource.getDate())
      : new Date(due.getFullYear(), due.getMonth(), Math.max(1, due.getDate() - 2));

    const subtasks = Array.isArray(c.subtasks) ? c.subtasks : [];
    const doneSubs = subtasks.filter((s) => s.completed).length;
    const progress = c.completed
      ? 100
      : subtasks.length
        ? Math.round((doneSubs / subtasks.length) * 100)
        : 30;

    return {
      id: c.id,
      title: c.title || 'Untitled task',
      start,
      end: due,
      progress,
      completed: Boolean(c.completed),
      startDate: c.startDate || null,
      dueDate: c.dueDate,
    };
  }).sort((a, b) => a.end - b.end);

  const minStart = new Date(Math.min(...rows.map((r) => r.start.getTime())));
  const maxEnd = new Date(Math.max(...rows.map((r) => r.end.getTime())));
  minStart.setDate(minStart.getDate() - 1);
  maxEnd.setDate(maxEnd.getDate() + 1);

  const MS_DAY = 24 * 60 * 60 * 1000;
  const rangeDays = Math.max(1, Math.round((maxEnd - minStart) / MS_DAY) + 1);
  const tickCount = Math.min(8, Math.max(4, rangeDays));
  const ticks = Array.from({ length: tickCount }, (_, i) => {
    const dayOffset = Math.round((i / (tickCount - 1)) * (rangeDays - 1));
    const d = new Date(minStart.getTime() + (dayOffset * MS_DAY));
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  });

  const lanes = rows.map((r) => {
    const leftDays = Math.round((r.start - minStart) / MS_DAY);
    const spanDays = Math.max(1, Math.round((r.end - r.start) / MS_DAY) + 1);
    const leftPct = (leftDays / rangeDays) * 100;
    const widthPct = Math.max(2.5, (spanDays / rangeDays) * 100);
    const barClass = r.completed
      ? 'from-emerald-500 to-emerald-400'
      : 'from-brand-500 to-amber-400';
    const statusText = r.completed ? 'Done' : `${r.progress}%`;

    return `
      <div class="grid grid-cols-[220px_1fr] gap-3 items-center py-2 border-b border-gray-100 last:border-0">
        <div class="min-w-0">
          <p class="text-sm font-medium text-gray-800 truncate">${_escHtml(r.title)}</p>
          <p class="text-[11px] text-gray-500">${_escHtml(r.startDate || 'Auto')} → ${_escHtml(r.dueDate)} • ${statusText}</p>
        </div>
        <div class="relative h-7 rounded bg-gray-100 overflow-hidden">
          <div class="absolute inset-y-1 rounded bg-gradient-to-r ${barClass}" style="left:${leftPct}%;width:${widthPct}%">
            <div class="h-full bg-black/10" style="width:${Math.max(6, r.progress)}%"></div>
          </div>
        </div>
      </div>`;
  }).join('');

  body.innerHTML = `
    <div class="rounded-xl border border-gray-200 bg-white overflow-hidden">
      <div class="px-4 py-3 border-b border-gray-100 bg-gray-50 text-sm font-medium text-gray-700">Project Timeline/Gantt</div>
      <div class="px-4 pt-3 pb-2 border-b border-gray-100">
        <div class="grid" style="grid-template-columns:220px 1fr;gap:0.75rem;">
          <div></div>
          <div class="flex justify-between text-[10px] text-gray-500">${ticks.map((t) => `<span>${_escHtml(t)}</span>`).join('')}</div>
        </div>
      </div>
      <div class="max-h-[65vh] overflow-y-auto px-4 py-2">${lanes}</div>
    </div>`;
}

async function _openTimelineModal() {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[80vh] flex flex-col">
        <div class="flex items-center justify-between px-6 py-4 border-b border-gray-100 flex-shrink-0">
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 text-brand-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/>
            </svg>
            <h3 class="text-base font-semibold text-gray-800">Project Timeline</h3>
          </div>
          <button id="timeline-close" class="p-1 text-gray-400 hover:text-gray-600 transition-colors rounded-lg hover:bg-gray-100">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>
        <div id="timeline-body" class="flex-1 overflow-y-auto px-6 py-4">
          <div class="flex items-center justify-center py-10">
            <div class="w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('timeline-close').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  try {
    const { collection, query, where, orderBy, getDocs } = await import('firebase/firestore');
    const { db } = await import('./firebase.js');

    let logs;
    try {
      // Preferred: composite index query (boardId + completedAt DESC)
      const q = query(
        collection(db, 'completionLog'),
        where('boardId', '==', _currentBoardId),
        orderBy('completedAt', 'desc'),
      );
      const snap = await getDocs(q);
      logs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (indexErr) {
      const errCode = String(indexErr?.code || '');
      const errMsg = String(indexErr?.message || '');
      const isIndexNotReady = errCode === 'failed-precondition' || /index/i.test(errMsg);

      // Only fallback for missing composite index. Permission errors should bubble.
      if (!isIndexNotReady) throw indexErr;

      // Fallback: index still building — query without orderBy, sort client-side
      console.warn('Timeline composite index not ready, falling back to client sort:', indexErr.message);
      const q2 = query(
        collection(db, 'completionLog'),
        where('boardId', '==', _currentBoardId),
      );
      const snap2 = await getDocs(q2);
      logs = snap2.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.completedAt?.seconds ?? 0) - (a.completedAt?.seconds ?? 0));
    }

    const body = document.getElementById('timeline-body');
    if (!body) return;

    if (logs.length === 0) {
      body.innerHTML = `
        <div class="flex flex-col items-center justify-center py-10 text-center">
          <div class="text-4xl mb-3">📋</div>
          <p class="text-sm text-gray-500">No completed tasks yet.</p>
          <p class="text-xs text-gray-400 mt-1">Check off tasks to build your timeline.</p>
        </div>`;
      return;
    }

    body.innerHTML = logs.map((log) => {
      const date    = log.completedAt?.toDate?.() || (log.completedAtIso ? new Date(log.completedAtIso) : null);
      const dateStr = date
        ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
          + ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : '';
      return `
        <div class="flex items-start gap-3 py-3 border-b border-gray-50 last:border-0">
          <div class="flex-shrink-0 w-5 h-5 rounded-full bg-green-100 flex items-center justify-center mt-0.5">
            <svg class="w-3 h-3 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>
            </svg>
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-gray-800 truncate">${_escHtml(log.cardTitle)}</p>
            ${log.type === 'subtask' && log.subtaskTitle ? `<p class="text-xs text-gray-500 truncate">&#8627; ${_escHtml(log.subtaskTitle)}</p>` : ''}
            <p class="text-xs text-gray-400 mt-0.5">${dateStr}</p>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    console.error('Timeline load failed:', err);
    const errCode = String(err?.code || '');
    const errMsg = String(err?.message || '');
    const isPermissionError = errCode === 'permission-denied' || /insufficient permissions/i.test(errMsg);
    const body = document.getElementById('timeline-body');
    if (isPermissionError && body) {
      let logs = _readLocalCompletionLogs(_currentBoardId);
      if (logs.length === 0) logs = _readCompletionLogsFromCards();
      if (logs.length === 0) {
        body.innerHTML = `
          <div class="flex flex-col items-center justify-center py-10 text-center">
            <div class="text-4xl mb-3">📋</div>
            <p class="text-sm text-gray-500">No completed tasks yet.</p>
            <p class="text-xs text-gray-400 mt-1">Check off tasks to build your timeline.</p>
          </div>`;
        return;
      }

      body.innerHTML = logs.map((log) => {
        const date = log.completedAtIso ? new Date(log.completedAtIso) : null;
        const dateStr = date
          ? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
            + ' ' + date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
          : '';
        return `
          <div class="flex items-start gap-3 py-3 border-b border-gray-50 last:border-0">
            <div class="flex-shrink-0 w-5 h-5 rounded-full bg-green-100 flex items-center justify-center mt-0.5">
              <svg class="w-3 h-3 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>
              </svg>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-gray-800 truncate">${_escHtml(log.cardTitle)}</p>
              ${log.type === 'subtask' && log.subtaskTitle ? `<p class="text-xs text-gray-500 truncate">&#8627; ${_escHtml(log.subtaskTitle)}</p>` : ''}
              <p class="text-xs text-gray-400 mt-0.5">${dateStr}</p>
            </div>
          </div>`;
      }).join('');
      return;
    }

    if (body) body.innerHTML = `
      <div class="flex flex-col items-center justify-center py-10 text-center gap-3">
        <p class="text-sm text-red-500">Failed to load timeline.</p>
        <button id="timeline-retry" class="px-4 py-2 text-xs font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg transition-colors">
          Retry
        </button>
      </div>`;
    document.getElementById('timeline-retry')?.addEventListener('click', () => _openTimelineModal());
  }
}

function _escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

document.getElementById('create-card-top-btn')?.addEventListener('click', () => {
  _openCreateBlockModal();
});

function _openCreateBlockModal() {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <h3 class="text-lg font-semibold text-gray-800 mb-4">Create block</h3>
        <form id="create-block-form" class="flex flex-col gap-4">
          <input id="block-title-input" type="text" placeholder="Block name"
            required maxlength="50"
            class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500" />
          <div class="flex justify-end gap-2">
            <button type="button" id="create-block-cancel"
              class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">
              Cancel
            </button>
            <button type="submit"
              class="gold-btn px-4 py-2 text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg transition-colors">
              Create block
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  const form = document.getElementById('create-block-form');
  const input = document.getElementById('block-title-input');
  input.focus();

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('create-block-cancel').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
  _bindModalSubmitKeys(form);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = input.value.trim() || 'New Card';
    try {
      await createColumnBlock(title);
      close();
    } catch (err) {
      console.error('Create block failed:', err);
    }
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

// ─── Sign-in / sign-out ───────────────────────────────────────────────────────

document.getElementById('google-sign-in')?.addEventListener('click', async () => {
  try { await signInWithGoogle(); } catch (err) { _handleAuthError(err); }
});

document.getElementById('github-sign-in')?.addEventListener('click', async () => {
  try { await signInWithGitHub(); } catch (err) { _handleAuthError(err); }
});

// All sign-out buttons share the .sign-out-btn class
document.querySelectorAll('.sign-out-btn').forEach((btn) => {
  btn.addEventListener('click', () => signOutUser());
});

// ─── Account dropdown ─────────────────────────────────────────────────────────

function _openAccountMenu(triggerBtn) {
  document.querySelectorAll('.account-dropdown').forEach((m) => m.remove());

  const rect = triggerBtn.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.className = 'account-dropdown fixed z-50 bg-white rounded-xl shadow-lg border border-gray-100 py-1 text-sm w-44';
  menu.style.top  = `${rect.bottom + 6}px`;
  menu.style.right = `${window.innerWidth - rect.right}px`;

  const adminButtonHtml = _user?.isAdmin ? `
    <button data-action="admin-panel"
      class="w-full text-left px-4 py-2 hover:bg-amber-50 transition-colors flex items-center gap-2 text-amber-700">
      <svg class="w-3.5 h-3.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M13 10V3L4 14h7v7l9-11h-7z"/>
      </svg>
      Admin Panel
    </button>
    <div class="my-1 border-t border-gray-100"></div>
  ` : '';

  menu.innerHTML = `
    ${adminButtonHtml}
    <button data-action="account-settings"
      class="w-full text-left px-4 py-2 hover:bg-gray-50 transition-colors flex items-center gap-2 text-gray-700">
      <svg class="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M10.325 4.317a1 1 0 011.35-.936l1.745.698a1 1 0 00.76 0l1.745-.698a1 1 0 011.35.936l.188 1.874a1 1 0 00.573.82l1.6.8a1 1 0 01.447 1.342l-.8 1.6a1 1 0 000 .76l.8 1.6a1 1 0 01-.447 1.342l-1.6.8a1 1 0 00-.573.82l-.188 1.874a1 1 0 01-1.35.936l-1.745-.698a1 1 0 00-.76 0l-1.745.698a1 1 0 01-1.35-.936l-.188-1.874a1 1 0 00-.573-.82l-1.6-.8a1 1 0 01-.447-1.342l.8-1.6a1 1 0 000-.76l-.8-1.6a1 1 0 01.447-1.342l1.6-.8a1 1 0 00.573-.82l.188-1.874z"/>
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15a3 3 0 100-6 3 3 0 000 6z"/>
      </svg>
      Account settings
    </button>
    <button data-action="organizations"
      class="w-full text-left px-4 py-2 hover:bg-gray-50 transition-colors flex items-center gap-2 text-gray-700">
      <svg class="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M17 20h5V10H2v10h5m10 0v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6m10 0H7m3-10V6a2 2 0 114 0v4"/>
      </svg>
      Organizations
    </button>
    <button data-action="billing"
      class="w-full text-left px-4 py-2 hover:bg-gray-50 transition-colors flex items-center gap-2 text-gray-700">
      <svg class="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 9V7a5 5 0 00-10 0v2M5 9h14l1 10H4L5 9z"/>
      </svg>
      Billing
    </button>
    <div class="my-1 border-t border-gray-100"></div>
    <button data-action="signout"
      class="w-full text-left px-4 py-2 hover:bg-gray-50 transition-colors flex items-center gap-2 text-gray-700">
      <svg class="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
      </svg>
      Sign out
    </button>
    <button data-action="resetpw"
      class="w-full text-left px-4 py-2 hover:bg-gray-50 transition-colors flex items-center gap-2 text-gray-700">
      <svg class="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586
             a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
      </svg>
      Reset password
    </button>
    <div class="my-1 border-t border-gray-100"></div>
    <button data-action="deleteaccount"
      class="w-full text-left px-4 py-2 hover:bg-red-50 text-red-600 transition-colors flex items-center gap-2">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6
             m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
      </svg>
      Delete account
    </button>
  `;

  document.body.appendChild(menu);

  const close = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('click', close, true);
    }
  };
  setTimeout(() => document.addEventListener('click', close, true), 0);

  if (_user?.isAdmin) {
    menu.querySelector('[data-action="admin-panel"]')?.addEventListener('click', () => {
      menu.remove();
      _openAdminPanel();
    });
  }

  menu.querySelector('[data-action="account-settings"]').addEventListener('click', () => {
    menu.remove();
    _openAccountSettingsModal();
  });

  menu.querySelector('[data-action="organizations"]').addEventListener('click', () => {
    menu.remove();
    _openOrganizationsModal();
  });

  menu.querySelector('[data-action="billing"]').addEventListener('click', () => {
    menu.remove();
    _openBillingModal();
  });

  menu.querySelector('[data-action="signout"]').addEventListener('click', () => {
    menu.remove();
    signOutUser();
  });

  menu.querySelector('[data-action="resetpw"]').addEventListener('click', async () => {
    menu.remove();
    if (!_user?.email) return;
    try {
      await resetPassword(_user.email);
      _showSimpleModal('Password reset email sent to ' + _user.email + '. Check your inbox.');
    } catch (err) {
      _showSimpleModal('Could not send reset email: ' + (err.message || err));
    }
  });

  menu.querySelector('[data-action="deleteaccount"]').addEventListener('click', () => {
    menu.remove();
    _openDeleteAccountModal();
  });
}

['account-menu-btn-boards', 'account-menu-btn-board'].forEach((id) => {
  document.getElementById(id)?.addEventListener('click', (e) => _openAccountMenu(e.currentTarget));
});

function _openDeleteAccountModal() {
  const modalRoot = document.getElementById('modal-root');
  const isEmail = _user?.providerData?.some((p) => p.providerId === 'password');

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <div class="flex items-start gap-3 mb-4">
          <div class="flex-shrink-0 w-10 h-10 rounded-full bg-red-100 flex items-center justify-center">
            <svg class="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4
                   c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
            </svg>
          </div>
          <div>
            <h3 class="text-base font-semibold text-gray-900">Delete your account?</h3>
            <p class="mt-1 text-sm text-gray-500">
              This will permanently delete your account and <strong>all your decks and cards</strong>.
              This cannot be undone.
            </p>
          </div>
        </div>
        ${isEmail ? `
        <div class="mb-4">
          <label class="block text-xs font-medium text-gray-600 mb-1">Confirm your password to continue</label>
          <input id="delete-account-pw" type="password" placeholder="Your password"
            class="w-full rounded-lg border-gray-300 text-sm focus:ring-red-400 focus:border-red-400" />
        </div>` : `<p class="mb-4 text-sm text-amber-700 bg-amber-50 rounded-lg px-3 py-2">You will be asked to re-authenticate with your ${_user?.providerData?.[0]?.providerId?.replace('.com','') || 'social'} account.</p>`}
        <div id="delete-account-error" class="hidden mb-3 text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2"></div>
        <div class="flex justify-end gap-2">
          <button id="delete-account-cancel"
            class="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">
            Cancel
          </button>
          <button id="delete-account-confirm"
            class="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors">
            Delete everything
          </button>
        </div>
      </div>
    </div>
  `;

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('delete-account-cancel').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  document.getElementById('delete-account-confirm').addEventListener('click', async () => {
    const errEl  = document.getElementById('delete-account-error');
    const pwEl   = document.getElementById('delete-account-pw');
    const confirmBtn = document.getElementById('delete-account-confirm');
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Deleting…';
    errEl.classList.add('hidden');

    try {
      // Delete all user content first
      await _deleteAllUserContent(_user.uid);
      // Then delete the auth account (re-auth if needed)
      await deleteAccount(pwEl?.value || null);
      modalRoot.innerHTML = '';
      // onAuthStateChanged will fire and redirect to landing
    } catch (err) {
      console.error('Delete account failed:', err);
      errEl.textContent = err.message || 'Deletion failed. Please try again.';
      errEl.classList.remove('hidden');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Delete everything';
    }
  });
}

async function _deleteAllUserContent(userId) {
  const { collection, query, where, getDocs, deleteDoc, doc } = await import('firebase/firestore');
  const { db } = await import('./firebase.js');

  const [boardsSnap, cardsSnap] = await Promise.all([
    getDocs(query(collection(db, 'boards'), where('userId', '==', userId))),
    getDocs(query(collection(db, 'cards'),  where('userId', '==', userId))),
  ]);

  await Promise.all([
    ...boardsSnap.docs.map((d) => deleteDoc(doc(db, 'boards', d.id))),
    ...cardsSnap.docs.map((d) => deleteDoc(doc(db, 'cards', d.id))),
  ]);
}

function _showSimpleModal(message) {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
        <p class="text-sm text-gray-700 mb-5">${message}</p>
        <div class="flex justify-end">
          <button id="simple-modal-ok"
            class="gold-btn px-5 py-2 text-sm font-medium rounded-lg">OK</button>
        </div>
      </div>
    </div>`;
  document.getElementById('simple-modal-ok').addEventListener('click', () => { modalRoot.innerHTML = ''; });
}

export async function _openBillingModal() {
  const modalRoot = document.getElementById('modal-root');
  const plan = await getUserPlan(_user.uid);

  const personalPlans = ['free', 'mid', 'pro'];
  const businessPlans = ['business-small', 'business-growth'];

  const cardHtml = (key) => {
    const p = BILLING_PLANS[key];
    const isCurrent = p.key === plan.key;
    return `
      <div class="rounded-xl border ${isCurrent ? 'border-brand-400 bg-brand-50/60' : 'border-gray-200 bg-white'} p-4">
        <div class="flex items-center justify-between mb-2">
          <h4 class="font-semibold text-gray-800">${p.label}</h4>
          <span class="text-xs text-gray-500">$${p.monthlyUsd}/mo</span>
        </div>
        <ul class="text-xs text-gray-600 space-y-1 mb-3">
          <li>${p.deckLimit} deck limit</li>
          <li>${p.dailyAiRequests} AI requests/day</li>
          <li>${p.allowedProjectTypes === 'all' ? 'All project types' : 'Limited project types'}</li>
          <li>${p.canUseOrg ? 'Organization support' : 'No organization support'}</li>
        </ul>
        ${isCurrent
          ? '<button class="w-full px-3 py-2 text-xs rounded-lg border border-gray-300 text-gray-500 bg-gray-100" disabled>Current plan</button>'
          : `<button class="billing-checkout-btn w-full px-3 py-2 text-xs rounded-lg text-white bg-brand-500 hover:bg-brand-600" data-plan="${p.key}">Choose ${p.label}</button>`}
      </div>`;
  };

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold text-gray-800">Billing</h3>
          <button id="billing-close" class="text-gray-400 hover:text-gray-700">Close</button>
        </div>
        <div class="flex items-center gap-2 mb-4">
          <button id="billing-tab-personal" class="px-3 py-1.5 text-xs rounded-md bg-gray-900 text-white">Personal</button>
          <button id="billing-tab-business" class="px-3 py-1.5 text-xs rounded-md border border-gray-200 text-gray-700">Business</button>
        </div>
        <div id="billing-personal-grid" class="grid grid-cols-1 md:grid-cols-3 gap-3">
          ${personalPlans.map(cardHtml).join('')}
        </div>
        <div id="billing-business-grid" class="hidden grid grid-cols-1 md:grid-cols-2 gap-3">
          ${businessPlans.map(cardHtml).join('')}
        </div>
        <p id="billing-error" class="hidden mt-3 text-xs text-red-600"></p>
      </div>
    </div>`;

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('billing-close')?.addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  const personalTab = document.getElementById('billing-tab-personal');
  const businessTab = document.getElementById('billing-tab-business');
  const personalGrid = document.getElementById('billing-personal-grid');
  const businessGrid = document.getElementById('billing-business-grid');

  personalTab?.addEventListener('click', () => {
    personalGrid?.classList.remove('hidden');
    businessGrid?.classList.add('hidden');
    personalTab.className = 'px-3 py-1.5 text-xs rounded-md bg-gray-900 text-white';
    businessTab.className = 'px-3 py-1.5 text-xs rounded-md border border-gray-200 text-gray-700';
  });
  businessTab?.addEventListener('click', () => {
    businessGrid?.classList.remove('hidden');
    personalGrid?.classList.add('hidden');
    businessTab.className = 'px-3 py-1.5 text-xs rounded-md bg-gray-900 text-white';
    personalTab.className = 'px-3 py-1.5 text-xs rounded-md border border-gray-200 text-gray-700';
  });

  document.querySelectorAll('.billing-checkout-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const errorEl = document.getElementById('billing-error');
      try {
        const fn = httpsCallable(functions, 'createStripeCheckoutSession');
        const result = await fn({ planKey: btn.dataset.plan, successUrl: window.location.href, cancelUrl: window.location.href });
        const url = result?.data?.url;
        if (!url) throw new Error('Missing checkout URL from server.');
        window.location.href = url;
      } catch (err) {
        errorEl.textContent = err.message || 'Unable to start checkout right now.';
        errorEl.classList.remove('hidden');
      }
    });
  });
}

async function _openUsernamePickerModal() {
  const modalRoot = document.getElementById('modal-root');
  return new Promise((resolve) => {
    modalRoot.innerHTML = `
      <div class="modal-backdrop fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
        <div class="bg-white rounded-xl shadow-xl w-full max-w-sm p-6">
          <h3 class="text-lg font-semibold text-gray-800 mb-1">Choose your username</h3>
          <p class="text-xs text-gray-500 mb-4">Required once. Others will add you by this name.</p>
          <form id="username-form" class="space-y-3">
            <div>
              <label class="block text-sm font-medium text-gray-700 mb-1" for="username-input">Username</label>
              <div class="flex items-center rounded-lg border border-gray-300 px-2">
                <span class="text-gray-400 text-sm">@</span>
                <input id="username-input" type="text" maxlength="20" autocomplete="off"
                  class="flex-1 border-0 focus:ring-0 text-sm" placeholder="your_name" />
              </div>
              <p id="username-error" class="hidden mt-1 text-xs text-red-600"></p>
            </div>
            <button id="username-submit" type="submit"
              class="w-full gold-btn px-4 py-2 text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg transition-colors">
              Save username
            </button>
          </form>
        </div>
      </div>`;

    const form = document.getElementById('username-form');
    const input = document.getElementById('username-input');
    const errorEl = document.getElementById('username-error');
    const submitBtn = document.getElementById('username-submit');
    input?.focus();

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = (input?.value || '').trim().toLowerCase();
      const validation = validateUsername(value);
      if (validation) {
        errorEl.textContent = validation;
        errorEl.classList.remove('hidden');
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving...';
      try {
        const available = await checkUsernameAvailable(value);
        if (!available) throw new Error('Username is already taken.');
        await claimUsername(_user.uid, value);
        modalRoot.innerHTML = '';
        resolve();
      } catch (err) {
        errorEl.textContent = err.message || 'Could not save username.';
        errorEl.classList.remove('hidden');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Save username';
      }
    });
  });
}

async function _openAccountSettingsModal() {
  const modalRoot = document.getElementById('modal-root');
  _userProfile = await getUserProfile(_user.uid);

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[88vh] overflow-y-auto p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold text-gray-800">Account settings</h3>
          <button id="acct-settings-close" class="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div class="space-y-3 pb-4 border-b border-gray-100">
          <h4 class="text-sm font-semibold text-gray-800">Profile</h4>
          <div>
            <label class="block text-xs text-gray-500 mb-1">Username</label>
            <div class="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">@${_escHtml(_userProfile?.username || '')}</div>
          </div>
          <div>
            <label class="block text-xs text-gray-500 mb-1" for="acct-display-name">Display name</label>
            <div class="flex gap-2">
              <input id="acct-display-name" type="text" maxlength="80" value="${_escHtml(_userProfile?.displayName || _user.displayName || '')}"
                class="flex-1 rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500" />
              <button id="acct-display-name-save" class="px-3 py-2 text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg">Save</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('acct-settings-close')?.addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  document.getElementById('acct-display-name-save')?.addEventListener('click', async () => {
    const value = document.getElementById('acct-display-name')?.value?.trim() || '';
    if (!value) return;
    await updateUserDisplayName(_user.uid, value);
    _userProfile = { ..._userProfile, displayName: value };
    _updateUserUI({ ..._user, displayName: value });
    _showSimpleModal('Display name updated.');
  });
}

async function _openOrganizationsModal() {
  const modalRoot = document.getElementById('modal-root');
  _userProfile = await getUserProfile(_user.uid);
  const org = _userProfile?.organizationId ? await getOrgById(_userProfile.organizationId) : null;
  const members = org ? await getOrgMembers(org.id) : [];
  const isOwner = Boolean(org && org.ownerId === _user.uid);

  const memberRows = members.map((m) => {
    const label = m.displayName ? `${m.displayName} (@${m.username || ''})` : `@${m.username || m.uid}`;
    const removeBtn = isOwner && m.uid !== _user.uid
      ? `<button type="button" class="org-remove-btn text-xs text-red-600 hover:text-red-700" data-uid="${m.uid}">Remove</button>`
      : '<span class="text-[10px] text-gray-400">member</span>';
    return `
      <div class="flex items-center justify-between py-1.5 border-b border-gray-100 last:border-0">
        <span class="text-sm text-gray-700">${_escHtml(label)}</span>
        ${removeBtn}
      </div>`;
  }).join('');

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-lg max-h-[88vh] overflow-y-auto p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold text-gray-800">Organizations</h3>
          <button id="org-settings-close" class="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div class="space-y-3">
          ${org ? `
            <div class="rounded-lg border border-gray-200 p-3">
              <p class="text-sm text-gray-800 font-medium">${_escHtml(org.name || 'Organization')}</p>
              <p class="text-xs text-gray-500 mt-0.5">${isOwner ? 'You are the owner' : 'You are a member'}</p>
            </div>
            <div>
              <p class="text-xs text-gray-500 mb-1">Members</p>
              <div class="rounded-lg border border-gray-200 px-3">${memberRows || '<p class="text-sm text-gray-500 py-2">No members yet.</p>'}</div>
            </div>
            ${isOwner ? `
              <form id="org-invite-form" class="flex gap-2">
                <input id="org-invite-username" type="text" maxlength="20" placeholder="username"
                  class="flex-1 rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500" />
                <button type="submit" class="px-3 py-2 text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg">Add user</button>
              </form>` : ''}
          ` : `
            <form id="org-create-form" class="flex gap-2">
              <input id="org-name-input" type="text" maxlength="80" placeholder="Organization name"
                class="flex-1 rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500" />
              <button type="submit" class="px-3 py-2 text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg">Create</button>
            </form>
          `}
          <p id="org-settings-error" class="hidden text-xs text-red-600"></p>
        </div>
      </div>
    </div>`;

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('org-settings-close')?.addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  const errorEl = document.getElementById('org-settings-error');
  document.getElementById('org-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('org-name-input')?.value?.trim() || '';
    if (!name) return;
    try {
      const plan = await getUserPlan(_user.uid);
      if (!plan.canUseOrg) throw new Error('Organization creation requires Pro or Business tier.');
      await createOrg(_user.uid, name);
      await _openOrganizationsModal();
    } catch (err) {
      errorEl.textContent = err.message || 'Could not create organization.';
      errorEl.classList.remove('hidden');
    }
  });

  document.getElementById('org-invite-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('org-invite-username')?.value?.trim().toLowerCase() || '';
    const validation = validateUsername(username);
    if (validation) {
      errorEl.textContent = validation;
      errorEl.classList.remove('hidden');
      return;
    }
    try {
      await addMemberByUsername(org.id, username, org.id);
      await _openOrganizationsModal();
    } catch (err) {
      errorEl.textContent = err.message || 'Could not add member.';
      errorEl.classList.remove('hidden');
    }
  });

  document.querySelectorAll('.org-remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await removeMember(org.id, btn.dataset.uid);
        await _openOrganizationsModal();
      } catch (err) {
        errorEl.textContent = err.message || 'Could not remove member.';
        errorEl.classList.remove('hidden');
      }
    });
  });
}

// ─── Admin panel ──────────────────────────────────────────────────────────────

async function _openAdminPanel() {
  const modalRoot = document.getElementById('modal-root');
  
  // Fetch all users and orgs
  const allUsers = await getAllUsers();
  const allOrgs = await getAllOrganizations();
  const { getDocs, collection, query, where } = await import('firebase/firestore');
  const { db } = await import('./firebase.js');
  
  // Fetch all boards to calculate content used
  const boardsSnap = await getDocs(collection(db, 'boards'));
  const cardsSnap = await getDocs(collection(db, 'cards'));
  
  const stats = {
    totalUsers: allUsers.length,
    totalOrgs: allOrgs.length,
    totalBoards: boardsSnap.size,
    totalCards: cardsSnap.size,
  };
  
  // Build users table HTML
  const usersTableHtml = allUsers.map((user) => {
    const planKey = user.billingPlan || 'free';
    const isUserAdmin = Boolean(user.isAdmin);
    return `
      <tr class="border-b border-gray-200 hover:bg-gray-50">
        <td class="px-4 py-3 text-sm"><span class="font-medium">${_escHtml(user.displayName || user.username || user.uid)}</span></td>
        <td class="px-4 py-3 text-sm">${_escHtml(user.email || '—')}</td>
        <td class="px-4 py-3 text-sm">
          ${isUserAdmin ? '<span class="px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800">✨ Admin</span>' : '<span class="text-gray-500">—</span>'}
        </td>
        <td class="px-4 py-3 text-sm">
          <span class="px-2 py-1 rounded text-xs font-medium bg-blue-100 text-blue-800">${planKey}</span>
        </td>
        <td class="px-4 py-3 text-sm">
          <button class="admin-toggle-user-btn text-xs px-2 py-1 rounded border transition-colors" data-uid="${user.uid}" data-is-admin="${isUserAdmin ? '1' : '0'}"
            style="color: ${isUserAdmin ? '#dc2626' : '#059669'}; border-color: ${isUserAdmin ? '#dc2626' : '#059669'};">
            ${isUserAdmin ? 'Remove Admin' : 'Make Admin'}
          </button>
        </td>
      </tr>
    `;
  }).join('');
  
  // Build orgs table HTML
  const orgsTableHtml = allOrgs.map((org) => {
    const memberCount = Array.isArray(org.members) ? org.members.length : 0;
    const adminCount = Array.isArray(org.admins) ? org.admins.length : 0;
    return `
      <tr class="border-b border-gray-200 hover:bg-gray-50">
        <td class="px-4 py-3 text-sm"><span class="font-medium">${_escHtml(org.name)}</span></td>
        <td class="px-4 py-3 text-sm">${memberCount}</td>
        <td class="px-4 py-3 text-sm">
          <span class="px-2 py-1 rounded text-xs font-medium bg-purple-100 text-purple-800">${adminCount}</span>
        </td>
        <td class="px-4 py-3 text-sm text-gray-500">${org.id}</td>
      </tr>
    `;
  }).join('');
  
  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-6xl p-6 max-h-[85vh] overflow-y-auto">
        <div class="flex items-center justify-between mb-6">
          <div class="flex items-center gap-2">
            <span class="text-2xl">⚡</span>
            <h2 class="text-2xl font-semibold text-gray-800">Admin Panel</h2>
          </div>
          <button id="admin-close" class="text-gray-400 hover:text-gray-600 text-2xl">&times;</button>
        </div>
        
        <!-- Stats Row -->
        <div class="grid grid-cols-4 gap-4 mb-6">
          <div class="rounded-lg border border-gray-200 bg-gradient-to-br from-blue-50 to-blue-100 p-4">
            <p class="text-xs text-blue-700 font-semibold">Total Users</p>
            <p class="mt-2 text-2xl font-bold text-blue-900">${stats.totalUsers}</p>
          </div>
          <div class="rounded-lg border border-gray-200 bg-gradient-to-br from-purple-50 to-purple-100 p-4">
            <p class="text-xs text-purple-700 font-semibold">Organizations</p>
            <p class="mt-2 text-2xl font-bold text-purple-900">${stats.totalOrgs}</p>
          </div>
          <div class="rounded-lg border border-gray-200 bg-gradient-to-br from-green-50 to-green-100 p-4">
            <p class="text-xs text-green-700 font-semibold">Boards</p>
            <p class="mt-2 text-2xl font-bold text-green-900">${stats.totalBoards}</p>
          </div>
          <div class="rounded-lg border border-gray-200 bg-gradient-to-br from-amber-50 to-amber-100 p-4">
            <p class="text-xs text-amber-700 font-semibold">Cards</p>
            <p class="mt-2 text-2xl font-bold text-amber-900">${stats.totalCards}</p>
          </div>
        </div>
        
        <!-- Users Section -->
        <div class="mb-8">
          <h3 class="text-lg font-semibold text-gray-800 mb-3">Users (${stats.totalUsers})</h3>
          <div class="overflow-x-auto rounded-lg border border-gray-200">
            <table class="w-full text-sm">
              <thead class="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th class="px-4 py-3 text-left font-semibold text-gray-700">Name</th>
                  <th class="px-4 py-3 text-left font-semibold text-gray-700">Email</th>
                  <th class="px-4 py-3 text-left font-semibold text-gray-700">Status</th>
                  <th class="px-4 py-3 text-left font-semibold text-gray-700">Plan</th>
                  <th class="px-4 py-3 text-left font-semibold text-gray-700">Action</th>
                </tr>
              </thead>
              <tbody>
                ${usersTableHtml}
              </tbody>
            </table>
          </div>
        </div>
        
        <!-- Organizations Section -->
        <div class="mb-8">
          <h3 class="text-lg font-semibold text-gray-800 mb-3">Organizations (${stats.totalOrgs})</h3>
          <div class="overflow-x-auto rounded-lg border border-gray-200">
            <table class="w-full text-sm">
              <thead class="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th class="px-4 py-3 text-left font-semibold text-gray-700">Org Name</th>
                  <th class="px-4 py-3 text-left font-semibold text-gray-700">Members</th>
                  <th class="px-4 py-3 text-left font-semibold text-gray-700">Admins</th>
                  <th class="px-4 py-3 text-left font-semibold text-gray-700">Org ID</th>
                </tr>
              </thead>
              <tbody>
                ${orgsTableHtml}
              </tbody>
            </table>
          </div>
        </div>
        
        <div class="flex justify-end">
          <button id="admin-close-btn" class="px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition-colors">
            Close
          </button>
        </div>
      </div>
    </div>
  `;
  
  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('admin-close').addEventListener('click', close);
  document.getElementById('admin-close-btn').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
  
  // Add event listeners for admin toggle buttons
  document.querySelectorAll('.admin-toggle-user-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const uid = btn.dataset.uid;
      const currentIsAdmin = btn.dataset.isAdmin === '1';
      try {
        await setUserAdminStatus(uid, !currentIsAdmin);
        await _openAdminPanel();
      } catch (err) {
        console.error('Failed to toggle admin status:', err);
        alert('Failed to update admin status: ' + (err.message || err));
      }
    });
  });
}

// ─── Email / password form ────────────────────────────────────────────────────

document.getElementById('email-auth-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email    = document.getElementById('email-input').value.trim();
  const password = document.getElementById('password-input').value;
  try {
    if (_emailMode === 'register') {
      await registerWithEmail(email, password);
    } else {
      await signInWithEmail(email, password);
    }
  } catch (err) {
    _handleAuthError(err);
  }
});

document.getElementById('auth-toggle-btn')?.addEventListener('click', () => {
  _emailMode = _emailMode === 'signin' ? 'register' : 'signin';
  const isReg = _emailMode === 'register';
  document.getElementById('auth-submit-btn').textContent = isReg ? 'Create account' : 'Sign in';
  document.getElementById('auth-toggle-btn').textContent = isReg
    ? 'Already have an account? Sign in'
    : "Don't have an account? Create one";
  document.getElementById('forgot-password-btn')?.classList.toggle('hidden', isReg);
});

document.getElementById('forgot-password-btn')?.addEventListener('click', async () => {
  const email = document.getElementById('email-input').value.trim();
  if (!email) { _handleAuthError({ code: 'auth/missing-email' }); return; }
  try {
    await resetPassword(email);
    _showAuthMessage('Password reset email sent. Check your inbox.');
  } catch (err) {
    _handleAuthError(err);
  }
});

// ─── View transitions ─────────────────────────────────────────────────────────

const _views = {
  landing: document.getElementById('landing-view'),
  boards:  document.getElementById('boards-view'),
  board:   document.getElementById('board-view'),
  'ai-dashboard': document.getElementById('ai-dashboard-view'),
};

// Hide all views immediately — auth state callback will reveal the correct one.
// This prevents any view flashing before Firebase resolves auth.
Object.values(_views).forEach((el) => { if (el) el.style.display = 'none'; });

const _viewDisplayMap = {
  landing: 'flex',
  boards:  'flex',
  board:   'flex',
  'ai-dashboard': 'flex',
};

function _showView(name) {
  Object.entries(_views).forEach(([key, el]) => {
    if (!el) return;
    if (key === name) {
      el.style.display = _viewDisplayMap[key];
      el.classList.remove('view-entering');
      void el.offsetWidth;
      el.classList.add('view-entering');
    } else {
      el.style.display = 'none';
    }
  });

  const sidebar = document.getElementById('ai-chat-sidebar');
  if (sidebar) {
    sidebar.classList.toggle('ai-chat-dashboard-docked', name === 'ai-dashboard');
  }
}

// ─── User UI ──────────────────────────────────────────────────────────────────

function _updateUserUI(user) {
  // Class selectors so both boards-view and board-view stay in sync.
  document.querySelectorAll('.user-avatar').forEach((el) => {
    el.src = user.photoURL || '';
    el.alt = user.displayName || 'User';
    el.classList.toggle('hidden', !user.photoURL);
  });
  document.querySelectorAll('.user-display-name').forEach((el) => {
    el.textContent = user.displayName || user.email || '';
  });
}

// ─── Auth error handling ──────────────────────────────────────────────────────

function _handleAuthError(err) {
  if (err.code === 'auth/popup-closed-by-user') return;
  console.error('Auth error:', err.code, err.message);
  _showAuthMessage(_friendlyAuthError(err.code), 'error');
}

function _showAuthMessage(text, type = 'info') {
  const el = document.getElementById('auth-error');
  if (!el || !text) return;
  el.textContent = text;
  el.className = type === 'error'
    ? 'mb-4 text-sm text-red-600 bg-red-50 rounded-lg px-4 py-2'
    : 'mb-4 text-sm text-green-700 bg-green-50 rounded-lg px-4 py-2';
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 5000);
}

function _friendlyAuthError(code) {
  const map = {
    'auth/account-exists-with-different-credential': 'An account already exists with this email. Try a different sign-in method.',
    'auth/cancelled-popup-request': '',
    'auth/network-request-failed':  'Network error. Check your connection and try again.',
    'auth/user-not-found':          'No account found with that email.',
    'auth/wrong-password':          'Incorrect password.',
    'auth/invalid-credential':      'Incorrect email or password.',
    'auth/email-already-in-use':    'An account already exists with that email.',
    'auth/weak-password':           'Password must be at least 6 characters.',
    'auth/invalid-email':           'Please enter a valid email address.',
    'auth/missing-email':           'Please enter your email address first.',
    'auth/too-many-requests':       'Too many attempts. Try again later.',
  };
  return map[code] || 'Sign-in failed. Please try again.';
}

// ─── Admin setup helper ────────────────────────────────────────────────────────
// Call from browser console: window.setupAdmin('user@example.com')

window.setupAdmin = async function(email) {
  if (!email || typeof email !== 'string') {
    console.error('❌ Usage: window.setupAdmin("user@example.com")');
    return;
  }
  try {
    const setUserAsAdminFn = httpsCallable(functions, 'setUserAsAdmin');
    const result = await setUserAsAdminFn({ email });
    console.log(`✅ Admin setup complete for ${email}`, result.data);
    return result.data;
  } catch (err) {
    console.error('❌ Admin setup failed:', err.message);
    throw err;
  }
};

console.log('💡 Tip: Call window.setupAdmin("email@example.com") from console to make a user an admin.');

