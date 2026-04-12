/**
 * @module ai-chat
 * Persistent AI chat sidebar — slides in from the right edge of the screen.
 *
 * Context-aware:
 *  - 'boards' mode  →  generates a full PM Deck with columns + tasks
 *  - 'board'  mode  →  generates a single card in the current board's first column
 *
 * Chat history is persisted in localStorage (up to MAX_HISTORY messages).
 */

import { generateBoardWithTasks, generateCard } from './ai.js';
import { createBoard, setBoardId, PROJECT_TYPES, getDefaultColumnsForProjectType } from './board.js';
import { createCard, setCurrentUser, updateCard, getCardsSnapshot } from './cards.js';
import { getAiUsageSummary, consumeAiCredit } from './billing.js';

const HISTORY_KEY = 'aiChatHistory';
const MAX_HISTORY = 100;

let _user           = null;
let _mode           = 'boards'; // 'boards' | 'board' | 'dashboard'
let _onBoardCreated = null;     // callback(boardId, boardObj)
let _submitting     = false;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Call once after sign-in to wire up the sidebar DOM events.
 *
 * @param {import('firebase/auth').User} user
 * @param {{ onBoardCreated?: (boardId: string, board: object) => void }} opts
 */
export function initAiChat(user, { onBoardCreated } = {}) {
  _user           = user;
  _onBoardCreated = onBoardCreated;

  document.getElementById('ai-chat-close-btn')
    ?.addEventListener('click', closeAiChat);

  document.getElementById('ai-chat-expand-btn')
    ?.addEventListener('click', () => {
      const sidebar = document.getElementById('ai-chat-sidebar');
      if (!sidebar) return;
      if (sidebar.classList.contains('ai-chat-collapsed')) {
        expandAiChat();
      } else {
        collapseAiChat();
      }
    });

  const form = document.getElementById('ai-chat-form');
  if (form) {
    form.addEventListener('submit', _handleSend);
    // Shift+Enter inserts a newline; plain Enter submits
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.defaultPrevented) {
        e.preventDefault();
        form.requestSubmit();
      }
    });
  }

  _renderHistory();
  _refreshUsageBadge();
}

/**
 * Switch the sidebar context.
 * 'boards' → creates full decks; 'board' → creates cards on the current board.
 *
 * @param {'boards'|'board'} mode
 */
export function setAiChatMode(mode) {
  _mode = mode;
  const input = document.getElementById('ai-chat-input');
  if (!input) return;
  if (mode === 'boards') {
    input.placeholder = 'Describe a project to create a full deck…';
  } else if (mode === 'dashboard') {
    input.placeholder = 'Ask about risks, priorities, capacity, or delivery forecast…';
  } else {
    input.placeholder = 'Describe a task to add to the board…';
  }
  _refreshUsageBadge();
}

/**
 * Toggle the sidebar open / closed.
 */
export function toggleAiChat() {
  const sidebar = document.getElementById('ai-chat-sidebar');
  if (!sidebar) return;
  if (sidebar.dataset.open === '1') {
    closeAiChat();
  } else {
    openAiChat();
  }
}

export function openAiChat() {
  const sidebar = document.getElementById('ai-chat-sidebar');
  if (!sidebar) return;
  sidebar.dataset.open = '1';
  sidebar.classList.remove('translate-x-full');
  _setButtonsActive(true);
  // Focus input after animation settles
  setTimeout(() => document.getElementById('ai-chat-input')?.focus(), 310);
  _syncChatHeader();
}

export function setAiChatExpanded(expanded) {
  const sidebar = document.getElementById('ai-chat-sidebar');
  if (!sidebar) return;
  sidebar.classList.toggle('ai-chat-expanded', Boolean(expanded));
  if (expanded) sidebar.classList.remove('ai-chat-collapsed');
  _syncChatHeader();
}

export function collapseAiChat() {
  const sidebar = document.getElementById('ai-chat-sidebar');
  if (!sidebar) return;
  openAiChat();
  sidebar.classList.remove('ai-chat-expanded');
  sidebar.classList.add('ai-chat-collapsed');
  _syncChatHeader();
}

export function expandAiChat() {
  const sidebar = document.getElementById('ai-chat-sidebar');
  if (!sidebar) return;
  openAiChat();
  sidebar.classList.remove('ai-chat-collapsed');
  _syncChatHeader();
}

