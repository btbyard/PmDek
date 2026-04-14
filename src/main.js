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
import { renderBoard, setBoardId, createColumnBlock, resetColumnWidths, refreshStickyNoteHeights } from './board.js';
import { subscribeToCards, unsubscribeFromCards, initCardEvents, setBoardAssignedMembers, getBoardAssignedMembers, renderListView, renderCalendarView, getCardsSnapshot } from './cards.js';
import { renderBoardsHome, openCreateBoardModal }                 from './boards-home.js';
import { initAiChat, setAiChatMode, openAiChatWithPrompt, collapseAiChat, expandAiChat } from './ai-chat.js';
import { doc, getDoc }                                             from 'firebase/firestore';
import { ref as storageRef, uploadBytes, getDownloadURL }          from 'firebase/storage';
import { updateProfile }                                           from 'firebase/auth';
import { db, functions, storage, auth as firebaseAuth }            from './firebase.js';
import { ensureUserProfile, claimUsername, validateUsername, checkUsernameAvailable, updateUserDisplayName, updateUserPhotoURL, getUserProfile, getAllUsers, setUserAdminStatus } from './users.js';
import { createOrg, getOrgById, getOrgMembers, addMemberByUsername, removeMember, setOrgMemberRole, getAllOrganizations } from './org.js';
import { BILLING_PLANS, getPlanConfig, getUserPlan, getUserBillingContext, canCreateOrganization, ensureBillingDefaults }      from './billing.js';
import { httpsCallable }                                           from 'firebase/functions';

// ─── Module state ─────────────────────────────────────────────────────────────

/** Authenticated user, set on sign-in and cleared on sign-out. */
let _user = null;
let _userProfile = null;

const BOOTSTRAP_ADMIN_EMAILS = ['bradster8@yahoo.com'];

function _isGlobalAdminClient() {
  const profileAdmin = Boolean(_userProfile?.isAdmin);
  const email = String(_user?.email || '').toLowerCase().trim();
  return profileAdmin || BOOTSTRAP_ADMIN_EMAILS.includes(email);
}

// Tracks whether the email form is in sign-in or register mode.
let _emailMode = 'signin'; // 'signin' | 'register'

// Ordered list of boards for prev/next navigation.
let _boardsList = [];
let _currentBoardId = null;
let _boardViewMode = 'kanban';
let _activeViewName = 'landing';
let _adminPanelReturnView = 'boards';
let _infoPageReturnView = 'boards';

const THEME_STORAGE_KEY = 'pmdeck-theme';

function _isDarkMode() {
  return localStorage.getItem(THEME_STORAGE_KEY) === 'dark';
}

function _applyTheme(theme) {
  const isDark = theme === 'dark';
  document.documentElement.classList.toggle('pm-dark', isDark);
}

function _toggleTheme() {
  const next = _isDarkMode() ? 'light' : 'dark';
  localStorage.setItem(THEME_STORAGE_KEY, next);
  _applyTheme(next);
}

_applyTheme(_isDarkMode() ? 'dark' : 'light');

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
    _updateUserUI({
      ...user,
      displayName: _userProfile?.displayName || user.displayName,
      photoURL: _userProfile?.photoURL || user.photoURL,
    });
    initAiChat(user, {
      onBoardCreated: (boardId, board) => {
        _boardsList = _getLastBoards();
        _openBoard(boardId, board);
      },
    });
    const _savedHash = location.hash;
    await _showBoardsHome();
    await _restoreFromHash(_savedHash);
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

