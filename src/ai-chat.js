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
import { createCard, setCurrentUser }           from './cards.js';

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

  // All tasks go into the first (TODO) column — none are done yet
  const todoColumnId = boardColumns[0]?.id;
  let totalTasks = 0;
  let order = 0;
  for (const col of columns) {
    if (!Array.isArray(col.tasks)) continue;
    for (const t of col.tasks) {
      if (!t.title) continue;
      await createCard(todoColumnId, t.title, t.description || '', order++, false, t.subtasks || []);
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
  const lower = text.toLowerCase();

  // Detect "add subtask to [card]" intent — not supported via chat yet; guide the user
  if (/sub.?task/.test(lower)) {
    _removeThinking();
    _addToHistory('assistant', 'To add a subtask, open the card by clicking the edit icon, then use the "+ Add subtask" button inside the card modal.');
    return;
  }

  // Default: generate a new card via AI and place it in the first column
  const { title, description } = await generateCard(text);
  _removeThinking();

  const firstList = document.querySelector('.card-list[data-column-id]');
  const columnId  = firstList?.dataset.columnId;
  if (!columnId) {
    _addToHistory('assistant', 'No column found. Please open a board first.');
    return;
  }

  const order = firstList.children.length;
  await createCard(columnId, title, description, order);
  _addToHistory('assistant', `Added "${title}" to the first column.`);
}