export function openAiChatWithPrompt(prompt, { expand = false } = {}) {
  openAiChat();
  setAiChatExpanded(expand);
  const input = document.getElementById('ai-chat-input');
  if (!input) return;
  input.value = String(prompt || '');
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

export function closeAiChat() {
  const sidebar = document.getElementById('ai-chat-sidebar');
  if (!sidebar) return;
  delete sidebar.dataset.open;
  sidebar.classList.add('translate-x-full');
  sidebar.classList.remove('ai-chat-expanded');
  sidebar.classList.remove('ai-chat-collapsed');
  _setButtonsActive(false);
  _syncChatHeader();
}

function _syncChatHeader() {
  const sidebar = document.getElementById('ai-chat-sidebar');
  const btn = document.getElementById('ai-chat-expand-btn');
  const title = document.getElementById('ai-chat-title');
  if (!sidebar || !btn || !title) return;
  const collapsed = sidebar.classList.contains('ai-chat-collapsed');
  btn.title = collapsed ? 'Expand AI chat' : 'Collapse AI chat';
  btn.setAttribute('aria-label', collapsed ? 'Expand AI chat' : 'Collapse AI chat');
  btn.innerHTML = collapsed
    ? '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>'
    : '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>';
  title.textContent = collapsed ? 'AI' : 'AI Assistant';
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function _setButtonsActive(active) {
  ['ai-board-btn', 'ai-trigger-btn'].forEach((id) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    if (active) {
      btn.classList.add('ring-2', 'ring-amber-400');
      btn.classList.replace('bg-amber-100', 'bg-amber-200');
    } else {
      btn.classList.remove('ring-2', 'ring-amber-400');
      btn.classList.replace('bg-amber-200', 'bg-amber-100');
    }
  });
}

// ─── History persistence ──────────────────────────────────────────────────────

function _loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function _saveHistory(messages) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-MAX_HISTORY)));
}

function _addToHistory(role, text) {
  const history = _loadHistory();
  const msg = { id: String(Date.now()), role, text, ts: Date.now() };
  history.push(msg);
  _saveHistory(history);
  _renderMessage(msg, /* animate */ true);
}

// ─── DOM rendering ────────────────────────────────────────────────────────────

function _renderHistory() {
  const container = document.getElementById('ai-chat-messages');
  if (!container) return;
  container.innerHTML = '';

  const history = _loadHistory();
  if (history.length === 0) {
    _showEmpty(container);
    return;
  }
  history.forEach((msg) => _renderMessage(msg, false));
  _scrollToBottom();
}

function _showEmpty(container) {
  container.innerHTML = `
    <div id="ai-chat-empty" class="flex flex-col items-center justify-center h-full text-center px-6 py-8">
      <span class="text-5xl mb-3 select-none">✨</span>
      <p class="text-sm font-semibold text-gray-600 mb-1">AI Assistant</p>
      <p class="text-xs text-gray-400 leading-relaxed">
        Ask me to create a PM Deck for your project, or add tasks to the current board.
      </p>
      <p class="mt-2 text-[11px] text-gray-500 leading-relaxed">
        Tip: use "to Done" / "to In Progress" for column targeting, or "add sub task X to task Y" for exact sub-task placement.
      </p>
    </div>`;
}

function _renderMessage(msg, animate) {
  const container = document.getElementById('ai-chat-messages');
  if (!container) return;

  // Clear empty state the first time a real message appears
  document.getElementById('ai-chat-empty')?.remove();

  const isUser = msg.role === 'user';

  const wrap = document.createElement('div');
  wrap.className = `flex ${isUser ? 'justify-end' : 'justify-start'}`;
  if (animate) wrap.classList.add('ai-msg-in');

  const bubble = document.createElement('div');
  bubble.className = isUser
    ? 'max-w-[82%] rounded-2xl rounded-tr-sm px-3.5 py-2 text-sm bg-amber-100 text-amber-900 border border-amber-200 leading-relaxed'
    : 'max-w-[88%] rounded-2xl rounded-tl-sm px-3.5 py-2 text-sm bg-white border border-gray-200 text-gray-700 shadow-sm leading-relaxed';

  bubble.textContent = msg.text;
  wrap.appendChild(bubble);
  container.appendChild(wrap);

  if (animate) _scrollToBottom();
}