async function _restoreFromHash(hash) {
  const h = (hash || '').replace(/^#/, '');
  if (!h || h === 'boards') return;
  if (h === 'organizations') { await _openOrganizationsPage(); return; }
  if (h === 'help') { _openHelpPage(); return; }
  if (h === 'support') { _openSupportPage(); return; }
  if (h === 'privacy') { _openPrivacyPage(); return; }
  const aiMatch = h.match(/^ai-dashboard\/(.+)$/);
  if (aiMatch) { await _openBoard(aiMatch[1]); _openAiDashboardPage(); return; }
  const boardMatch = h.match(/^board\/(.+)$/);
  if (boardMatch) { await _openBoard(boardMatch[1]); return; }
}

async function _showBoardsHome() {
  location.hash = 'boards';
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

document.getElementById('open-organizations-page-btn')?.addEventListener('click', () => {
  _openOrganizationsPage();
});

document.getElementById('back-to-boards-from-orgs')?.addEventListener('click', async () => {
  await _showBoardsHome();
});

document.getElementById('back-from-admin-panel-btn')?.addEventListener('click', async () => {
  if (_adminPanelReturnView === 'board') {
    _showView('board');
    return;
  }
  if (_adminPanelReturnView === 'organizations') {
    await _openOrganizationsPage();
    return;
  }
  await _showBoardsHome();
});

document.getElementById('ai-board-btn')?.addEventListener('click', () => {
  expandAiChat();
});

document.getElementById('board-activity-log-btn')?.addEventListener('click', () => {
  _openBoardActivityModal();
});

document.getElementById('back-from-help-btn')?.addEventListener('click', async () => {
  if (_infoPageReturnView === 'board') { _showView('board'); return; }
  if (_infoPageReturnView === 'organizations') { await _openOrganizationsPage(); return; }
  if (_infoPageReturnView === 'ai-dashboard') { _showView('ai-dashboard'); return; }
  await _showBoardsHome();
});

document.getElementById('back-from-support-btn')?.addEventListener('click', async () => {
  if (_infoPageReturnView === 'board') { _showView('board'); return; }
  if (_infoPageReturnView === 'organizations') { await _openOrganizationsPage(); return; }
  if (_infoPageReturnView === 'ai-dashboard') { _showView('ai-dashboard'); return; }
  await _showBoardsHome();
});

document.getElementById('back-from-privacy-btn')?.addEventListener('click', async () => {
  if (_infoPageReturnView === 'board') { _showView('board'); return; }
  if (_infoPageReturnView === 'organizations') { await _openOrganizationsPage(); return; }
  if (_infoPageReturnView === 'ai-dashboard') { _showView('ai-dashboard'); return; }
  await _showBoardsHome();
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

  // Show org name under the title if this deck belongs to an org
  const orgNameEl = document.getElementById('board-org-name-display');
  if (orgNameEl) {
    if (boardObj.orgId) {
      getOrgById(boardObj.orgId).then((org) => {
        if (org?.name) {
          orgNameEl.textContent = org.name;
          orgNameEl.classList.remove('hidden');
        } else {
          orgNameEl.classList.add('hidden');
        }
      });
    } else {
      orgNameEl.textContent = '';
      orgNameEl.classList.add('hidden');
    }
  }

  // Update due date display (hide for org boards)
  const dueDateEl = document.getElementById('board-due-date-display');
  if (dueDateEl) {
    if (boardObj.dueDate && !boardObj.orgId) {
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
  location.hash = `board/${boardId}`;
  _showView('board');
  // Board view is now visible — measure sticky textarea heights correctly.
  requestAnimationFrame(() => refreshStickyNoteHeights());
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
  location.hash = `ai-dashboard/${_currentBoardId}`;
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
  const due14 = openCards.filter((c) => c.dueDate && new Date(c.dueDate + 'T00:00:00') > in7 && new Date(c.dueDate + 'T00:00:00') <= in14);
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
  const sortByDue = (items) => [...items].sort((a, b) => {
    const aDue = a?.dueDate ? new Date(`${a.dueDate}T00:00:00`).getTime() : Number.MAX_SAFE_INTEGER;
    const bDue = b?.dueDate ? new Date(`${b.dueDate}T00:00:00`).getTime() : Number.MAX_SAFE_INTEGER;
    return aDue - bDue;
  });
  const unassignedOpenCards = openCards.filter((c) => !Array.isArray(c.assignees) || c.assignees.length === 0);
  const unassignedOpenSubtasks = openSubtasks.filter((s) => !s.assignee);
  const complexDueSoon = openCards.filter((c) => {
    const openCount = Array.isArray(c.subtasks) ? c.subtasks.filter((s) => !s.completed).length : 0;
    return openCount >= 3 && c.dueDate && new Date(c.dueDate + 'T00:00:00') <= in7;
  });
  const atRiskExecution = openCards.filter((c) => {
    const subtasks = Array.isArray(c.subtasks) ? c.subtasks : [];
    if (!subtasks.length || !c.dueDate) return false;
    const doneSubs = subtasks.filter((s) => s.completed).length;
    const progress = doneSubs / subtasks.length;
    return progress < 0.35 && new Date(c.dueDate + 'T00:00:00') <= in7;
  });

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

  const recommendationCandidates = [];
  const pushRec = (score, html, plain) => recommendationCandidates.push({ score, html, plain: plain || html });

  const listTaskNames = (items, max = 5) => items
    .slice(0, max)
    .map((c) => `<strong class="text-gray-900 font-semibold">${_escHtml(c.title || 'Untitled')}</strong>${c.dueDate ? ` <span class="text-gray-400">(${_escHtml(c.dueDate)})</span>` : ''}`)
    .join(', ');
  const listSubtaskNames = (items, max = 5) => items
    .slice(0, max)
    .map((s) => `<strong class="text-gray-900 font-semibold">${_escHtml(s.title || 'Untitled subtask')}</strong>`)
    .join(', ');
  // Plain text versions for AI prompts (no HTML)
  const listTaskNamesPlain = (items, max = 5) => items
    .slice(0, max)
    .map((c) => `${c.title || 'Untitled'}${c.dueDate ? ` (${c.dueDate})` : ''}`)
    .join(', ');
  const listSubtaskNamesPlain = (items, max = 5) => items
    .slice(0, max)
    .map((s) => s.title || 'Untitled subtask')
    .join(', ');

  if (overdue.length > 0) {
    pushRec(100 + overdue.length,
      `Clear ${overdue.length} overdue task${overdue.length === 1 ? '' : 's'} immediately: ${listTaskNames(sortByDue(overdue), 4)}.`,
      `Clear ${overdue.length} overdue task${overdue.length === 1 ? '' : 's'} immediately: ${listTaskNamesPlain(sortByDue(overdue), 4)}.`);
  }
  if (blocked.length > 0) {
    pushRec(92 + blocked.length,
      `Unblock ${blocked.length} task${blocked.length === 1 ? '' : 's'} currently marked blocked, risk, hold, or waiting: ${listTaskNames(sortByDue(blocked), 4)}.`,
      `Unblock ${blocked.length} task${blocked.length === 1 ? '' : 's'} currently marked blocked, risk, hold, or waiting: ${listTaskNamesPlain(sortByDue(blocked), 4)}.`);
  }
  if (complexDueSoon.length > 0) {
    pushRec(88 + complexDueSoon.length,
      `Break down ${complexDueSoon.length} due-soon task${complexDueSoon.length === 1 ? '' : 's'} with 3+ open subtasks so execution is easier to manage this week: ${listTaskNames(sortByDue(complexDueSoon), 4)}.`,
      `Break down ${complexDueSoon.length} due-soon task${complexDueSoon.length === 1 ? '' : 's'} with 3+ open subtasks so execution is easier to manage this week: ${listTaskNamesPlain(sortByDue(complexDueSoon), 4)}.`);
  }
  if (atRiskExecution.length > 0) {
    pushRec(84 + atRiskExecution.length,
      `Escalate ${atRiskExecution.length} due-soon task${atRiskExecution.length === 1 ? '' : 's'} with low subtask completion progress before they slip: ${listTaskNames(sortByDue(atRiskExecution), 4)}.`,
      `Escalate ${atRiskExecution.length} due-soon task${atRiskExecution.length === 1 ? '' : 's'} with low subtask completion progress before they slip: ${listTaskNamesPlain(sortByDue(atRiskExecution), 4)}.`);
  }
  if (dueSoon.length > 0) {
    pushRec(80 + dueSoon.length,
      `Prioritize ${dueSoon.length} task${dueSoon.length === 1 ? '' : 's'} due in the next 7 days: ${listTaskNames(sortByDue(dueSoon), 5)}.`,
      `Prioritize ${dueSoon.length} task${dueSoon.length === 1 ? '' : 's'} due in the next 7 days: ${listTaskNamesPlain(sortByDue(dueSoon), 5)}.`);
  }
  if (unassignedOpenCards.length > 0) {
    pushRec(76 + unassignedOpenCards.length,
      `Assign owners to ${unassignedOpenCards.length} open task${unassignedOpenCards.length === 1 ? '' : 's'} so accountability is clear: ${listTaskNames(unassignedOpenCards, 5)}.`,
      `Assign owners to ${unassignedOpenCards.length} open task${unassignedOpenCards.length === 1 ? '' : 's'} so accountability is clear: ${listTaskNamesPlain(unassignedOpenCards, 5)}.`);
  }
  if (unassignedOpenSubtasks.length > 0) {
    pushRec(72 + Math.min(unassignedOpenSubtasks.length, 10),
      `Assign owners to ${unassignedOpenSubtasks.length} open subtask${unassignedOpenSubtasks.length === 1 ? '' : 's'} to reduce hidden coordination risk: ${listSubtaskNames(unassignedOpenSubtasks, 6)}.`,
      `Assign owners to ${unassignedOpenSubtasks.length} open subtask${unassignedOpenSubtasks.length === 1 ? '' : 's'} to reduce hidden coordination risk: ${listSubtaskNamesPlain(unassignedOpenSubtasks, 6)}.`);
  }
  if (noDueDate.length > 0) {
    pushRec(68 + noDueDate.length,
      `Assign due dates to ${noDueDate.length} open task${noDueDate.length === 1 ? '' : 's'} to improve forecasting: ${listTaskNames(noDueDate, 5)}.`,
      `Assign due dates to ${noDueDate.length} open task${noDueDate.length === 1 ? '' : 's'} to improve forecasting: ${listTaskNamesPlain(noDueDate, 5)}.`);
  }
  if (recurring.length > 0) {
    pushRec(58 + recurring.length,
      `Batch-plan ${recurring.length} recurring task${recurring.length === 1 ? '' : 's'} for this week so they stop competing with urgent work: ${listTaskNames(recurring, 5)}.`,
      `Batch-plan ${recurring.length} recurring task${recurring.length === 1 ? '' : 's'} for this week so they stop competing with urgent work: ${listTaskNamesPlain(recurring, 5)}.`);
  }
  if (topWorkload[0] && topWorkload[0].tasks >= 5) {
    pushRec(74 + Math.round(topWorkload[0].tasks), `Redistribute workload from <strong class="text-gray-900 font-semibold">${_escHtml(topWorkload[0].owner)}</strong> to avoid a delivery bottleneck.`,
      `Redistribute workload from ${topWorkload[0].owner} to avoid a delivery bottleneck.`);
  }

  const recs = recommendationCandidates
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);

  const quickActionCandidates = [];
  const pushQuickAction = (score, prompt) => quickActionCandidates.push({ score, prompt });

  if (overdue.length) {
    pushQuickAction(100 + overdue.length, `Build a recovery plan for these overdue tasks and tell me what to do first today: ${listTaskNamesPlain(sortByDue(overdue), 4)}.`);
  }
  if (blocked.length) {
    pushQuickAction(95 + blocked.length, `Give me unblock actions for these blocked or at-risk tasks: ${listTaskNamesPlain(sortByDue(blocked), 4)}.`);
  }
  if (complexDueSoon.length) {
    pushQuickAction(90 + complexDueSoon.length, `Break these due-soon tasks into a safer execution order and explain the risk: ${listTaskNamesPlain(sortByDue(complexDueSoon), 4)}.`);
  }
  if (atRiskExecution.length) {
    pushQuickAction(86 + atRiskExecution.length, `Which of these tasks are most likely to slip based on their open subtasks, and what should I do next: ${listTaskNamesPlain(sortByDue(atRiskExecution), 4)}.`);
  }
  if (dueSoon.length) {
    pushQuickAction(82 + dueSoon.length, `Rank these due-soon tasks by urgency and explain why: ${listTaskNamesPlain(sortByDue(dueSoon), 5)}.`);
  }
  if (unassignedOpenCards.length) {
    pushQuickAction(78 + unassignedOpenCards.length, `Suggest owners or next actions for these unassigned tasks: ${listTaskNamesPlain(unassignedOpenCards, 5)}.`);
  }
  if (unassignedOpenSubtasks.length) {
    pushQuickAction(74 + Math.min(unassignedOpenSubtasks.length, 10), `Help me assign and sequence these open subtasks: ${listSubtaskNamesPlain(unassignedOpenSubtasks, 6)}.`);
  }
  if (noDueDate.length) {
    pushQuickAction(70 + noDueDate.length, `Recommend due dates and sequencing for these undated tasks: ${listTaskNamesPlain(noDueDate, 5)}.`);
  }
  if (recurring.length) {
    pushQuickAction(64 + recurring.length, `Plan this week's recurring work so it does not interfere with urgent tasks: ${listTaskNamesPlain(recurring, 5)}.`);
  }
  if (due14.length) {
    pushQuickAction(60 + due14.length, `Create a 14-day execution plan for these upcoming tasks: ${listTaskNamesPlain(sortByDue(due14), 6)}.`);
  }

  const quickPrompts = quickActionCandidates
    .sort((a, b) => b.score - a.score)
    .map((item) => item.prompt)
    .filter((prompt, index, arr) => arr.indexOf(prompt) === index)
    .slice(0, 4);

  if (!quickPrompts.length) {
    quickPrompts.push(
      'Analyze the current board and tell me the next best action to reduce delivery risk.',
      'Suggest the best 14-day execution plan for the current open tasks.',
      'Find hidden risks in the current project and explain what I should check next.',
      'Tell me which tasks should be prioritized first and why.'
    );
  }

  const healthTone = healthScore >= 80 ? 'text-emerald-600' : healthScore >= 60 ? 'text-amber-600' : 'text-rose-600';
  const healthBreakdown = {
    healthScore,
    total,
    done,
    open: openCards.length,
    overdue: overdue.length,
    blocked: blocked.length,
    noDueDate: noDueDate.length,
    completionRate,
    overdueRate,
    noDueRate,
    blockedRate,
  };

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
            <button id="health-score-btn" class="inline-flex flex-col items-end rounded-lg px-2 py-1 hover:bg-white/70 transition-colors" title="See how this score is calculated">
              <span class="text-3xl font-bold ${healthTone}">${healthScore}</span>
              <span class="text-[10px] text-gray-500">How it's calculated</span>
            </button>
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
            ${(recs.length ? recs : [{ html: 'No major risks detected. Keep momentum and close open due-soon tasks.', plain: '' }]).map((r, i) => `
              <div class="rounded-md border border-amber-200 bg-amber-50/70 px-3 py-2">
                <div class="flex items-start justify-between gap-3">
                  <p class="text-sm text-gray-700"><span class="text-amber-700 mr-1">${i + 1}.</span>${r.html}</p>
                  ${r.plain ? `<button class="ai-dash-ask-btn flex-shrink-0 px-2 py-1 text-[11px] font-medium text-amber-800 bg-amber-100 hover:bg-amber-200 border border-amber-300 rounded-md transition-colors" data-prompt="Explain this recommendation and give me exact next actions: ${_escHtml(r.plain)}">
                    Ask AI
                  </button>` : ''}
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

  root.querySelector('#health-score-btn')?.addEventListener('click', () => {
    _openHealthScoreModal(healthBreakdown);
  });
}

function _openHealthScoreModal(stats) {
  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  const completionImpact = Math.round((stats.completionRate * 0.45) * 100) / 100;
  const overdueImpact = Math.round((stats.overdueRate * 0.45) * 100) / 100;
  const noDueImpact = Math.round((stats.noDueRate * 0.25) * 100) / 100;
  const blockedImpact = Math.round((stats.blockedRate * 0.2) * 100) / 100;

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[88vh] overflow-y-auto p-6">
        <div class="flex items-start justify-between gap-4 mb-4">
          <div>
            <h3 class="text-lg font-semibold text-gray-800">Health Score Breakdown</h3>
            <p class="text-sm text-gray-500 mt-1">This score is calculated from the current open project state, not a static value.</p>
          </div>
          <button id="health-score-close" class="text-gray-400 hover:text-gray-700">Close</button>
        </div>

        <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
          ${[
            ['Health Score', stats.healthScore],
            ['Open Tasks', stats.open],
            ['Completed Tasks', stats.done],
            ['Total Tasks', stats.total],
          ].map(([label, value]) => `<div class="rounded-lg border border-gray-200 bg-gray-50 p-3"><p class="text-[11px] text-gray-500">${label}</p><p class="text-xl font-semibold text-gray-800">${value}</p></div>`).join('')}
        </div>

        <div class="rounded-lg border border-gray-200 bg-gray-50/70 p-4 mb-5">
          <p class="text-sm font-medium text-gray-800 mb-2">Formula used</p>
          <p class="text-sm text-gray-600">Health Score = clamp(0, 100, 55 + completion contribution - overdue penalty - no-date penalty - blocked penalty)</p>
          <div class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <div class="rounded-md bg-white border border-gray-200 px-3 py-2">
              <p class="font-medium text-gray-800">Completion contribution</p>
              <p class="text-gray-600 mt-1">${stats.completionRate}% complete × 0.45 = +${completionImpact}</p>
            </div>
            <div class="rounded-md bg-white border border-gray-200 px-3 py-2">
              <p class="font-medium text-gray-800">Overdue penalty</p>
              <p class="text-gray-600 mt-1">${stats.overdueRate}% overdue × 0.45 = -${overdueImpact}</p>
            </div>
            <div class="rounded-md bg-white border border-gray-200 px-3 py-2">
              <p class="font-medium text-gray-800">Missing due date penalty</p>
              <p class="text-gray-600 mt-1">${stats.noDueRate}% undated × 0.25 = -${noDueImpact}</p>
            </div>
            <div class="rounded-md bg-white border border-gray-200 px-3 py-2">
              <p class="font-medium text-gray-800">Blocked penalty</p>
              <p class="text-gray-600 mt-1">${stats.blockedRate}% blocked × 0.20 = -${blockedImpact}</p>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
          <div class="rounded-lg border border-gray-200 p-4">
            <p class="text-sm font-medium text-gray-800 mb-2">Current project inputs</p>
            <ul class="space-y-1 text-sm text-gray-600">
              <li>Open tasks: ${stats.open}</li>
              <li>Completed tasks: ${stats.done}</li>
              <li>Overdue tasks: ${stats.overdue}</li>
              <li>Blocked tasks: ${stats.blocked}</li>
              <li>Open tasks without due date: ${stats.noDueDate}</li>
            </ul>
          </div>
          <div class="rounded-lg border border-gray-200 p-4">
            <p class="text-sm font-medium text-gray-800 mb-2">What improves the score fastest</p>
            <ul class="space-y-1 text-sm text-gray-600">
              <li>Complete overdue work or re-baseline it realistically.</li>
              <li>Add due dates to undated open tasks.</li>
              <li>Unblock tasks stuck in blocked, hold, or waiting states.</li>
              <li>Close high-progress tasks to increase completion rate.</li>
            </ul>
          </div>
        </div>

        <div class="flex justify-end">
          <button id="health-score-ok" class="px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition-colors">Close</button>
        </div>
      </div>
    </div>`;

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('health-score-close')?.addEventListener('click', close);
  document.getElementById('health-score-ok')?.addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
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
  expandAiChat();
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

function _openAiHelpModal(examples, heading, steps = [], hint = '') {
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
        ${hint ? `<p class="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">${hint}</p>` : ''}
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

// ─── Fullscreen focus mode ────────────────────────────────────────────────────
let _isFullscreen = false;
document.getElementById('fullscreen-focus-btn')?.addEventListener('click', () => {
  _isFullscreen = !_isFullscreen;
  const boardView = document.getElementById('board-view');
  const header = document.getElementById('board-header');
  const searchBar = document.getElementById('board-search-bar');
  const aiSidebar = document.getElementById('ai-chat-sidebar');

  if (_isFullscreen) {
    // hide header and search bar
    if (header) header.style.display = 'none';
    if (searchBar) searchBar.style.display = 'none';
    if (aiSidebar) aiSidebar.style.display = 'none';
    // inject close button
    let closeBtn = document.getElementById('fullscreen-exit-btn');
    if (!closeBtn) {
      closeBtn = document.createElement('button');
      closeBtn.id = 'fullscreen-exit-btn';
      closeBtn.title = 'Exit fullscreen';
      closeBtn.className = 'fixed top-4 right-4 z-[9999] flex items-center justify-center w-9 h-9 rounded-full bg-red-600 hover:bg-red-700 text-white shadow-lg transition-colors';
      closeBtn.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>';
      closeBtn.addEventListener('click', () => {
        document.getElementById('fullscreen-focus-btn')?.click();
      });
      boardView?.appendChild(closeBtn);
    }
    closeBtn.style.display = 'flex';
  } else {
    // restore header and search bar
    if (header) header.style.display = '';
    if (searchBar) searchBar.style.display = '';
    if (aiSidebar) aiSidebar.style.display = '';
    _syncAiChatSidebar(_activeViewName);
    const closeBtn = document.getElementById('fullscreen-exit-btn');
    if (closeBtn) closeBtn.style.display = 'none';
  }
});

// ─── Board zoom ───────────────────────────────────────────────────────────────
const ZOOM_STEPS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0];
let _zoomIdx = ZOOM_STEPS.indexOf(1.0);

function _applyBoardZoom(idx) {
  _zoomIdx = Math.max(0, Math.min(ZOOM_STEPS.length - 1, idx));
  const scale = ZOOM_STEPS[_zoomIdx];
  const wrapper = document.getElementById('columns-wrapper');
  if (wrapper) {
    // Use CSS zoom instead of transform:scale — zoom changes actual layout
    // geometry so no whitespace gaps appear.
    wrapper.style.zoom = scale === 1 ? '' : String(scale);
    wrapper.style.transform = '';
    wrapper.style.transformOrigin = '';
    wrapper.style.width = '';
    wrapper.style.height = '';
  }
  const label = document.getElementById('board-zoom-label');
  if (label) label.textContent = `${Math.round(scale * 100)}%`;
  document.getElementById('board-zoom-out-btn')?.toggleAttribute('disabled', _zoomIdx === 0);
  document.getElementById('board-zoom-in-btn')?.toggleAttribute('disabled', _zoomIdx === ZOOM_STEPS.length - 1);
}

document.getElementById('board-zoom-out-btn')?.addEventListener('click', () => _applyBoardZoom(_zoomIdx - 1));
document.getElementById('board-zoom-in-btn')?.addEventListener('click', () => _applyBoardZoom(_zoomIdx + 1));

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
  const boardMembers = getBoardAssignedMembers();
  const membersById = new Map(boardMembers.map((m) => [m.uid, m]));

  const timelineBubbleColor = (uid) => {
    const COLORS = ['#6366f1','#8b5cf6','#ec4899','#ef4444','#f97316','#d97706','#22c55e','#14b8a6','#3b82f6'];
    const text = String(uid || 'x');
    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return COLORS[hash % COLORS.length];
  };

  const timelineAssigneesHtml = (card) => {
    const assignees = Array.isArray(card.assignees) ? card.assignees : [];
    if (!assignees.length || membersById.size === 0) return '';

    const profiles = assignees.map((uid) => membersById.get(uid)).filter(Boolean);
    if (!profiles.length) return '';

    const maxVisible = 3;
    const visible = profiles.slice(0, maxVisible);
    const overflow = profiles.length - visible.length;

    const bubbles = visible.map((p) => {
      const hoverName = p.displayName || `@${p.username || p.uid}`;
      const altText = p.displayName ? `${p.displayName} (@${p.username || ''})` : `@${p.username || p.uid}`;
      if (p.photoURL) {
        return `<img src="${_escHtml(p.photoURL)}" alt="${_escHtml(altText)}" title="${_escHtml(hoverName)}" class="w-5 h-5 rounded-full object-cover border border-white/80 shadow-sm flex-shrink-0" />`;
      }
      const initials = (p.displayName || p.username || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
      return `<span title="${_escHtml(hoverName)}" class="inline-flex items-center justify-center w-5 h-5 rounded-full text-[9px] font-bold text-white border border-white/80 shadow-sm flex-shrink-0" style="background:${timelineBubbleColor(p.uid)}">${_escHtml(initials)}</span>`;
    }).join('');

    const overflowChip = overflow > 0
      ? `<span class="inline-flex items-center justify-center h-5 min-w-5 px-1.5 rounded-full text-[9px] font-semibold text-white bg-black/45 border border-white/70">+${overflow}</span>`
      : '';

    return `<div class="flex items-center gap-1">${bubbles}${overflowChip}</div>`;
  };
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
      assignees: Array.isArray(c.assignees) ? c.assignees : [],
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

  // Build month boundaries for grid lines, header labels, and weekly dotted lines
  const monthBoundaries = [];
  const monthLabels = [];
  const weekLines = [];
  const weekLabels = [];
  {
    const cursor = new Date(minStart.getFullYear(), minStart.getMonth(), 1);

    // First label for the starting month
    const firstMidDay = Math.round(((new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate()) / 2));
    const firstMid = new Date(cursor.getFullYear(), cursor.getMonth(), firstMidDay);
    if (firstMid >= minStart && firstMid <= maxEnd) {
      const midPct = ((firstMid - minStart) / MS_DAY / rangeDays) * 100;
      monthLabels.push({ label: cursor.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }), pct: midPct });
    }

    // Collect all week starts (1st, 8th, 15th, 22nd) for first month
    {
      const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      const weekStarts = [1, 8, 15, 22];
      for (let wi = 0; wi < weekStarts.length; wi++) {
        const weekDay = new Date(monthStart.getFullYear(), monthStart.getMonth(), weekStarts[wi]);
        if (weekDay >= minStart && weekDay <= maxEnd && weekDay.getMonth() === monthStart.getMonth()) {
          const wPct = ((weekDay - minStart) / MS_DAY / rangeDays) * 100;
          // Week line (skip the 1st since it's a month boundary)
          if (weekStarts[wi] > 1 && wPct > 0.5 && wPct < 99.5) weekLines.push(wPct);
          // Week label centered between this week start and the next boundary
          const nextBound = wi < weekStarts.length - 1
            ? new Date(monthStart.getFullYear(), monthStart.getMonth(), weekStarts[wi + 1])
            : new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
          const endBound = nextBound <= maxEnd ? nextBound : maxEnd;
          const midPct = (((weekDay.getTime() + endBound.getTime()) / 2 - minStart.getTime()) / MS_DAY / rangeDays) * 100;
          if (midPct >= 0 && midPct <= 100) {
            weekLabels.push({ label: weekDay.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), pct: midPct });
          }
        }
      }
    }

    cursor.setMonth(cursor.getMonth() + 1);
    while (cursor <= maxEnd) {
      const dayOffset = (cursor - minStart) / MS_DAY;
      const pct = (dayOffset / rangeDays) * 100;
      if (pct > 0 && pct < 100) {
        monthBoundaries.push(pct);
      }
      // Label at mid-month
      const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
      const midDay = Math.round(daysInMonth / 2);
      const midDate = new Date(cursor.getFullYear(), cursor.getMonth(), midDay);
      if (midDate <= maxEnd) {
        const midPct = ((midDate - minStart) / MS_DAY / rangeDays) * 100;
        monthLabels.push({ label: cursor.toLocaleDateString(undefined, { month: 'short', year: '2-digit' }), pct: midPct });
      }
      // Weekly lines and labels within this month
      const weekStarts = [1, 8, 15, 22];
      for (let wi = 0; wi < weekStarts.length; wi++) {
        const weekDay = new Date(cursor.getFullYear(), cursor.getMonth(), weekStarts[wi]);
        if (weekDay <= maxEnd && weekDay.getMonth() === cursor.getMonth()) {
          const wPct = ((weekDay - minStart) / MS_DAY / rangeDays) * 100;
          if (weekStarts[wi] > 1 && wPct > 0.5 && wPct < 99.5) weekLines.push(wPct);
          const nextBound = wi < weekStarts.length - 1
            ? new Date(cursor.getFullYear(), cursor.getMonth(), weekStarts[wi + 1])
            : new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
          const endBound = nextBound <= maxEnd ? nextBound : maxEnd;
          const midPct = (((weekDay.getTime() + endBound.getTime()) / 2 - minStart.getTime()) / MS_DAY / rangeDays) * 100;
          if (midPct >= 0 && midPct <= 100) {
            weekLabels.push({ label: weekDay.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), pct: midPct });
          }
        }
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }
  }

  const monthLinesHtml = monthBoundaries.map((pct) =>
    `<div class="absolute top-0 bottom-0" style="left:${pct}%;width:1.5px;background:rgba(107,114,128,0.45)"></div>`
  ).join('');

  const weekLinesHtml = weekLines.map((pct) =>
    `<div class="absolute top-0 bottom-0" style="left:${pct}%;width:0;border-left:1px dashed rgba(156,163,175,0.45)"></div>`
  ).join('');

  // Lighter week tick marks for the dark header
  const weekLinesHeaderHtml = weekLines.map((pct) =>
    `<div class="absolute top-0 bottom-0" style="left:${pct}%;width:0;border-left:1px solid rgba(148,163,184,0.3)"></div>`
  ).join('');

  const monthLabelsHtml = monthLabels.map((m) =>
    `<span class="absolute text-[10px] font-semibold text-gray-500 whitespace-nowrap" style="left:${m.pct}%;transform:translateX(-50%)">${_escHtml(m.label)}</span>`
  ).join('');

  const weekLabelsHtml = weekLabels.map((w) =>
    `<span class="absolute text-[9px] text-gray-300 whitespace-nowrap" style="left:${w.pct}%;transform:translateX(-50%)">${_escHtml(w.label)}</span>`
  ).join('');

  // Alternating month background bands — light / slightly darker
  const monthBands = [];
  {
    const allEdges = [0, ...monthBoundaries, 100];
    for (let i = 0; i < allEdges.length - 1; i++) {
      const bg = i % 2 === 0 ? 'rgba(249,250,251,0.8)' : 'rgba(229,231,235,0.35)';
      monthBands.push(`<div class="absolute top-0 bottom-0" style="left:${allEdges[i]}%;width:${allEdges[i + 1] - allEdges[i]}%;background:${bg}"></div>`);
    }
  }
  const monthBandsHtml = monthBands.join('');

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
        <div class="relative h-7 rounded overflow-hidden" style="background:transparent">
          ${monthBandsHtml}${weekLinesHtml}${monthLinesHtml}
          <div class="absolute inset-y-1 rounded bg-gradient-to-r ${barClass}" style="left:${leftPct}%;width:${widthPct}%">
            <div class="h-full bg-black/10" style="width:${Math.max(6, r.progress)}%"></div>
            <div class="absolute right-1 top-1/2 -translate-y-1/2">
              ${timelineAssigneesHtml(r)}
            </div>
          </div>
        </div>
      </div>`;
  }).join('');

  body.innerHTML = `
    <div class="rounded-xl border border-gray-200 bg-white overflow-hidden">
      <div class="px-4 py-2.5 border-b border-gray-200 bg-gray-800 flex items-end gap-3">
        <span class="text-sm font-semibold text-white whitespace-nowrap" style="width:220px">Project Timeline/Gantt</span>
        <div class="relative h-5 flex-1 overflow-hidden">
          ${weekLinesHeaderHtml}
          ${weekLabelsHtml}
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
  menu.className = 'account-dropdown fixed z-50 bg-white rounded-xl shadow-lg border border-gray-100 py-1 text-sm w-56';
  menu.style.top  = `${rect.bottom + 6}px`;
  menu.style.right = `${window.innerWidth - rect.right}px`;

  const adminButtonHtml = _isGlobalAdminClient() ? `
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
    <button data-action="resetpw"
      class="w-full text-left px-4 py-2 hover:bg-gray-50 transition-colors flex items-center gap-2 text-gray-700">
      <svg class="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586
             a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"/>
      </svg>
      Reset password
    </button>
    <button data-action="theme-toggle"
      class="w-full text-left px-4 py-2 hover:bg-gray-50 transition-colors flex items-center justify-between text-gray-700">
      <span class="flex items-center gap-2">
        <svg class="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 1012 21a9 9 0 008.354-5.646z"/>
        </svg>
        Dark mode
      </span>
      <span class="text-xs font-medium ${_isDarkMode() ? 'text-emerald-600' : 'text-gray-400'}">${_isDarkMode() ? 'ON' : 'OFF'}</span>
    </button>
    <button data-action="help"
      class="w-full text-left px-4 py-2 hover:bg-gray-50 transition-colors flex items-center gap-2 text-gray-700">
      <svg class="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M8.228 9c.549-1.165 1.72-2 3.022-2 1.657 0 3 1.343 3 3 0 1.255-.771 2.33-1.864 2.78-.572.235-1.136.53-1.136 1.22V15m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
      </svg>
      Help
    </button>
    <button data-action="support"
      class="w-full text-left px-4 py-2 hover:bg-blue-50 transition-colors flex items-center gap-2 text-blue-700">
      <svg class="w-3.5 h-3.5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M18.364 5.636A9 9 0 115.636 18.364 9 9 0 0118.364 5.636zM12 8v4m0 4h.01"/>
      </svg>
      Support
    </button>
    <button data-action="privacy"
      class="w-full text-left px-4 py-2 hover:bg-gray-50 transition-colors flex items-center gap-2 text-gray-700">
      <svg class="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
          d="M12 3l7 4v5c0 5-3.5 8-7 9-3.5-1-7-4-7-9V7l7-4z"/>
      </svg>
      Privacy Policy
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
  `;

  document.body.appendChild(menu);

  const close = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('click', close, true);
    }
  };
  setTimeout(() => document.addEventListener('click', close, true), 0);

  if (_isGlobalAdminClient()) {
    menu.querySelector('[data-action="admin-panel"]')?.addEventListener('click', () => {
      menu.remove();
      _openAdminPanel(_activeViewName);
    });
  }

  menu.querySelector('[data-action="account-settings"]').addEventListener('click', () => {
    menu.remove();
    _openAccountSettingsModal();
  });

  menu.querySelector('[data-action="organizations"]').addEventListener('click', () => {
    menu.remove();
    _openOrganizationsPage();
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

  menu.querySelector('[data-action="theme-toggle"]').addEventListener('click', () => {
    _toggleTheme();
    menu.remove();
  });

  menu.querySelector('[data-action="help"]').addEventListener('click', () => {
    menu.remove();
    _openHelpPage();
  });

  menu.querySelector('[data-action="support"]').addEventListener('click', () => {
    menu.remove();
    _openSupportPage();
  });

  menu.querySelector('[data-action="privacy"]').addEventListener('click', () => {
    menu.remove();
    _openPrivacyPage();
  });
}

function _openHelpPage() {
  _infoPageReturnView = _activeViewName;
  location.hash = 'help';
  _showView('help');
}

function _openSupportPage() {
  _infoPageReturnView = _activeViewName;
  location.hash = 'support';
  _showView('support');
  const btn = document.getElementById('support-ticket-open-btn');
  if (btn) btn.onclick = () => {
    _openSupportTicketModal();
  };
}

function _openPrivacyPage() {
  _infoPageReturnView = _activeViewName;
  location.hash = 'privacy';
  _showView('privacy');
}

async function _openBoardActivityModal() {
  if (!_currentBoardId) return;

  const modalRoot = document.getElementById('modal-root');
  if (!modalRoot) return;

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-2xl p-6 max-h-[85vh] overflow-y-auto">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-semibold text-gray-900">Board Activity Log</h3>
          <button id="activity-log-close" class="text-gray-400 hover:text-gray-700">✕</button>
        </div>
        <p class="text-xs text-gray-500 mb-3">Recent completion activity for this board.</p>
        <div id="activity-log-content" class="rounded-lg border border-gray-200 p-3 text-sm text-gray-500">Loading activity…</div>
      </div>
    </div>
  `;

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('activity-log-close')?.addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  const content = document.getElementById('activity-log-content');

  try {
    const local = _readLocalCompletionLogs(_currentBoardId).map((row) => ({
      id: row.id || '',
      userId: row.userId || '',
      cardTitle: row.cardTitle || 'Untitled task',
      type: row.type || 'task',
      subtaskTitle: row.subtaskTitle || '',
      whenMs: new Date(row.completedAtIso || 0).getTime(),
    }));

    const { collection, getDocs, query, where, limit } = await import('firebase/firestore');
    const remoteSnap = await getDocs(query(
      collection(db, 'completionLog'),
      where('boardId', '==', _currentBoardId),
      limit(150),
    ));

    const remote = remoteSnap.docs.map((d) => {
      const data = d.data() || {};
      const when = data.completedAt?.toDate?.() || data.updatedAt?.toDate?.() || null;
      return {
        id: d.id,
        userId: data.userId || '',
        cardTitle: data.cardTitle || 'Untitled task',
        type: data.type || 'task',
        subtaskTitle: data.subtaskTitle || '',
        whenMs: when ? when.getTime() : 0,
      };
    });

    const dedupe = new Map();
    [...remote, ...local].forEach((item) => {
      const key = `${item.id}:${item.userId}:${item.type}:${item.cardTitle}:${item.whenMs}`;
      if (!dedupe.has(key)) dedupe.set(key, item);
    });

    const rows = [...dedupe.values()]
      .sort((a, b) => b.whenMs - a.whenMs)
      .slice(0, 120);

    if (!rows.length) {
      content.innerHTML = '<p class="text-sm text-gray-500">No activity yet for this board.</p>';
      return;
    }

    // Resolve user labels for activity rows (board members first, then profile lookup fallback)
    const memberByUid = new Map((getBoardAssignedMembers() || []).map((m) => [m.uid, m]));
    const uniqueUserIds = [...new Set(rows.map((r) => String(r.userId || '').trim()).filter(Boolean))];
    const userLabelByUid = new Map();

    await Promise.all(uniqueUserIds.map(async (uid) => {
      const boardMember = memberByUid.get(uid);
      if (boardMember) {
        userLabelByUid.set(uid, boardMember.displayName || (boardMember.username ? `@${boardMember.username}` : uid));
        return;
      }
      if (_user?.uid === uid) {
        userLabelByUid.set(uid, _userProfile?.displayName || _user?.displayName || _user?.email || 'You');
        return;
      }
      try {
        const profile = await getUserProfile(uid);
        if (profile) {
          userLabelByUid.set(uid, profile.displayName || (profile.username ? `@${profile.username}` : profile.email || uid));
          return;
        }
      } catch (_) {
        // non-blocking fallback below
      }
      userLabelByUid.set(uid, uid);
    }));

    const rowHtml = rows.map((row) => {
      const whenLabel = row.whenMs ? new Date(row.whenMs).toLocaleString() : 'Unknown time';
      const action = row.type === 'subtask'
        ? `Completed subtask "${_escHtml(row.subtaskTitle || 'Untitled subtask')}"`
        : 'Completed task';
      const actorLabel = row.userId ? (userLabelByUid.get(row.userId) || row.userId) : 'Unknown user';
      return `
        <li class="py-2 border-b border-gray-100 last:border-b-0">
          <p class="text-sm text-gray-700"><span class="font-medium">${action}</span> in <span class="font-medium">${_escHtml(row.cardTitle)}</span></p>
          <p class="text-xs text-gray-500 mt-0.5">by <span class="font-medium text-gray-600">${_escHtml(actorLabel)}</span> • ${_escHtml(whenLabel)}</p>
        </li>`;
    }).join('');

    content.innerHTML = `<ul class="divide-y divide-gray-100">${rowHtml}</ul>`;
  } catch (err) {
    content.innerHTML = `<p class="text-sm text-red-600">Could not load activity log: ${_escHtml(err?.message || String(err))}</p>`;
  }
}

async function _submitSupportTicket({ category, subject, message }) {
  const { collection, addDoc, serverTimestamp } = await import('firebase/firestore');
  const { db: firebaseDb } = await import('./firebase.js');
  await addDoc(collection(firebaseDb, 'supportTickets'), {
    uid:         _user.uid,
    email:       _user.email || '',
    displayName: _userProfile?.displayName || _user.displayName || '',
    category,
    subject,
    message,
    status:      'open',
    createdAt:   serverTimestamp(),
  });
}

// ─── Support Ticket modal ─────────────────────────────────────────────────────

function _openSupportTicketModal() {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <div class="flex items-center gap-3 mb-5">
          <span class="text-2xl">🎫</span>
          <h3 class="text-lg font-semibold text-gray-900">Open Support Ticket</h3>
        </div>
        <form id="support-ticket-form" class="flex flex-col gap-3">
          <div>
            <label class="block text-xs font-medium text-gray-700 mb-1">Category</label>
            <select id="support-ticket-category"
              class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500">
              <option value="bug">Bug / Something broken</option>
              <option value="billing">Billing / Account</option>
              <option value="feature">Feature request</option>
              <option value="question">General question</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-700 mb-1">Subject</label>
            <input id="support-ticket-subject" type="text" maxlength="120" required
              placeholder="Brief summary of your issue"
              class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500" />
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-700 mb-1">Message</label>
            <textarea id="support-ticket-message" rows="5" maxlength="2000" required
              placeholder="Describe the issue in detail…"
              class="w-full rounded-lg border-gray-300 text-sm resize-none focus:ring-brand-500 focus:border-brand-500"></textarea>
          </div>
          <p id="support-ticket-error" class="hidden text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2"></p>
          <div class="flex justify-end gap-2 mt-1">
            <button type="button" id="support-ticket-cancel"
              class="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">
              Cancel
            </button>
            <button type="submit" id="support-ticket-submit"
              class="gold-btn px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors">
              Submit Ticket
            </button>
          </div>
        </form>
      </div>
    </div>
  `;

  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('support-ticket-cancel').addEventListener('click', close);
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });

  document.getElementById('support-ticket-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('support-ticket-submit');
    const errorEl  = document.getElementById('support-ticket-error');
    const category = document.getElementById('support-ticket-category').value;
    const subject  = document.getElementById('support-ticket-subject').value.trim();
    const message  = document.getElementById('support-ticket-message').value.trim();

    if (!subject || !message) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';
    errorEl.classList.add('hidden');

    try {
      await _submitSupportTicket({ category, subject, message });
      close();
      _showSimpleModal('✅ Your support ticket has been submitted. We will get back to you soon.');
    } catch (err) {
      console.error('Support ticket submission failed:', err);
      errorEl.textContent = 'Could not submit ticket: ' + (err.message || err);
      errorEl.classList.remove('hidden');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Ticket';
    }
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
  const billingContext = await getUserBillingContext(_user.uid);
  const plan = billingContext.personalPlan;

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
          <li>${p.canUseOrg ? 'Allows organization creation and ownership' : 'No organization creation'}</li>
          <li>${p.canUseOrg ? `Up to ${p.orgSeatLimit} users per organization` : 'No organization seats'}</li>
          <li>${p.canUseOrg ? 'Includes org admin member management' : 'No org admin controls'}</li>
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
        <div class="mb-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-xs text-sky-900">
          <p class="font-semibold mb-1">Organization access model</p>
          <p>
            Invited organization members inherit workspace benefits from the org owner's plan
            ${billingContext.inheritedPlan ? `(currently inheriting ${billingContext.inheritedPlan.label})` : ''},
            but they cannot create or own a separate organization unless their own personal plan allows it.
          </p>
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
  const profileDisplayName = _userProfile?.displayName || _user.displayName || _user.email || 'User';
  const profileInitials = _getUserInitials(profileDisplayName);
  const currentPhotoURL = _userProfile?.photoURL || _user.photoURL || '';

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
            <label class="block text-xs text-gray-500 mb-2">Profile picture</label>
            <div class="flex items-center gap-3">
              <div class="relative w-16 h-16">
                <img id="acct-photo-preview" src="${_escHtml(currentPhotoURL)}" alt="${_escHtml(profileDisplayName)}"
                  class="w-16 h-16 rounded-full object-cover border border-gray-200 ${currentPhotoURL ? '' : 'hidden'}" />
                <div id="acct-photo-fallback"
                  class="w-16 h-16 rounded-full bg-gray-200 text-gray-700 text-sm font-semibold border border-gray-200 flex items-center justify-center ${currentPhotoURL ? 'hidden' : ''}">
                  ${_escHtml(profileInitials)}
                </div>
              </div>
              <div class="flex-1">
                <input id="acct-photo-input" type="file" accept="image/*"
                  class="block w-full text-xs text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-gray-100 file:text-gray-700 hover:file:bg-gray-200" />
                <p class="mt-1 text-[11px] text-gray-500">PNG, JPG, or WEBP up to 3MB. Upload starts automatically when selected.</p>
                <div class="mt-2 flex items-center gap-2">
                  <button id="acct-photo-remove" class="px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg">Remove</button>
                </div>
                <p id="acct-photo-status" class="hidden mt-2 text-xs"></p>
              </div>
            </div>
          </div>
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

        <div class="space-y-3 pt-4">
          <h4 class="text-sm font-semibold text-red-700">Danger zone</h4>
          <div class="rounded-lg border border-red-200 bg-red-50/60 p-4 flex items-center justify-between gap-4">
            <div>
              <p class="text-sm font-medium text-red-900">Delete account</p>
              <p class="text-xs text-red-700 mt-1">Permanently remove your account, decks, cards, and profile data.</p>
            </div>
            <button id="acct-delete-account-btn" class="px-3 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors">
              Delete account
            </button>
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
    if (firebaseAuth.currentUser) {
      try { await updateProfile(firebaseAuth.currentUser, { displayName: value }); } catch (_) { /* non-blocking */ }
    }
    _userProfile = { ..._userProfile, displayName: value };
    _updateUserUI({ ..._user, displayName: value, photoURL: _userProfile?.photoURL || _user.photoURL || '' });
    _showSimpleModal('Display name updated.');
  });

  const photoInput = document.getElementById('acct-photo-input');
  const photoRemoveBtn = document.getElementById('acct-photo-remove');
  const photoPreview = document.getElementById('acct-photo-preview');
  const photoFallback = document.getElementById('acct-photo-fallback');
  const photoStatus = document.getElementById('acct-photo-status');

  const setPhotoStatus = (text, tone = 'ok') => {
    if (!photoStatus) return;
    photoStatus.textContent = text;
    photoStatus.classList.remove('hidden', 'text-green-700', 'text-red-600', 'text-gray-600');
    photoStatus.classList.add(tone === 'error' ? 'text-red-600' : (tone === 'info' ? 'text-gray-600' : 'text-green-700'));
  };

  const applyPhotoState = (url) => {
    const hasPhoto = Boolean(url);
    if (photoPreview) {
      photoPreview.src = hasPhoto ? url : '';
      photoPreview.classList.toggle('hidden', !hasPhoto);
    }
    if (photoFallback) photoFallback.classList.toggle('hidden', hasPhoto);
  };

  const _uploadSelectedPhoto = async () => {
    const file = photoInput?.files?.[0];
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image/')) {
      setPhotoStatus('Please choose a valid image file.', 'error');
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      setPhotoStatus('Image must be 3MB or smaller.', 'error');
      return;
    }

    if (photoInput) photoInput.disabled = true;
    if (photoRemoveBtn) photoRemoveBtn.disabled = true;
    setPhotoStatus('Uploading photo...', 'info');
    try {
      const ext = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `profile-photos/${_user.uid}/${Date.now()}.${ext || 'jpg'}`;
      const fileRef = storageRef(storage, path);
      await uploadBytes(fileRef, file, { contentType: file.type });
      const url = await getDownloadURL(fileRef);

      // Check if user is still logged in (token may have been invalidated e.g. after password reset)
      if (!_user) {
        setPhotoStatus('Session expired. Please sign in again.', 'error');
        return;
      }

      await updateUserPhotoURL(_user.uid, url);
      if (firebaseAuth.currentUser) {
        try { await updateProfile(firebaseAuth.currentUser, { photoURL: url }); } catch (_) { /* non-blocking */ }
      }

      _userProfile = { ..._userProfile, photoURL: url };
      _updateUserUI({ ..._user, displayName: _userProfile?.displayName || _user.displayName, photoURL: url });
      applyPhotoState(url);
      setPhotoStatus('Profile photo updated.', 'ok');
      if (photoInput) photoInput.value = '';
    } catch (err) {
      console.error('Profile photo upload failed:', err);
      setPhotoStatus(err?.message || 'Could not upload photo.', 'error');
    } finally {
      if (photoInput) photoInput.disabled = false;
      if (photoRemoveBtn) photoRemoveBtn.disabled = false;
    }
  };

  photoInput?.addEventListener('change', _uploadSelectedPhoto);

  photoRemoveBtn?.addEventListener('click', async () => {
    photoRemoveBtn.disabled = true;
    setPhotoStatus('Removing photo...', 'info');
    try {
      await updateUserPhotoURL(_user.uid, '');
      if (firebaseAuth.currentUser) {
        try { await updateProfile(firebaseAuth.currentUser, { photoURL: '' }); } catch (_) { /* non-blocking */ }
      }
      _userProfile = { ..._userProfile, photoURL: '' };
      _updateUserUI({ ..._user, displayName: _userProfile?.displayName || _user.displayName, photoURL: '' });
      applyPhotoState('');
      setPhotoStatus('Profile photo removed.', 'ok');
      if (photoInput) photoInput.value = '';
    } catch (err) {
      console.error('Profile photo remove failed:', err);
      setPhotoStatus(err?.message || 'Could not remove photo.', 'error');
    } finally {
      photoRemoveBtn.disabled = false;
    }
  });

  document.getElementById('acct-delete-account-btn')?.addEventListener('click', () => {
    modalRoot.innerHTML = '';
    _openDeleteAccountModal();
  });
}

