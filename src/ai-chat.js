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
import { createBoard, setBoardId }              from './board.js';
import { createCard, setCurrentUser, updateCard } from './cards.js';

const HISTORY_KEY = 'aiChatHistory';
const MAX_HISTORY = 100;

let _user           = null;
let _mode           = 'boards'; // 'boards' | 'board'
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
  input.placeholder = mode === 'boards'
    ? 'Describe a project to create a full deck…'
    : 'Describe a task to add to the board…';
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
}

export function closeAiChat() {
  const sidebar = document.getElementById('ai-chat-sidebar');
  if (!sidebar) return;
  delete sidebar.dataset.open;
  sidebar.classList.add('translate-x-full');
  _setButtonsActive(false);
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
    if (_isTrivialMessage(text)) {
      _removeThinking();
      _addToHistory('assistant', "Hi! I'm your AI project assistant. Try describing a project — for example: \"Build a mobile app for tracking workouts\" — and I'll create a full deck with tasks.");
      return;
    }
    if (_mode === 'boards') {
      await _doBoardsMode(text);
    } else {
      await _doBoardMode(text);
    }
  } catch (err) {
    console.error('[ai-chat] error:', err);
    _removeThinking();
    _addToHistory('assistant', 'Sorry, something went wrong. Please try again.');
  } finally {
    _submitting = false;
    if (sendBtn) sendBtn.disabled = false;
    input.focus();
  }
}

// ─── AI actions ───────────────────────────────────────────────────────────────

async function _doBoardsMode(text) {
  const { title, columns } = await generateBoardWithTasks(text);
  _removeThinking();

  // Strip tasks array before saving board structure (columns only)
  const boardColumns = columns.map(({ tasks: _t, ...col }) => col);
  const boardId      = await createBoard(_user, title, boardColumns);

  // Ensure cards module has the current user before creating cards
  setCurrentUser(_user);

  // Set boardId context so createCard can resolve the board
  setBoardId(boardId);

  // Place generated tasks into their corresponding generated column.
  let totalTasks = 0;
  const orderByColumn = new Map();
  for (let i = 0; i < columns.length; i += 1) {
    const col = columns[i];
    if (!Array.isArray(col.tasks)) continue;
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

  const colCount = columns.length;
  _addToHistory(
    'assistant',
    `I created "${title}" with ${colCount} card${colCount !== 1 ? 's' : ''} and ${totalTasks} task${totalTasks !== 1 ? 's' : ''}! Opening it now…`,
  );

  if (_onBoardCreated) {
    _onBoardCreated(boardId, { id: boardId, title, columns: boardColumns });
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
  const { title, description } = await generateCard(text);
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