function _showThinking() {
  const container = document.getElementById('ai-chat-messages');
  if (!container) return;

  document.getElementById('ai-chat-empty')?.remove();

  const el = document.createElement('div');
  el.id = 'ai-thinking';
  el.className = 'flex justify-start ai-msg-in';
  el.innerHTML = `
    <div class="flex items-center gap-1 px-4 py-2.5 rounded-2xl rounded-tl-sm
                bg-white border border-gray-200 shadow-sm">
      <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-bounce"
            style="animation-delay:0ms"></span>
      <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-bounce"
            style="animation-delay:120ms"></span>
      <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-bounce"
            style="animation-delay:240ms"></span>
    </div>`;
  container.appendChild(el);
  _scrollToBottom();
}

function _removeThinking() {
  document.getElementById('ai-thinking')?.remove();
}

function _scrollToBottom() {
  const c = document.getElementById('ai-chat-messages');
  if (c) c.scrollTop = c.scrollHeight;
}

// ─── Message handler ──────────────────────────────────────────────────────────

/** Words/phrases that should never trigger AI project generation. */
const TRIVIAL_PATTERNS = new Set([
  'hi', 'hello', 'hey', 'yo', 'sup', 'howdy', 'hiya', 'greetings',
  'ok', 'okay', 'k', 'sure', 'yes', 'no', 'nope', 'yep', 'yeah',
  'thanks', 'thank you', 'thx', 'ty', 'ty!', 'cheers',
  'great', 'cool', 'nice', 'good', 'awesome', 'wow', 'sweet',
  'lol', 'lmao', 'haha', 'hah', 'ha', ':)', ':D', '😊',
  'bye', 'goodbye', 'cya', 'see you', 'later',
  'test', 'testing', '...', 'hmm', 'hm', '?', 'help',
  'what', 'who', 'how', 'why', 'when', 'where',
]);