async function _openOrganizationsPage() {
  location.hash = 'organizations';
  _showView('organizations');
  const root = document.getElementById('organizations-root');
  if (!root) return;

  root.innerHTML = `
    <div class="rounded-xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-500">
      Loading organization...
    </div>`;

  _userProfile = await getUserProfile(_user.uid);
  const org = _userProfile?.organizationId ? await getOrgById(_userProfile.organizationId) : null;
  const isOwner = Boolean(org && org.ownerId === _user.uid);
  const isOrgAdmin = Boolean(org && (isOwner || (Array.isArray(org.admins) && org.admins.includes(_user.uid))));
  const orgOwnerProfile = org?.ownerId ? await getUserProfile(org.ownerId) : null;
  const orgPlan = getPlanConfig(orgOwnerProfile?.billingPlan || 'free');

  // Admins see all members; regular members only see owner + admins
  let members = [];
  try {
    members = org ? await getOrgMembers(org.id) : [];
  } catch (err) {
    console.warn('Could not load org members:', err);
  }

  // For non-admins, filter to only show owner and admins
  const visibleMembers = isOrgAdmin
    ? members
    : members.filter((m) => m.uid === org?.ownerId || (Array.isArray(org?.admins) && org.admins.includes(m.uid)));

  const memberRows = visibleMembers.map((m) => {
    const label = m.displayName ? `${m.displayName} (@${m.username || ''})` : `@${m.username || m.uid}`;
    const rowIsOwner = org && m.uid === org.ownerId;
    const rowIsAdmin = rowIsOwner || (Array.isArray(org?.admins) && org.admins.includes(m.uid));
    const roleMap = org?.memberRoles && typeof org.memberRoles === 'object' ? org.memberRoles : {};
    const persistedRole = String(roleMap[m.uid] || '').toLowerCase();
    const effectiveRole = rowIsOwner
      ? 'owner'
      : rowIsAdmin
        ? 'admin'
        : (persistedRole === 'read-only' || persistedRole === 'collaborator' ? persistedRole : 'collaborator');
    const roleControl = rowIsOwner
      ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Owner</span>'
      : isOrgAdmin
        ? `<label class="text-[10px] text-gray-500 inline-flex items-center gap-1">
            <span>Role</span>
            <select class="org-role-select rounded border-gray-300 text-[11px] py-0.5 pl-1.5 pr-5 text-gray-700 focus:ring-brand-500 focus:border-brand-500" data-uid="${m.uid}">
              <option value="admin" ${effectiveRole === 'admin' ? 'selected' : ''}>Org Admin</option>
              <option value="collaborator" ${effectiveRole === 'collaborator' ? 'selected' : ''}>Collaborator</option>
              <option value="read-only" ${effectiveRole === 'read-only' ? 'selected' : ''}>Read-only</option>
            </select>
          </label>`
        : effectiveRole === 'admin'
          ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-sky-100 text-sky-800">Org Admin</span>'
          : effectiveRole === 'read-only'
            ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-violet-100 text-violet-700">Read-only</span>'
            : '<span class="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">Collaborator</span>';

    const removeBtn = (isOrgAdmin && !rowIsOwner && m.uid !== _user.uid)
      ? `<button type="button" class="org-remove-btn text-xs text-red-600 hover:text-red-700" data-uid="${m.uid}">Remove</button>`
      : '';

    return `
      <div class="org-member-row flex items-center justify-between py-2 border-b border-gray-100 last:border-0 gap-3" data-search="${_escHtml((label || '').toLowerCase())}">
        <div class="min-w-0">
          <p class="text-sm text-gray-800 truncate">${_escHtml(label)}</p>
        </div>
        <div class="flex items-center gap-2 flex-shrink-0">
          ${roleControl}
          ${removeBtn}
        </div>
      </div>`;
  }).join('');

  root.innerHTML = org ? `
    <div class="grid grid-cols-1 xl:grid-cols-3 gap-5">
      <section class="xl:col-span-2 rounded-xl border border-gray-200 bg-white p-5">
        <div class="flex items-center justify-between mb-3">
          <div>
            <h2 class="text-xl font-semibold text-gray-800">${_escHtml(org.name || 'Organization')}</h2>
            <p class="text-xs text-gray-500">${isOwner ? 'You are the owner' : (isOrgAdmin ? 'You are an org admin' : 'You are a member')}</p>
            <p class="text-xs text-brand-700 mt-0.5">Plan: ${_escHtml(orgPlan.label)} (${_escHtml(orgPlan.key)})</p>
          </div>
          <div class="text-xs text-gray-500">${isOrgAdmin ? `Members: ${members.length}` : ''}</div>
        </div>
        <h3 class="text-xs font-medium text-gray-500 mb-1">${isOrgAdmin ? 'All Members' : 'Organization Managers'}</h3>
        ${isOrgAdmin ? `
        <div class="mb-2">
          <input id="org-members-search" type="text" placeholder="Search members by name or username"
            class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500" />
        </div>
        ` : ''}
        <div class="rounded-lg border border-gray-200 px-3">
          ${memberRows || '<p class="text-sm text-gray-500 py-2">No members yet.</p>'}
        </div>
      </section>

      ${isOrgAdmin ? `
      <section class="rounded-xl border border-gray-200 bg-white p-5">
        <h3 class="text-sm font-semibold text-gray-800 mb-2">Manage Members</h3>
        <div class="space-y-4">
          <div>
            <p class="text-xs font-semibold text-gray-600 mb-1">Add Existing Account User</p>
            <form id="org-invite-form" class="space-y-2">
              <input id="org-invite-username" type="text" maxlength="20" placeholder="username"
                class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500" />
              <button type="submit" class="w-full px-3 py-2 text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg">Add existing user</button>
            </form>
            <p class="mt-1 text-xs text-gray-500">Use username only (without @).</p>
          </div>

          <div class="border-t border-gray-100 pt-3">
            <p class="text-xs font-semibold text-gray-600 mb-1">Add New User (Email Invite)</p>
            <form id="org-email-invite-form" class="space-y-2">
              <input id="org-invite-email" type="email" maxlength="160" placeholder="user@example.com"
                class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500" />
              <select id="org-invite-role" class="w-full rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500">
                <option value="collaborator">Collaborator</option>
                <option value="read-only">Read-only</option>
                <option value="admin">Org Admin</option>
              </select>
              <button type="submit" class="w-full px-3 py-2 text-sm font-medium text-white bg-gray-900 hover:bg-gray-800 rounded-lg">Send invite email</button>
            </form>
            <p class="mt-1 text-xs text-gray-500">Opens your email app with a prefilled invite message and join link.</p>
          </div>
        </div>
        <p id="org-settings-error" class="hidden mt-2 text-xs text-red-600"></p>
        <p id="org-settings-success" class="hidden mt-2 text-xs text-emerald-700"></p>
      </section>
      ` : ''}
    </div>
  ` : `
    <div class="max-w-xl mx-auto rounded-xl border border-gray-200 bg-white p-6">
      <h2 class="text-xl font-semibold text-gray-800 mb-1">Create your organization</h2>
      <p class="text-sm text-gray-500 mb-4">Organizations are available on Mid, Pro, and Business plans.</p>
      <form id="org-create-form" class="flex gap-2">
        <input id="org-name-input" type="text" maxlength="80" placeholder="Organization name"
          class="flex-1 rounded-lg border-gray-300 text-sm focus:ring-brand-500 focus:border-brand-500" />
        <button type="submit" class="px-3 py-2 text-sm font-medium text-white bg-brand-500 hover:bg-brand-600 rounded-lg">Create</button>
      </form>
      <p id="org-settings-error" class="hidden mt-2 text-xs text-red-600"></p>
    </div>
  `;

  const errorEl = document.getElementById('org-settings-error');
  const successEl = document.getElementById('org-settings-success');

  document.getElementById('org-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('org-name-input')?.value?.trim() || '';
    if (!name) return;
    try {
      const gate = await canCreateOrganization(_user.uid);
      if (!gate.allowed) throw new Error(gate.reason || 'Organization creation is not allowed for this account.');
      await createOrg(_user.uid, name);
      await _openOrganizationsPage();
    } catch (err) {
      errorEl.textContent = err.message || 'Could not create organization.';
      errorEl.classList.remove('hidden');
    }
  });

  document.getElementById('org-invite-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (successEl) successEl.classList.add('hidden');
    const username = document.getElementById('org-invite-username')?.value?.trim().toLowerCase() || '';
    const validation = validateUsername(username);
    if (validation) {
      errorEl.textContent = validation;
      errorEl.classList.remove('hidden');
      return;
    }
    try {
      await addMemberByUsername(org.id, username, org.id);
      await _openOrganizationsPage();
    } catch (err) {
      errorEl.textContent = err.message || 'Could not add member.';
      errorEl.classList.remove('hidden');
    }
  });

  document.getElementById('org-email-invite-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (errorEl) errorEl.classList.add('hidden');
    if (successEl) successEl.classList.add('hidden');

    const email = (document.getElementById('org-invite-email')?.value || '').trim().toLowerCase();
    const role = (document.getElementById('org-invite-role')?.value || 'collaborator').trim().toLowerCase();
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!validEmail) {
      errorEl.textContent = 'Enter a valid email address.';
      errorEl.classList.remove('hidden');
      return;
    }

    try {
      const baseUrl = `${window.location.origin}${window.location.pathname}`;
      const inviteUrl = `${baseUrl}?orgInvite=1&orgId=${encodeURIComponent(org.id)}&role=${encodeURIComponent(role)}`;
      const roleLabel = role === 'read-only' ? 'Read-only' : (role === 'admin' ? 'Org Admin' : 'Collaborator');
      const subject = `Invitation to join ${org.name} on PMDeck`;
      const body = [
        `Hi,`,
        ``,
        `${_userProfile?.displayName || _user?.email || 'A PMDeck user'} invited you to join the organization "${org.name}" as ${roleLabel}.`,
        ``,
        `Join link: ${inviteUrl}`,
        ``,
        `If you do not have an account yet, sign up first, then open the link again.`,
      ].join('\n');

      window.location.href = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      if (successEl) {
        successEl.textContent = 'Email draft opened. Send it to deliver the invite link.';
        successEl.classList.remove('hidden');
      }
    } catch (err) {
      errorEl.textContent = err.message || 'Could not prepare invite email.';
      errorEl.classList.remove('hidden');
    }
  });

  document.querySelectorAll('.org-role-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      try {
        await setOrgMemberRole(org.id, sel.dataset.uid, sel.value);
        await _openOrganizationsPage();
      } catch (err) {
        errorEl.textContent = err.message || 'Could not update member role.';
        errorEl.classList.remove('hidden');
      }
    });
  });

  document.getElementById('org-members-search')?.addEventListener('input', (e) => {
    const term = String(e.target.value || '').trim().toLowerCase();
    document.querySelectorAll('.org-member-row').forEach((row) => {
      const hay = row.dataset.search || '';
      row.classList.toggle('hidden', Boolean(term) && !hay.includes(term));
    });
  });

  document.querySelectorAll('.org-remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await removeMember(org.id, btn.dataset.uid);
        await _openOrganizationsPage();
      } catch (err) {
        errorEl.textContent = err.message || 'Could not remove member.';
        errorEl.classList.remove('hidden');
      }
    });
  });
}

// ─── Admin panel: dependency list ─────────────────────────────────────────────

/** All packages from package.json and functions/package.json, baked in at build time. */
const _DEPS = {
  frontend: {
    dependencies: {
      'firebase': '^10.12.0',
    },
    devDependencies: {
      '@tailwindcss/forms': '^0.5.7',
      'autoprefixer': '^10.4.19',
      'postcss': '^8.4.38',
      'tailwindcss': '^3.4.4',
      'vite': '^5.3.1',
    },
  },
  functions: {
    dependencies: {
      '@google/genai': '^1.49.0',
      '@google/generative-ai': '^0.15.0',
      'firebase-admin': '^12.2.0',
      'firebase-functions': '^5.0.1',
      'stripe': '^18.5.0',
    },
    devDependencies: {
      'firebase-functions-test': '^3.2.0',
    },
  },
};

function _buildDepsSection() {
  const renderGroup = (label, pkgs, isDev = false) => {
    const rows = Object.entries(pkgs).map(([name, ver]) => {
      const clean = ver.replace(/^[\^~>=<]+/, '');
      const hasRange = /^[\^~>=<]/.test(ver);
      const badge = isDev
        ? '<span class="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 font-medium">dev</span>'
        : '<span class="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-medium">prod</span>';
      const rangeBadge = hasRange
        ? `<span class="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium" title="Range prefix ${ver.replace(clean, '').trim()} allows minor/patch updates">${ver.replace(clean, '').trim()} range</span>`
        : '';
      return `
        <tr class="border-b border-gray-100 hover:bg-gray-50">
          <td class="px-3 py-2 text-sm font-medium text-gray-800">${_escHtml(name)}</td>
          <td class="px-3 py-2 text-sm font-mono text-gray-700">${_escHtml(clean)}</td>
          <td class="px-3 py-2 text-xs">${_escHtml(ver)}</td>
          <td class="px-3 py-2"><div class="flex items-center gap-1">${badge}${rangeBadge}</div></td>
        </tr>`;
    }).join('');
    return `
      <tr class="bg-gray-50">
        <td colspan="4" class="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">${label}</td>
      </tr>
      ${rows}`;
  };

  const frontendRows = renderGroup('Frontend — dependencies', _DEPS.frontend.dependencies, false)
    + renderGroup('Frontend — devDependencies', _DEPS.frontend.devDependencies, true);

  const functionsRows = renderGroup('Functions — dependencies', _DEPS.functions.dependencies, false)
    + renderGroup('Functions — devDependencies', _DEPS.functions.devDependencies, true);

  const totalPkgs = Object.values(_DEPS).reduce(
    (acc, g) => acc + Object.keys(g.dependencies || {}).length + Object.keys(g.devDependencies || {}).length, 0,
  );

  return `
    <div class="mb-8">
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-lg font-semibold text-gray-800">Dependencies <span class="text-sm font-normal text-gray-500">(${totalPkgs} packages — run <code class="bg-gray-100 px-1 rounded text-xs">npm outdated</code> to check for updates)</span></h3>
      </div>
      <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white mb-4">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="px-3 py-2.5 text-left font-semibold text-gray-700">Package</th>
              <th class="px-3 py-2.5 text-left font-semibold text-gray-700">Version</th>
              <th class="px-3 py-2.5 text-left font-semibold text-gray-700">Range spec</th>
              <th class="px-3 py-2.5 text-left font-semibold text-gray-700">Type</th>
            </tr>
          </thead>
          <tbody>
            ${frontendRows}
            ${functionsRows}
          </tbody>
        </table>
      </div>
      <p class="text-xs text-gray-400">Versions are read from <code class="bg-gray-100 px-1 rounded">package.json</code> at build time. To update, run <code class="bg-gray-100 px-1 rounded">npm update</code> in the root and <code class="bg-gray-100 px-1 rounded">functions/</code> folders, then redeploy.</p>
    </div>
  `;
}