function _isTrivialMessage(text) {
  const cleaned = text.toLowerCase().trim().replace(/[!?.,'"]+$/g, '');
  if (cleaned.length < 6) return true;
  if (TRIVIAL_PATTERNS.has(cleaned)) return true;
  // Single common word with no project context
  if (/^(hello|hi|hey|thanks?|ok|okay|cool|great|nice|wow|bye|test)[\s!?.,]*$/i.test(text)) return true;
  return false;
}

async function _handleSend(e) {
  e.preventDefault();
  if (_submitting) return;

  const input   = document.getElementById('ai-chat-input');
  const sendBtn = document.getElementById('ai-chat-send-btn');
  const text    = input?.value.trim();
  if (!text) return;

  _submitting = true;
  input.value = '';
  if (sendBtn) sendBtn.disabled = true;

  _addToHistory('user', text);
  _showThinking();

  try {
    const usage = await getAiUsageSummary(_user.uid);
    if (usage.remaining <= 0) {
      _removeThinking();
      _addToHistory('assistant', `You've hit your daily AI limit (${usage.used}/${usage.limit}) on the ${usage.plan.label} plan. Upgrade in Billing or wait until tomorrow.`);
      return;
    }

    // Every submitted chat message consumes one credit.
    await consumeAiCredit(_user.uid);

    if (_isTrivialMessage(text)) {
      _removeThinking();
      _addToHistory('assistant', "Hi! I'm your AI project assistant. Try describing a project — for example: \"Build a mobile app for tracking workouts\" — and I'll create a full deck with tasks. This message counted toward your daily AI usage.");
      return;
    }

    if (_mode === 'boards') {
      await _doBoardsMode(text);
    } else if (_mode === 'dashboard') {
      await _doDashboardMode(text);
    } else {
      await _doBoardMode(text);
    }
  } catch (err) {
    console.error('[ai-chat] error:', err);
    _removeThinking();
    const msg = String(err?.message || '').toLowerCase();
    if (msg.includes('daily ai limit reached')) {
      const usage = await getAiUsageSummary(_user.uid).catch(() => null);
      if (usage) {
        _addToHistory('assistant', `You've hit your daily AI limit (${usage.used}/${usage.limit}) on the ${usage.plan.label} plan. Upgrade in Billing or wait until tomorrow.`);
      } else {
        _addToHistory('assistant', "You've hit your daily AI limit. Upgrade in Billing or wait until tomorrow.");
      }
    } else if (msg.includes('permission') || msg.includes('unauthenticated')) {
      _addToHistory('assistant', 'AI request failed due to permissions/session. Please sign in again and retry.');
    } else {
      _addToHistory('assistant', 'Sorry, something went wrong. Please try again.');
    }
  } finally {
    _submitting = false;
    if (sendBtn) sendBtn.disabled = false;
    input.focus();
    _refreshUsageBadge();
  }
}

async function _refreshUsageBadge() {
  const el = document.getElementById('ai-chat-usage');
  if (!el || !_user?.uid) return;
  try {
    const usage = await getAiUsageSummary(_user.uid);
    el.textContent = `${usage.used}/${usage.limit} AI used today`;
    el.title = 'Every sent AI chat message counts toward your daily limit.';
    el.className = usage.remaining > 0
      ? 'text-[11px] text-amber-800/80 mr-2'
      : 'text-[11px] text-red-700 mr-2 font-semibold';
  } catch (_) {
    el.textContent = '';
  }
}

// ─── Project type detection ───────────────────────────────────────────────────

/** Maps keywords found in user text → project type value. */
const PROJECT_TYPE_KEYWORDS = [
  { value: 'weekly',        patterns: [/\bweekly\b/i, /\bweek\s*plan/i, /\bday\s*by\s*day/i] },
  { value: 'scrum',         patterns: [/\bscrum\b/i, /\bsprint\b/i, /\bproduct\s*backlog\b/i] },
  { value: 'cybersecurity', patterns: [/\bcyber\s*security\b/i, /\bcybersec\b/i, /\bsecurity\s*ops\b/i, /\bthreat\b/i, /\bincident\s*response\b/i, /\bsoc\b/i, /\bvulnerabilit/i, /\bpentesting\b/i, /\bhacking\b/i] },
  { value: 'data-analyst',  patterns: [/\bdata\s*analyst\b/i, /\banalytics\b/i, /\binsight(s)?\b/i, /\bdashboard\b/i] },
  { value: 'data-engineering', patterns: [/\bdata\s*engineering\b/i, /\betl\b/i, /\bdata\s*pipeline\b/i, /\borchestration\b/i] },
  { value: 'agile-se',      patterns: [/\bagile\b/i, /\bkanban\b/i] },
  { value: 'waterfall-se',  patterns: [/\bwaterfall\b/i] },
  { value: 'sdlc',          patterns: [/\bsdlc\b/i, /\bsoftware\s*dev(?:elopment)?\s*lifecycle\b/i] },
  { value: 'recurring',     patterns: [/\brecurring\b/i, /\brepeat(?:ing)?\b/i] },
];

/**
 * Detects a project type value from a free-text prompt.
 * Returns null (= standard) if nothing matches.
 * @param {string} text
 * @returns {string|null}
 */
function _detectProjectTypeFromText(text) {
  const t = String(text || '');
  for (const entry of PROJECT_TYPE_KEYWORDS) {
    if (entry.patterns.some((re) => re.test(t))) return entry.value;
  }
  return null;
}

// ─── AI actions ───────────────────────────────────────────────────────────────

async function _doBoardsMode(text) {
  // Detect project type from prompt before calling AI
  const detectedType = _detectProjectTypeFromText(text);

  const { title, columns } = await generateBoardWithTasks(text, { metered: false });
  _removeThinking();

  // If a known project type was detected, use its predefined columns instead
  let boardColumns;
  if (detectedType && detectedType !== 'standard') {
    boardColumns = getDefaultColumnsForProjectType(detectedType);
  } else {
    boardColumns = columns.map(({ tasks: _t, ...col }) => col);
  }

  const boardId = await createBoard(_user, title, boardColumns, null, null, detectedType || 'standard');

  // Ensure cards module has the current user before creating cards
  setCurrentUser(_user);
  setBoardId(boardId);

  // Place generated tasks into their columns
  let totalTasks = 0;
  const orderByColumn = new Map();
  for (let i = 0; i < columns.length; i += 1) {
    const col = columns[i];
    if (!Array.isArray(col.tasks)) continue;
    // Map original AI column to the new boardColumns best-effort by index
    const targetColumnId = boardColumns[i]?.id || boardColumns[0]?.id;
    if (!targetColumnId) continue;
    for (const t of col.tasks) {
      if (!t.title) continue;
      const order = orderByColumn.get(targetColumnId) ?? 0;
      await createCard(targetColumnId, t.title, t.description || '', order, false, t.subtasks || []);
      orderByColumn.set(targetColumnId, order + 1);
      totalTasks++;
    }
  }

  const typeLabel = PROJECT_TYPES.find((pt) => pt.value === detectedType)?.label || '';
  const typeSuffix = typeLabel ? ` (${typeLabel} type)` : '';
  const colCount = boardColumns.length;
  _addToHistory(
    'assistant',
    `I created "${title}"${typeSuffix} with ${colCount} column${colCount !== 1 ? 's' : ''} and ${totalTasks} task${totalTasks !== 1 ? 's' : ''}! Opening it now…`,
  );

  if (_onBoardCreated) {
    _onBoardCreated(boardId, { id: boardId, title, columns: boardColumns, projectType: detectedType || 'standard' });
  }
}

async function _doBoardMode(text) {
  const directSubtask = _parseDirectSubtaskIntent(text);
  if (directSubtask) {
    _removeThinking();
    const targetCard = _findCardByHint(directSubtask.targetHint) || _findTargetCardFromPrompt(text);
    if (!targetCard) {
      _addToHistory('assistant', `I could not find the task "${directSubtask.targetHint}". Try quoting the card title, e.g. add sub task "${directSubtask.subtaskTitle}" to task "Fix Bug".`);
      return;
    }
    const existingSubtasks = _readCardSubtasks(targetCard.cardEl);
    const nextSubtasks = [
      ...existingSubtasks,
      {
        id: `sub-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        title: directSubtask.subtaskTitle,
        completed: false,
      },
    ];
    await updateCard(targetCard.cardId, { subtasks: nextSubtasks });
    _addToHistory('assistant', `Added sub-task "${directSubtask.subtaskTitle}" to "${targetCard.cardTitle}".`);
    return;
  }

  // Generate a new task suggestion, then place it by prompt intent.
  const { title, description } = await generateCard(text, { metered: false });
  _removeThinking();

  const columns = _getVisibleColumns();
  if (columns.length === 0) {
    _addToHistory('assistant', 'No column found. Please open a board first.');
    return;
  }

  const targetCard = _findTargetCardFromPrompt(text);
  if (targetCard) {
    const existingSubtasks = _readCardSubtasks(targetCard.cardEl);
    const nextSubtasks = [
      ...existingSubtasks,
      {
        id: `sub-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        title,
        completed: false,
      },
    ];
    await updateCard(targetCard.cardId, { subtasks: nextSubtasks });
    _addToHistory('assistant', `Added "${title}" as a sub-task on "${targetCard.cardTitle}".`);
    return;
  }

  const target = _resolveTargetColumn(text, columns);
  const listEl = document.querySelector(`.card-list[data-column-id="${target.id}"]`);
  const order = listEl?.children.length ?? 0;
  await createCard(target.id, title, description, order);
  _addToHistory('assistant', `Added "${title}" to ${target.label}.`);
}

async function _doDashboardMode(text) {
  _removeThinking();

  const cards = getCardsSnapshot();
  const q = _normalize(text);
  const isEffectivelyCompleted = (c) => Boolean(c?.completed) || /\bdone\b|\bfinish(?:ed)?\b|\bcomplete(?:d)?\b|\bdeployment\b|\bresolved\b/i.test(String(c?.columnId || ''));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const in7 = new Date(today);
  in7.setDate(in7.getDate() + 7);
  const in14 = new Date(today);
  in14.setDate(in14.getDate() + 14);

  const openCards = cards.filter((c) => !isEffectivelyCompleted(c));
  const overdue = openCards.filter((c) => c.dueDate && new Date(c.dueDate + 'T00:00:00') < today);
  const dueSoon = openCards.filter((c) => c.dueDate && new Date(c.dueDate + 'T00:00:00') >= today && new Date(c.dueDate + 'T00:00:00') <= in7);
  const blocked = openCards.filter((c) => /blocked|risk|hold|waiting/i.test(String(c.columnId || '')));
  const due14 = openCards.filter((c) => c.dueDate && new Date(c.dueDate + 'T00:00:00') <= in14);
  const undated = openCards.filter((c) => !c.dueDate);

  const fmt = (arr, max = 6) => arr
    .slice(0, max)
    .map((c) => `- ${c.title || 'Untitled'}${c.dueDate ? ` (${c.dueDate})` : ''}`)
    .join('\n');

  let answer = '';

  if (/overdue|recover|recovery/.test(q)) {
    const focus = [...overdue]
      .sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')))
      .slice(0, 3);
    const nextWorkday = new Date(today);
    nextWorkday.setDate(nextWorkday.getDate() + 1);
    const nextWorkdayKey = nextWorkday.toISOString().slice(0, 10);

    const concreteSteps = focus.flatMap((task, i) => {
      const taskName = task.title || 'Untitled';
      const oldDue = task.dueDate || 'no date';
      return [
        `${i + 1}. ${taskName}: set owner + priority now (critical if blocking others).`,
        `${i + 1}. ${taskName}: split into 2-3 smaller deliverables with clear done criteria.`,
        `${i + 1}. ${taskName}: update due date from ${oldDue} to ${nextWorkdayKey} or add a blocker reason.`,
      ];
    });

    answer = [
      'Dashboard Q&A mode is active (answer-only).',
      '',
      `Recommendation explained: overdue tasks are late commitments and should be stabilized before new work.`,
      '',
      `Overdue now (${overdue.length}):`,
      overdue.length ? fmt([...overdue].sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')))) : '- None overdue right now',
      '',
      'Exact next actions:',
      concreteSteps.length ? concreteSteps.join('\n') : '1. No overdue tasks to recover right now.',
      '',
      'Definition of done for recovery:',
      '- each overdue task has owner, updated due date, and next concrete step.',
      '- no overdue task remains without status update by end of day.',
    ].join('\n');
  } else if (/prioriti|rank|risk|urgency|due date/.test(q)) {
    const ranked = [...overdue, ...dueSoon]
      .sort((a, b) => {
        const aDue = a.dueDate ? new Date(a.dueDate + 'T00:00:00').getTime() : Number.MAX_SAFE_INTEGER;
        const bDue = b.dueDate ? new Date(b.dueDate + 'T00:00:00').getTime() : Number.MAX_SAFE_INTEGER;
        return aDue - bDue;
      });
    answer = [
      'Dashboard Q&A mode is active (answer-only).',
      '',
      'Priority order by deadline pressure (overdue first):',
      ranked.length ? fmt(ranked) : '- No overdue or due-soon tasks found',
      '',
      'Reasoning: overdue tasks carry immediate schedule risk; nearest due dates come next.',
    ].join('\n');
  } else if (/block|mitigation|unblock/.test(q)) {
    answer = [
      'Dashboard Q&A mode is active (answer-only).',
      '',
      `Blocked/risk tasks to mitigate (${blocked.length}):`,
      blocked.length ? fmt(blocked) : '- No blocked tasks currently flagged',
      '',
      'Mitigation checklist: assign owner, define unblock dependency, set decision deadline, and add fallback path.',
    ].join('\n');
  } else if (/sprint|14|two week|plan/.test(q)) {
    answer = [
      'Dashboard Q&A mode is active (answer-only).',
      '',
      `14-day execution candidates (${due14.length} due within 14 days):`,
      due14.length ? fmt([...due14].sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')))) : '- No dated tasks in the next 14 days',
      '',
      undated.length ? `Also schedule these undated open tasks:\n${fmt(undated, 4)}` : 'No undated open tasks to schedule.',
    ].join('\n');
  } else {
    answer = [
      'Dashboard Q&A mode is active (answer-only).',
      '',
      `Current snapshot: ${openCards.length} open, ${overdue.length} overdue, ${dueSoon.length} due in 7 days, ${blocked.length} blocked.`,
      '',
      overdue.length ? `Overdue tasks:\n${fmt(overdue, 5)}` : 'Overdue tasks: none',
      dueSoon.length ? `\nDue-soon tasks:\n${fmt(dueSoon, 5)}` : '\nDue-soon tasks: none',
      blocked.length ? `\nBlocked tasks:\n${fmt(blocked, 5)}` : '\nBlocked tasks: none',
      '',
      `Question asked: "${text}"`,
    ].join('\n');
  }

  _addToHistory('assistant', answer);
}

function _getVisibleColumns() {
  return [...document.querySelectorAll('.column')].map((col) => {
    const titleInput = col.querySelector('.col-title-input');
    const title = titleInput?.value?.trim()
      || titleInput?.dataset?.original
      || col.dataset.columnId
      || '';
    return {
      id: col.dataset.columnId,
      title,
      normalizedTitle: _normalize(title),
    };
  }).filter((c) => c.id);
}

function _resolveTargetColumn(text, columns) {
  const normalized = _normalize(text);
  const todoDefault = columns[0];

  const keywordToColumn = [
    { re: /\b(to\s*do|todo|backlog)\b/, aliases: ['todo', 'to do', 'backlog'] },
    { re: /\b(in\s*progress|in-progress|doing|wip)\b/, aliases: ['in progress', 'doing', 'wip'] },
    { re: /\b(done|complete|completed|finished)\b/, aliases: ['done', 'complete', 'completed', 'finished'] },
  ];

  for (const entry of keywordToColumn) {
    if (!entry.re.test(normalized)) continue;
    const found = columns.find((c) => entry.aliases.some((a) => c.normalizedTitle.includes(_normalize(a))));
    if (found) return { id: found.id, label: `"${found.title}"` };
  }

  const byLength = [...columns].sort((a, b) => b.normalizedTitle.length - a.normalizedTitle.length);
  for (const col of byLength) {
    if (!col.normalizedTitle) continue;
    if (normalized.includes(col.normalizedTitle)) {
      return { id: col.id, label: `"${col.title}"` };
    }
  }

  return { id: todoDefault.id, label: 'the first column (default TODO)' };
}

function _findTargetCardFromPrompt(text) {
  const normalized = _normalize(text);
  if (!/(\bto\b|\bunder\b|\binside\b).*\bcard\b/.test(normalized) && !/\bsub\s?task\b/.test(normalized)) {
    return null;
  }

  const cards = [...document.querySelectorAll('.card')].map((cardEl) => {
    const rawTitle = cardEl.querySelector('.card-title')?.textContent || '';
    const title = rawTitle.replace(/\s*\d+\/\d+\s*$/, '').trim();
    return {
      cardEl,
      cardId: cardEl.dataset.cardId,
      cardTitle: title,
      normalizedTitle: _normalize(title),
    };
  }).filter((c) => c.cardId && c.cardTitle);
  if (cards.length === 0) return null;

  const quoted = text.match(/"([^"]+)"/);
  if (quoted?.[1]) {
    const q = _normalize(quoted[1]);
    const exact = cards.find((c) => c.normalizedTitle === q);
    if (exact) return exact;
    const partial = cards.find((c) => c.normalizedTitle.includes(q) || q.includes(c.normalizedTitle));
    if (partial) return partial;
  }

  const hint = text.match(/(?:to|under|inside)\s+(?:the\s+)?card\s+([a-z0-9][^,.!?]*)/i);
  if (hint?.[1]) {
    const h = _normalize(hint[1]);
    const match = cards.find((c) => c.normalizedTitle.includes(h) || h.includes(c.normalizedTitle));
    if (match) return match;
  }

  const longest = [...cards].sort((a, b) => b.normalizedTitle.length - a.normalizedTitle.length);
  return longest.find((c) => normalized.includes(c.normalizedTitle)) || null;
}

function _readCardSubtasks(cardEl) {
  try {
    const parsed = JSON.parse(cardEl?.dataset?.subtasks || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function _parseDirectSubtaskIntent(text) {
  const cleaned = String(text || '').trim();
  const match = cleaned.match(/(?:add|create)\s+(?:a\s+)?sub\s*-?\s*task\s+(.+?)\s+(?:to|under|inside)\s+(?:the\s+)?(?:task|card)\s+(.+)$/i);
  if (!match) return null;
  const subtaskTitle = match[1].trim().replace(/^"|"$/g, '').trim();
  const targetHint = match[2].trim().replace(/^"|"$/g, '').trim();
  if (!subtaskTitle || !targetHint) return null;
  return { subtaskTitle, targetHint };
}

function _findCardByHint(hint) {
  const target = _normalize(hint);
  if (!target) return null;

  const cards = [...document.querySelectorAll('.card')].map((cardEl) => {
    const rawTitle = cardEl.querySelector('.card-title')?.textContent || '';
    const cardTitle = rawTitle.replace(/\s*\d+\/\d+\s*$/, '').trim();
    return {
      cardEl,
      cardId: cardEl.dataset.cardId,
      cardTitle,
      normalizedTitle: _normalize(cardTitle),
    };
  }).filter((c) => c.cardId && c.cardTitle);

  const exact = cards.find((c) => c.normalizedTitle === target);
  if (exact) return exact;

  const partial = cards.find((c) => c.normalizedTitle.includes(target) || target.includes(c.normalizedTitle));
  return partial || null;
}

function _normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