// ─── Admin panel ──────────────────────────────────────────────────────────────

async function _openAdminPanel(returnViewName = _activeViewName) {
  _adminPanelReturnView = returnViewName === 'admin-panel' ? 'boards' : (returnViewName || 'boards');
  _showView('admin-panel');

  const root = document.getElementById('admin-panel-root');
  if (!root) return;

  root.innerHTML = `
    <div class="rounded-xl border border-gray-200 bg-white p-8 text-sm text-gray-500">Loading admin data…</div>
  `;

  try {
    const allUsers = await getAllUsers();
    const allOrgs = await getAllOrganizations();
    const { getDocs, collection } = await import('firebase/firestore');
    const { db } = await import('./firebase.js');

    const boardsSnap = await getDocs(collection(db, 'boards'));
    const cardsSnap = await getDocs(collection(db, 'cards'));
    const ticketsSnap = await getDocs(collection(db, 'supportTickets'));

    const PAID_PLANS = ['mid', 'pro', 'business-small', 'business-growth'];
    const allTickets = ticketsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const stats = {
      totalUsers: allUsers.length,
      freeUsers: allUsers.filter((u) => !PAID_PLANS.includes(u.billingPlan)).length,
      paidUsers: allUsers.filter((u) => PAID_PLANS.includes(u.billingPlan)).length,
      totalOrgs: allOrgs.length,
      totalBoards: boardsSnap.size,
      totalCards: cardsSnap.size,
      openTickets: allTickets.filter((t) => t.status === 'open').length,
    };

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
            <button class="admin-toggle-user-btn text-xs px-2 py-1 rounded border transition-colors" data-uid="${user.uid}" data-is-admin="${isUserAdmin ? '1' : '0'}" data-name="${_escHtml(user.displayName || user.username || user.email || user.uid)}"
              style="color: ${isUserAdmin ? '#dc2626' : '#059669'}; border-color: ${isUserAdmin ? '#dc2626' : '#059669'};">
              ${isUserAdmin ? 'Remove Admin' : 'Make Admin'}
            </button>
          </td>
        </tr>
      `;
    }).join('');

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

    root.innerHTML = `
      <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-4">
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
      </div>
      <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <div class="rounded-lg border border-gray-200 bg-gradient-to-br from-amber-50 to-amber-100 p-4">
          <p class="text-xs text-amber-700 font-semibold">Cards</p>
          <p class="mt-2 text-2xl font-bold text-amber-900">${stats.totalCards}</p>
        </div>
        <div class="rounded-lg border border-gray-200 bg-gradient-to-br from-slate-50 to-slate-100 p-4">
          <p class="text-xs text-slate-600 font-semibold">Free Plan Users</p>
          <p class="mt-2 text-2xl font-bold text-slate-800">${stats.freeUsers}</p>
        </div>
        <div class="rounded-lg border border-emerald-200 bg-gradient-to-br from-emerald-50 to-emerald-100 p-4">
          <p class="text-xs text-emerald-700 font-semibold">Paid Plan Users</p>
          <p class="mt-2 text-2xl font-bold text-emerald-900">${stats.paidUsers}</p>
        </div>
        <div class="rounded-lg border border-blue-200 bg-gradient-to-br from-blue-50 to-blue-100 p-4">
          <p class="text-xs text-blue-700 font-semibold">Open Tickets</p>
          <p class="mt-2 text-2xl font-bold text-blue-900">${stats.openTickets}</p>
        </div>
      </div>

      <div class="mb-8">
        <h3 class="text-lg font-semibold text-gray-800 mb-3">Users (${stats.totalUsers})</h3>
        <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white">
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

      <div class="mb-8">
        <div class="flex items-center justify-between mb-3">
          <h3 class="text-lg font-semibold text-gray-800">Support Tickets (${allTickets.length})</h3>
        </div>
        <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table class="w-full text-sm">
            <thead class="bg-gray-50 border-b border-gray-200">
              <tr>
                <th class="px-4 py-3 text-left font-semibold text-gray-700">User</th>
                <th class="px-4 py-3 text-left font-semibold text-gray-700">Category</th>
                <th class="px-4 py-3 text-left font-semibold text-gray-700">Subject</th>
                <th class="px-4 py-3 text-left font-semibold text-gray-700">Status</th>
                <th class="px-4 py-3 text-left font-semibold text-gray-700">Date</th>
                <th class="px-4 py-3 text-left font-semibold text-gray-700">Action</th>
              </tr>
            </thead>
            <tbody>
              ${allTickets.length === 0 ? '<tr><td colspan="6" class="px-4 py-6 text-center text-gray-400 text-sm">No support tickets yet.</td></tr>' : allTickets.sort((a, b) => {
                const at = a.createdAt?.toMillis?.() ?? 0;
                const bt = b.createdAt?.toMillis?.() ?? 0;
                return bt - at;
              }).map((ticket) => {
                const statusColor = ticket.status === 'open'
                  ? 'bg-blue-100 text-blue-800'
                  : ticket.status === 'resolved'
                  ? 'bg-green-100 text-green-800'
                  : 'bg-gray-100 text-gray-700';
                const dateStr = ticket.createdAt?.toDate ? ticket.createdAt.toDate().toLocaleDateString() : '—';
                return `
                  <tr class="border-b border-gray-200 hover:bg-gray-50">
                    <td class="px-4 py-3 text-sm">
                      <span class="font-medium">${_escHtml(ticket.displayName || ticket.email || ticket.uid)}</span>
                      <span class="block text-xs text-gray-400">${_escHtml(ticket.email || '')}</span>
                    </td>
                    <td class="px-4 py-3 text-sm capitalize">${_escHtml(ticket.category || '—')}</td>
                    <td class="px-4 py-3 text-sm max-w-xs">
                      <button class="admin-ticket-view-btn text-left text-blue-600 hover:underline truncate block max-w-[200px]"
                        data-ticket-id="${ticket.id}"
                        data-subject="${_escHtml(ticket.subject)}"
                        data-message="${_escHtml(ticket.message)}"
                        data-name="${_escHtml(ticket.displayName || ticket.email || '')}"
                        title="${_escHtml(ticket.subject)}">${_escHtml(ticket.subject)}</button>
                    </td>
                    <td class="px-4 py-3 text-sm">
                      <span class="px-2 py-1 rounded-full text-xs font-medium ${statusColor}">${_escHtml(ticket.status || 'open')}</span>
                    </td>
                    <td class="px-4 py-3 text-sm text-gray-500">${dateStr}</td>
                    <td class="px-4 py-3 text-sm">
                      <select class="admin-ticket-status-select text-xs rounded border border-gray-300 px-1 py-0.5" data-ticket-id="${ticket.id}" data-current="${_escHtml(ticket.status || 'open')}">
                        <option value="open" ${ticket.status === 'open' ? 'selected' : ''}>Open</option>
                        <option value="in-progress" ${ticket.status === 'in-progress' ? 'selected' : ''}>In Progress</option>
                        <option value="resolved" ${ticket.status === 'resolved' ? 'selected' : ''}>Resolved</option>
                        <option value="closed" ${ticket.status === 'closed' ? 'selected' : ''}>Closed</option>
                      </select>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="mb-8">
        <h3 class="text-lg font-semibold text-gray-800 mb-3">Organizations (${stats.totalOrgs})</h3>
        <div class="overflow-x-auto rounded-lg border border-gray-200 bg-white">
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

      ${_buildDepsSection()}
    `;

    // ── Admin toggle listeners ──────────────────────────────────────────────
    root.querySelectorAll('.admin-toggle-user-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const uid      = btn.dataset.uid;
        const isAdmin  = btn.dataset.isAdmin === '1';
        const userName = btn.dataset.name || uid;

        if (!isAdmin) {
          const modalRoot = document.getElementById('modal-root');
          modalRoot.innerHTML = `
            <div class="modal-backdrop fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
              <div class="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
                <div class="flex items-center gap-3 mb-4">
                  <span class="text-2xl">⚠️</span>
                  <h3 class="text-lg font-semibold text-gray-900">Grant Admin Access</h3>
                </div>
                <p class="text-sm text-gray-700 mb-2">
                  Are you sure you want to make <strong>${_escHtml(userName)}</strong> an entire application administrator?
                </p>
                <p class="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-5">
                  Admin users have full read and write access to all data, users, organizations, and settings across the entire application.
                </p>
                <div class="flex justify-end gap-2">
                  <button id="admin-confirm-cancel" class="px-4 py-2 text-sm font-medium text-gray-600 hover:text-gray-800 rounded-lg hover:bg-gray-100 transition-colors">Cancel</button>
                  <button id="admin-confirm-ok" class="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors">Yes, Make Admin</button>
                </div>
              </div>
            </div>
          `;
          const close = () => { modalRoot.innerHTML = ''; };
          document.getElementById('admin-confirm-cancel').addEventListener('click', close);
          modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
            if (e.target === e.currentTarget) close();
          });
          document.getElementById('admin-confirm-ok').addEventListener('click', async () => {
            close();
            try {
              await setUserAdminStatus(uid, true);
              await _openAdminPanel(_adminPanelReturnView);
            } catch (err) {
              console.error('Failed to grant admin status:', err);
              alert('Failed to update admin status: ' + (err.message || err));
            }
          });
        } else {
          setUserAdminStatus(uid, false)
            .then(() => _openAdminPanel(_adminPanelReturnView))
            .catch((err) => {
              console.error('Failed to remove admin status:', err);
              alert('Failed to update admin status: ' + (err.message || err));
            });
        }
      });
    });

    // ── Support ticket: view message ───────────────────────────────────────
    root.querySelectorAll('.admin-ticket-view-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const modalRoot = document.getElementById('modal-root');
        modalRoot.innerHTML = `
          <div class="modal-backdrop fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div class="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6">
              <div class="flex items-center gap-2 mb-4">
                <span class="text-xl">🎫</span>
                <h3 class="text-base font-semibold text-gray-900 truncate">${btn.dataset.subject}</h3>
              </div>
              <p class="text-xs text-gray-500 mb-2">From: <strong>${btn.dataset.name}</strong></p>
              <div class="bg-gray-50 rounded-lg border border-gray-200 p-4 text-sm text-gray-700 whitespace-pre-wrap max-h-72 overflow-y-auto">${btn.dataset.message}</div>
              <div class="flex justify-end mt-4">
                <button id="ticket-view-close" class="px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-800 transition-colors">Close</button>
              </div>
            </div>
          </div>
        `;
        const close = () => { modalRoot.innerHTML = ''; };
        document.getElementById('ticket-view-close').addEventListener('click', close);
        modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
          if (e.target === e.currentTarget) close();
        });
      });
    });

    // ── Support ticket: update status ──────────────────────────────────────
    root.querySelectorAll('.admin-ticket-status-select').forEach((sel) => {
      sel.addEventListener('change', async () => {
        const ticketId = sel.dataset.ticketId;
        const newStatus = sel.value;
        try {
          const { doc, updateDoc } = await import('firebase/firestore');
          const { db } = await import('./firebase.js');
          await updateDoc(doc(db, 'supportTickets', ticketId), { status: newStatus });
          await _openAdminPanel(_adminPanelReturnView);
        } catch (err) {
          console.error('Failed to update ticket status:', err);
          alert('Could not update ticket status: ' + (err.message || err));
        }
      });
    });

  } catch (err) {
    console.error('Failed to load admin panel:', err);
    root.innerHTML = `
      <div class="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
        Could not load admin panel data: ${_escHtml(err?.message || String(err))}
      </div>
    `;
  }
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
  organizations: document.getElementById('organizations-view'),
  board:   document.getElementById('board-view'),
  'admin-panel': document.getElementById('admin-panel-view'),
  'ai-dashboard': document.getElementById('ai-dashboard-view'),
  help: document.getElementById('help-view'),
  support: document.getElementById('support-view'),
  privacy: document.getElementById('privacy-view'),
};

// Hide all views immediately — auth state callback will reveal the correct one.
// This prevents any view flashing before Firebase resolves auth.
Object.values(_views).forEach((el) => { if (el) el.style.display = 'none'; });

const _viewDisplayMap = {
  landing: 'flex',
  boards:  'flex',
  organizations: 'flex',
  board:   'flex',
  'admin-panel': 'flex',
  'ai-dashboard': 'flex',
  help: 'flex',
  support: 'flex',
  privacy: 'flex',
};

function _showView(name) {
  _activeViewName = name;
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

  _syncAiChatSidebar(name);
  requestAnimationFrame(() => _syncAiChatSidebar(name));
}

function _getActiveHeaderHeight(name) {
  const activeView = _views[name];
  const header = activeView?.querySelector('header');
  const measuredHeight = Math.ceil(header?.getBoundingClientRect().height || 0);
  return Math.max(measuredHeight, 56);
}

function _syncAiChatSidebar(name) {
  const sidebar = document.getElementById('ai-chat-sidebar');
  if (!sidebar) return;

  const shouldShow = ['boards', 'board', 'organizations', 'admin-panel', 'ai-dashboard'].includes(name);
  sidebar.style.display = shouldShow ? 'flex' : 'none';
  sidebar.classList.toggle('ai-chat-docked', shouldShow);

  if (!shouldShow) {
    document.documentElement.style.setProperty('--ai-chat-inset', '0px');
    document.body.classList.remove('ai-chat-open');
    return;
  }

  const topOffset = _getActiveHeaderHeight(name);
  sidebar.style.setProperty('--ai-chat-top', `${topOffset}px`);
  sidebar.style.top = `${topOffset}px`;

  window.dispatchEvent(new CustomEvent('pmdek:ai-chat-layout-sync'));
  requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('pmdek:ai-chat-layout-sync')));
}

window.addEventListener('resize', () => {
  const activeName = Object.entries(_views).find(([, el]) => el && el.style.display !== 'none')?.[0] || _activeViewName;
  _syncAiChatSidebar(activeName);
});

// ─── User UI ──────────────────────────────────────────────────────────────────

function _getUserInitials(nameOrEmail) {
  const safe = String(nameOrEmail || 'User').trim();
  if (!safe) return 'U';
  const parts = safe.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase() || 'U';
  }
  return safe.slice(0, 2).toUpperCase();
}

function _updateUserUI(user) {
  const display = user.displayName || user.email || 'User';
  const initials = _getUserInitials(display);

  // Class selectors so both boards-view and board-view stay in sync.
  document.querySelectorAll('.user-avatar').forEach((el) => {
    const wrap = el.parentElement;
    let fallback = wrap?.querySelector('.user-avatar-fallback');
    if (!fallback && wrap) {
      fallback = document.createElement('span');
      fallback.className = 'user-avatar-fallback inline-flex items-center justify-center w-7 h-7 rounded-full bg-gray-200 text-gray-700 text-[10px] font-semibold select-none';
      fallback.setAttribute('aria-hidden', 'true');
      wrap.insertBefore(fallback, el.nextSibling);
    }

    const hasPhoto = Boolean(user.photoURL);
    el.src = hasPhoto ? user.photoURL : '';
    el.alt = display;
    el.classList.toggle('hidden', !hasPhoto);
    if (fallback) {
      fallback.textContent = initials;
      fallback.classList.toggle('hidden', hasPhoto);
      fallback.setAttribute('title', display);
    }
  });
  document.querySelectorAll('.user-display-name').forEach((el) => {
    el.textContent = display;
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

