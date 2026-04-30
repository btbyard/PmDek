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
import { createCard, setCurrentUser, updateCard, getCardsSnapshot, getBoardAssignedMembers } from './cards.js';
import { getAiUsageSummary } from './billing.js';
import { detectOpenProjectIntent, detectRequestedAnalysisFields, getOpenProjectQuestionSuggestions } from './open-project-intents.js';

const HISTORY_KEY_PREFIX = 'aiChatHistory';
const PIN_KEY_PREFIX = 'aiChatPinned';
const WIDTH_KEY_PREFIX = 'aiChatWidth';
const TAB_KEY_PREFIX = 'aiChatTab';
const MAX_HISTORY = 100;

function _key(prefix) {
  return _user?.uid ? `${prefix}_${_user.uid}` : prefix;
}

let _user           = null;
let _mode           = 'boards'; // 'boards' | 'board' | 'dashboard'
let _activeTab      = 'create'; // 'create' | 'project'
let _onBoardCreated = null;     // callback(boardId, boardObj)
let _submitting     = false;
let _isResizing     = false;
let _resizePointerId = null;
let _resizeRaf = 0;
let _pendingResizeWidth = null;

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

  _initResize();
  _applySavedWidth();

  document.getElementById('ai-chat-close-btn')
    ?.addEventListener('click', closeAiChat);

  document.getElementById('ai-chat-expand-btn')
    ?.addEventListener('click', () => {
      const sidebar = document.getElementById('ai-chat-sidebar');
      if (!sidebar) return;
      const isMobile = window.matchMedia('(max-width: 767px)').matches;
      if (isMobile || sidebar.classList.contains('mobile-ai-modal')) {
        closeAiChat();
        return;
      }
      if (sidebar.classList.contains('ai-chat-collapsed')) {
        expandAiChat();
      } else {
        collapseAiChat();
      }
    });

  document.getElementById('ai-chat-pin-btn')
    ?.addEventListener('click', () => {
      const sidebar = document.getElementById('ai-chat-sidebar');
      if (!sidebar) return;
      setAiChatPinned(!sidebar.classList.contains('ai-chat-pinned'));
    });

  document.getElementById('ai-chat-tab-create')
    ?.addEventListener('click', () => _setChatTab('create'));
  document.getElementById('ai-chat-tab-project')
    ?.addEventListener('click', () => _setChatTab('project'));

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

  _setChatTab(_readSavedTab(), { persist: false });
  _refreshUsageBadge();
  setAiChatPinned(_readPinned(), { persist: false, focusInput: false });

  window.addEventListener('pmdek:ai-chat-layout-sync', _syncLayoutInset);
}

/**
 * Switch the sidebar context.
 * 'boards' → creates full decks; 'board' → creates cards on the current board.
 *
 * @param {'boards'|'board'} mode
 */
export function setAiChatMode(mode) {
  _mode = mode;
  _syncInputPlaceholder();
  _refreshUsageBadge();
}

/**
 * Toggle the sidebar open / closed.
 */
export function toggleAiChat() {
  const sidebar = document.getElementById('ai-chat-sidebar');
  if (!sidebar) return;
  if (sidebar.classList.contains('ai-chat-pinned')) {
    expandAiChat();
    return;
  }
  if (sidebar.classList.contains('ai-chat-collapsed')) {
    expandAiChat();
  } else {
    collapseAiChat();
  }
}

export function openAiChat({ focusInput = true } = {}) {
  const sidebar = document.getElementById('ai-chat-sidebar');
  if (!sidebar) return;
  sidebar.dataset.open = '1';
  if (focusInput && !sidebar.classList.contains('ai-chat-collapsed')) {
    setTimeout(() => document.getElementById('ai-chat-input')?.focus(), 310);
  }
  _syncChatHeader();
}

export function setAiChatExpanded(expanded) {
  const sidebar = document.getElementById('ai-chat-sidebar');
  if (!sidebar) return;
  if (!expanded && sidebar.classList.contains('ai-chat-pinned')) return;
  sidebar.classList.toggle('ai-chat-expanded', Boolean(expanded));
  if (expanded) sidebar.classList.remove('ai-chat-collapsed');
  _setButtonsActive(Boolean(expanded));
  _syncChatHeader();
}

export function collapseAiChat() {
  const sidebar = document.getElementById('ai-chat-sidebar');
  if (!sidebar) return;
  if (sidebar.classList.contains('ai-chat-pinned')) return;
  openAiChat({ focusInput: false });
  sidebar.classList.remove('ai-chat-expanded');
  sidebar.classList.add('ai-chat-collapsed');
  _setButtonsActive(false);
  _syncChatHeader();
}

export function expandAiChat() {
  const sidebar = document.getElementById('ai-chat-sidebar');
  if (!sidebar) return;
  openAiChat();
  sidebar.classList.remove('ai-chat-collapsed');
  sidebar.classList.add('ai-chat-expanded');
  _setButtonsActive(true);
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

  const isMobile = window.matchMedia('(max-width: 767px)').matches;
  if (isMobile || sidebar.classList.contains('mobile-ai-modal')) {
    sidebar.classList.remove('mobile-ai-modal', 'ai-chat-expanded', 'ai-chat-collapsed');
    sidebar.style.display = 'none';
    document.body.classList.remove('ai-mobile-chat-open');
    document.getElementById('mobile-ai-chat-toggle')?.classList.remove('active');
    document.getElementById('mobile-ai-board-btn')?.classList.remove('active');
    _setButtonsActive(false);
    _syncChatHeader();
    _syncLayoutInset();
    return;
  }

  if (sidebar.classList.contains('ai-chat-pinned')) return;
  collapseAiChat();
}

function setAiChatPinned(pinned, { persist = true, focusInput = true } = {}) {
  const sidebar = document.getElementById('ai-chat-sidebar');
  if (!sidebar) return;

  const wasExpanded = sidebar.classList.contains('ai-chat-expanded');
  sidebar.classList.toggle('ai-chat-pinned', Boolean(pinned));
  if (persist) localStorage.setItem(_key(PIN_KEY_PREFIX), pinned ? '1' : '0');

  if (pinned) {
    openAiChat({ focusInput });
    sidebar.classList.remove('ai-chat-collapsed');
    sidebar.classList.add('ai-chat-expanded');
    _setButtonsActive(true);
  } else {
    // Unpin should not force-collapse the chat; preserve current open/collapsed state.
    if (wasExpanded) {
      sidebar.classList.remove('ai-chat-collapsed');
      sidebar.classList.add('ai-chat-expanded');
      _setButtonsActive(true);
    } else {
      sidebar.classList.remove('ai-chat-expanded');
      sidebar.classList.add('ai-chat-collapsed');
      _setButtonsActive(false);
    }
  }

  _syncChatHeader();
}

function _readPinned() {
  return localStorage.getItem(_key(PIN_KEY_PREFIX)) === '1';
}

function _initResize() {
  const handle = document.getElementById('ai-chat-resizer');
  if (!handle || handle.dataset.bound === '1') return;
  handle.dataset.bound = '1';

  const onPointerMove = (event) => {
    if (!_isResizing) return;
    if (_resizePointerId !== null && event.pointerId !== _resizePointerId) return;
    _pendingResizeWidth = window.innerWidth - event.clientX;
    if (_resizeRaf) return;
    _resizeRaf = window.requestAnimationFrame(() => {
      _resizeRaf = 0;
      if (_pendingResizeWidth == null) return;
      _setSidebarWidth(_pendingResizeWidth, { persist: false });
    });
  };

  const stopResize = () => {
    if (!_isResizing) return;
    _isResizing = false;
    _resizePointerId = null;
    _pendingResizeWidth = null;
    document.body.classList.remove('ai-chat-resizing');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stopResize);
    window.removeEventListener('pointercancel', stopResize);
    if (_resizeRaf) {
      window.cancelAnimationFrame(_resizeRaf);
      _resizeRaf = 0;
    }

    const sidebar = document.getElementById('ai-chat-sidebar');
    sidebar?.classList.remove('ai-chat-resizing');
    const width = Number(sidebar?.dataset.userWidth || 0);
    if (Number.isFinite(width) && width > 0) {
      localStorage.setItem(_key(WIDTH_KEY_PREFIX), String(Math.round(width)));
    }
  };

  handle.addEventListener('pointerdown', (event) => {
    const sidebar = document.getElementById('ai-chat-sidebar');
    if (!sidebar || window.innerWidth <= 768) return;
    if (sidebar.classList.contains('ai-chat-collapsed')) return;

    _isResizing = true;
    _resizePointerId = event.pointerId;
    document.body.classList.add('ai-chat-resizing');
    sidebar.classList.add('ai-chat-resizing');
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', stopResize, { passive: true });
    window.addEventListener('pointercancel', stopResize, { passive: true });
    event.preventDefault();
  });

  window.addEventListener('resize', () => {
    const width = Number(localStorage.getItem(_key(WIDTH_KEY_PREFIX)) || 0);
    if (Number.isFinite(width) && width > 0) {
      _setSidebarWidth(width, { persist: false });
      return;
    }
    _syncLayoutInset();
  });
}

function _applySavedWidth() {
  const saved = Number(localStorage.getItem(_key(WIDTH_KEY_PREFIX)) || 0);
  if (!Number.isFinite(saved) || saved <= 0) return;
  _setSidebarWidth(saved, { persist: false });
}

function _setSidebarWidth(width, { persist = true } = {}) {
  const sidebar = document.getElementById('ai-chat-sidebar');
  if (!sidebar) return;
  const clamped = _clampSidebarWidth(width);
  sidebar.style.setProperty('--ai-chat-width', `${clamped}px`);
  sidebar.dataset.userWidth = String(clamped);
  if (persist) localStorage.setItem(_key(WIDTH_KEY_PREFIX), String(clamped));
  _syncLayoutInset();
}

function _clampSidebarWidth(width) {
  const min = 340;
  const maxByViewport = Math.max(min, window.innerWidth - 96);
  const max = Math.min(980, maxByViewport);
  const numeric = Number(width);
  if (!Number.isFinite(numeric)) return Math.min(736, max);
  return Math.round(Math.max(min, Math.min(max, numeric)));
}

function _syncChatHeader() {
  const sidebar = document.getElementById('ai-chat-sidebar');
  const btn = document.getElementById('ai-chat-expand-btn');
  const pinBtn = document.getElementById('ai-chat-pin-btn');
  const title = document.getElementById('ai-chat-title');
  if (!sidebar || !btn || !title) return;
  const collapsed = sidebar.classList.contains('ai-chat-collapsed');
  const pinned = sidebar.classList.contains('ai-chat-pinned');
  btn.title = collapsed ? 'Expand AI chat' : 'Collapse AI chat';
  btn.setAttribute('aria-label', collapsed ? 'Expand AI chat' : 'Collapse AI chat');
  btn.innerHTML = collapsed
    ? '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/></svg>'
    : '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>';
  title.textContent = collapsed ? 'Dealer' : 'AI Dealer';

  if (pinBtn) {
    pinBtn.title = pinned ? 'Unpin AI chat' : 'Pin AI chat open';
    pinBtn.setAttribute('aria-label', pinned ? 'Unpin AI chat' : 'Pin AI chat open');
    pinBtn.classList.toggle('bg-amber-200', pinned);
    pinBtn.classList.toggle('text-amber-900', pinned);
  }

  _syncLayoutInset();
}

function _syncLayoutInset() {
  const sidebar = document.getElementById('ai-chat-sidebar');
  if (!sidebar) return;

  const nonMobile = window.innerWidth > 640;
  const visible = sidebar.style.display !== 'none';
  const expanded = sidebar.classList.contains('ai-chat-expanded');
  const collapsed = sidebar.classList.contains('ai-chat-collapsed');

  let inset = 0;
  if (nonMobile && visible) {
    if (expanded) {
      // Use the target width, not mid-transition measured width
      const savedWidth = Number(sidebar.dataset.userWidth || localStorage.getItem(_key(WIDTH_KEY_PREFIX)) || 0);
      const defaultWidth = Math.min(window.innerWidth * 0.96, 736);
      const targetWidth = Math.round(savedWidth > 0 ? savedWidth : defaultWidth);
      inset = targetWidth + 14;
    } else if (collapsed) {
      // Collapsed rail: reserve enough space so it doesn't overlap buttons
      inset = 62; // ~3.35rem rail + small gap
    }
  }

  document.documentElement.style.setProperty('--ai-chat-inset', `${inset}px`);
  document.body.classList.toggle('ai-chat-open', nonMobile && visible && expanded);
}

function _readSavedTab() {
  const saved = localStorage.getItem(_key(TAB_KEY_PREFIX));
  return saved === 'project' ? 'project' : 'create';
}

function _setChatTab(tab, { persist = true } = {}) {
  const next = tab === 'project' ? 'project' : 'create';
  _activeTab = next;
  if (persist) localStorage.setItem(_key(TAB_KEY_PREFIX), next);

  const createBtn = document.getElementById('ai-chat-tab-create');
  const projectBtn = document.getElementById('ai-chat-tab-project');
  const setActive = (btn, active) => {
    if (!btn) return;
    btn.classList.toggle('bg-amber-100', active);
    btn.classList.toggle('text-amber-900', active);
    btn.classList.toggle('border-amber-200', active);
    btn.classList.toggle('text-gray-600', !active);
    btn.classList.toggle('border-gray-200', !active);
  };
  setActive(createBtn, next === 'create');
  setActive(projectBtn, next === 'project');

  _syncInputPlaceholder();
  _renderHistory();
}

function _syncInputPlaceholder() {
  const input = document.getElementById('ai-chat-input');
  if (!input) return;

  if (_activeTab === 'project') {
    input.placeholder = 'Ask about risks, priorities, blockers, and forecast…';
    return;
  }

  if (_mode === 'boards') {
    input.placeholder = 'Describe a project to create a full deck…';
  } else if (_mode === 'dashboard') {
    input.placeholder = 'Describe a task to add to the current deck…';
  } else {
    input.placeholder = 'Describe a task to add to the board…';
  }
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
    return JSON.parse(localStorage.getItem(_key(`${HISTORY_KEY_PREFIX}:${_activeTab}`)) ?? '[]');
  } catch {
    return [];
  }
}

function _saveHistory(messages) {
  localStorage.setItem(_key(`${HISTORY_KEY_PREFIX}:${_activeTab}`), JSON.stringify(messages.slice(-MAX_HISTORY)));
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
  const openProjectSuggestions = getOpenProjectQuestionSuggestions(3)
    .map((s) => `- "${s}"`)
    .join('<br>');

  const emptyBody = _activeTab === 'project'
    ? `
      <p class="text-xs text-gray-400 leading-relaxed">
        Ask for project risks, priorities, blockers,<br>or milestone planning support.
      </p>
      <p class="mt-2 text-[11px] text-gray-500 leading-relaxed">
        Try:<br>${openProjectSuggestions}
      </p>`
    : `
      <p class="text-xs text-gray-400 leading-relaxed">
        Ask AI Dealer to create a PM Deck for your project, or add tasks to the current board.
      </p>
      <p class="mt-2 text-[11px] text-gray-500 leading-relaxed">
        Tip: use "to Done" / "to In Progress" for column targeting, or "add sub task X to task Y" for exact sub-task placement.
      </p>`;

  container.innerHTML = `
    <div id="ai-chat-empty" class="flex flex-col items-center justify-center h-full text-center px-6 py-8">
      <span class="text-5xl mb-3 select-none">✨</span>
      <p class="text-sm font-semibold text-gray-600 mb-1">${_activeTab === 'project' ? 'Open Project Dealer' : 'Task / Creation Dealer'}</p>
      ${emptyBody}
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

  if (isUser) {
    bubble.textContent = msg.text;
  } else {
    bubble.innerHTML = _formatAssistantMessageToHtml(msg.text);
  }
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

function _escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _formatAssistantMessageToHtml(text) {
  const lines = String(text || '').split(/\r?\n/);
  const html = [];
  let listType = null;
  let listItems = [];

  const flushList = () => {
    if (!listType || listItems.length === 0) {
      listType = null;
      listItems = [];
      return;
    }
    const tag = listType === 'ol' ? 'ol' : 'ul';
    const classes = tag === 'ol'
      ? 'list-decimal ml-5 my-1 space-y-1'
      : 'list-disc ml-5 my-1 space-y-1';
    html.push(`<${tag} class="${classes}">${listItems.map((i) => `<li>${i}</li>`).join('')}</${tag}>`);
    listType = null;
    listItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }

    const numbered = line.match(/^\d+\.\s+(.+)$/);
    const bullet = line.match(/^-\s+(.+)$/);
    if (numbered) {
      if (listType !== 'ol') {
        flushList();
        listType = 'ol';
      }
      listItems.push(_escapeHtml(numbered[1]));
      continue;
    }
    if (bullet) {
      if (listType !== 'ul') {
        flushList();
        listType = 'ul';
      }
      listItems.push(_escapeHtml(bullet[1]));
      continue;
    }

    flushList();
    html.push(`<p class="my-1">${_escapeHtml(line)}</p>`);
  }

  flushList();
  return html.join('');
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

    if (_isTrivialMessage(text)) {
      _removeThinking();
      _addToHistory('assistant', "Hi! I'm AI Dealer. Try describing a project — for example: \"Build a mobile app for tracking workouts\" — and I'll create a full deck with tasks.");
      return;
    }

    if (_activeTab === 'project' || _mode === 'dashboard') {
      await _doDashboardMode(text);
    } else if (_mode === 'boards') {
      await _doBoardsMode(text);
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
  const intent = detectOpenProjectIntent(q);
  const requestedFields = detectRequestedAnalysisFields(q);
  const wantsAssignees = requestedFields.includes('assignees') || intent === 'assignee_assignment';
  const isEffectivelyCompleted = (c) => Boolean(c?.completed) || /\bdone\b|\bfinish(?:ed)?\b|\bcomplete(?:d)?\b|\bdeployment\b|\bresolved\b/i.test(String(c?.columnId || ''));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const in7 = new Date(today);
  in7.setDate(in7.getDate() + 7);
  const in14 = new Date(today);
  in14.setDate(in14.getDate() + 14);

  const openCards = cards.filter((c) => !isEffectivelyCompleted(c));
  const doneCards = cards.filter((c) => isEffectivelyCompleted(c));
  const completionRate = cards.length ? Math.round((doneCards.length / cards.length) * 100) : 0;
  const overdue = openCards.filter((c) => c.dueDate && new Date(c.dueDate + 'T00:00:00') < today);
  const dueSoon = openCards.filter((c) => c.dueDate && new Date(c.dueDate + 'T00:00:00') >= today && new Date(c.dueDate + 'T00:00:00') <= in7);
  const blocked = openCards.filter((c) => /blocked|risk|hold|waiting/i.test(String(c.columnId || '')));
  const due14 = openCards.filter((c) => c.dueDate && new Date(c.dueDate + 'T00:00:00') <= in14);
  const undated = openCards.filter((c) => !c.dueDate);
  const memberByUid = new Map((getBoardAssignedMembers() || []).map((m) => [m.uid, m]));
  const assigneeLabel = (uid) => {
    if (!uid || uid === 'Unassigned') return 'Unassigned';
    const m = memberByUid.get(uid);
    if (!m) return uid;
    return m.displayName || (m.username ? `@${m.username}` : m.uid);
  };
  const cardOwnersLine = (card) => {
    const owners = Array.isArray(card.assignees) && card.assignees.length ? card.assignees : ['Unassigned'];
    return owners.map(assigneeLabel).join(', ');
  };
  const fmt = (arr, max = 6) => arr
    .slice(0, max)
    .map((c) => `- ${c.title || 'Untitled'}${c.dueDate ? ` (${c.dueDate})` : ''}`)
    .join('\n');

  const toDate = (value) => value ? new Date(`${value}T00:00:00`) : null;
  const daysUntil = (value) => {
    const due = toDate(value);
    if (!due) return null;
    return Math.round((due.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
  };
  const fmtDate = (value) => {
    const due = toDate(value);
    if (!due) return 'No due date';
    return due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const taskName = (c) => c?.title || 'Untitled task';
  const taskLabel = (c) => `${taskName(c)}${c?.dueDate ? ` (${c.dueDate})` : ''}`;
  const normalizeCardTitle = (value) => _normalize(String(value || '').replace(/[^a-z0-9\s]/gi, ' '));
  const sortByDue = (arr) => [...arr].sort((a, b) => {
    const aDue = a.dueDate ? new Date(`${a.dueDate}T00:00:00`).getTime() : Number.MAX_SAFE_INTEGER;
    const bDue = b.dueDate ? new Date(`${b.dueDate}T00:00:00`).getTime() : Number.MAX_SAFE_INTEGER;
    return aDue - bDue;
  });
  const mentionedCards = cards.filter((c) => {
    const name = normalizeCardTitle(c.title || '');
    return name && q.includes(name);
  });
  const quotedTask = String(text || '').match(/"([^"]+)"/);
  const specificallyMentioned = quotedTask
    ? cards.find((c) => normalizeCardTitle(c.title || '') === normalizeCardTitle(quotedTask[1])) || mentionedCards[0] || null
    : mentionedCards[0] || null;
  const priorityReason = (task) => {
    if (!task) return 'Needs review.';
    if (blocked.includes(task)) return 'It is blocked, so any delay can cascade unless the blocker is resolved quickly.';
    const delta = daysUntil(task.dueDate);
    if (delta == null) return 'It has no due date, so it needs scheduling before it can be forecast reliably.';
    if (delta < 0) return `It is already overdue by ${Math.abs(delta)} day${Math.abs(delta) === 1 ? '' : 's'}, so it carries immediate delivery risk.`;
    if (delta === 0) return 'It is due today, so it should be treated as immediate work.';
    if (delta === 1) return 'It is due tomorrow, which makes it the next urgent commitment.';
    if (delta <= 3) return `It is due in ${delta} days, so it should stay near the top of the queue.`;
    return `Its due date is still close enough that it should be planned now rather than later.`;
  };
  const effortEstimate = (task) => {
    const subtasks = Array.isArray(task?.subtasks) ? task.subtasks : [];
    const openSubtasks = subtasks.filter((s) => !s.completed).length;
    const descLen = String(task?.description || '').trim().length;
    const score = (openSubtasks * 4) + (subtasks.length * 2) + (descLen > 180 ? 3 : (descLen > 80 ? 2 : (descLen > 0 ? 1 : 0)));
    const reasonBits = [];
    if (openSubtasks > 0) reasonBits.push(`${openSubtasks} open subtask${openSubtasks === 1 ? '' : 's'}`);
    if (subtasks.length > openSubtasks) reasonBits.push(`${subtasks.length} total subtasks`);
    if (descLen > 80) reasonBits.push('larger scope description');
    if (!reasonBits.length) reasonBits.push('not yet broken down, so effort is uncertain');
    return { score, reason: reasonBits.join(', ') };
  };
  const assigneeLoad = (() => {
    const load = new Map();
    openCards.forEach((c) => {
      const owners = Array.isArray(c.assignees) && c.assignees.length ? c.assignees : ['Unassigned'];
      owners.forEach((o) => {
        const label = assigneeLabel(o);
        load.set(label, (load.get(label) || 0) + 1);
      });
    });
    return [...load.entries()].sort((a, b) => b[1] - a[1]);
  })();
  const assigneeSection = () => {
    const focus = sortByDue(dueSoon).slice(0, 5);
    const lines = focus.length
      ? focus.map((c, i) => `${i + 1}. ${taskLabel(c)}\n   Assigned: ${cardOwnersLine(c)}`).join('\n')
      : 'No due-soon tasks to map by assignee.';
    const loadLines = assigneeLoad.length
      ? assigneeLoad.slice(0, 5).map(([who, count], i) => `${i + 1}. ${who}: ${count} open task${count === 1 ? '' : 's'}`).join('\n')
      : 'No assignee workload data available.';
    return [
      'Assignee view:',
      lines,
      '',
      'Workload snapshot:',
      loadLines,
    ].join('\n');
  };
  const recommendationExplanation = () => {
    if (/assign due dates?/.test(q)) {
      const targets = undated.slice(0, 3);
      return [
        'Adding due dates improves forecasting because it turns vague work into scheduled commitments.',
        '',
        targets.length
          ? `Start with these open tasks:\n${targets.map((c, i) => `${i + 1}. ${taskName(c)} — give it an owner and a target date.`).join('\n')}`
          : 'There are no undated open tasks right now, so this recommendation is already covered.',
        '',
        'Next actions:',
        '1. Set a due date on each task based on effort and dependency order.',
        '2. Mark any task waiting on someone else as blocked instead of leaving it unscheduled.',
        '3. Recheck the dashboard after updating dates so the 7-day and 14-day views become accurate.',
      ].join('\n');
    }

    if (/clear\s+\d+\s+overdue|overdue task|overdue/.test(q)) {
      const focus = sortByDue(overdue).slice(0, 3);
      return [
        'This recommendation matters because overdue tasks are already past commitment and usually create the most visible schedule risk.',
        '',
        focus.length
          ? `Focus here first:\n${focus.map((c, i) => `${i + 1}. ${taskLabel(c)} — ${priorityReason(c)}`).join('\n')}`
          : 'You do not currently have overdue tasks, so this recommendation is preventive rather than urgent.',
        '',
        'Next actions:',
        '1. Confirm the owner and whether the task is still realistic to finish as scoped.',
        '2. Split large work into smaller deliverables and move the first deliverable to the top of the queue.',
        '3. Update the due date or add a blocker note today so the plan reflects reality.',
      ].join('\n');
    }

    return [
      'This recommendation is trying to reduce delivery risk and make the board easier to forecast.',
      '',
      'Next actions:',
      '1. Identify the specific tasks behind the recommendation.',
      '2. Assign owners and dates where they are missing.',
      '3. Re-open the dashboard to confirm the risk count actually drops.',
    ].join('\n');
  };

  let answer = '';

  if (intent === 'risk_assessment') {
    const riskLevel = overdue.length > 0
      ? 'High'
      : (dueSoon.length >= 3 || blocked.length > 0 ? 'Medium' : 'Low to Medium');
    const topLoad = assigneeLoad[0];
    answer = [
      `Project risk summary: ${riskLevel}.`,
      '',
      `1. Schedule risk: ${overdue.length} overdue and ${dueSoon.length} due in the next 7 days.`,
      `2. Execution risk: ${blocked.length} blocked task${blocked.length === 1 ? '' : 's'}.`,
      `3. Planning risk: ${undated.length} open task${undated.length === 1 ? '' : 's'} without due dates.`,
      `4. Capacity risk: ${topLoad ? `${topLoad[0]} owns ${topLoad[1]} open task${topLoad[1] === 1 ? '' : 's'}.` : 'No clear workload concentration detected.'}`,
      '',
      'Top tasks to watch:',
      dueSoon.length ? fmt(sortByDue(dueSoon), 4) : '- No due-soon tasks currently.',
      '',
      'Recommended next moves:',
      '1. Time-box and re-sequence the top 2 due-soon tasks.',
      '2. Add due dates for undated work so forecast is reliable.',
      '3. If any task is blocked, assign an unblock owner and deadline today.',
    ].join('\n');
  } else if (intent === 'assignee_assignment') {
    answer = assigneeSection();
  } else if (intent === 'longest_effort') {
    const rankedEffort = [...openCards]
      .map((c) => ({ card: c, ...effortEstimate(c) }))
      .sort((a, b) => b.score - a.score);

    if (!rankedEffort.length) {
      answer = 'There are no open tasks to estimate right now.';
    } else {
      const top = rankedEffort[0];
      answer = [
        `Best estimate: "${taskName(top.card)}" will likely take the most time.`,
        `Why: ${top.reason}.`,
        '',
        'Top effort candidates:',
        rankedEffort.slice(0, 3).map((r, i) => `${i + 1}. ${taskLabel(r.card)}\n   Effort signal: ${r.reason}.`).join('\n'),
        '',
        'Tip: add/clean subtasks and acceptance criteria to improve estimate accuracy.',
      ].join('\n');
    }
  } else if (intent === 'project_summary') {
    const nextActions = [];
    if (dueSoon.length) nextActions.push(`Prioritize ${taskLabel(sortByDue(dueSoon)[0])}.`);
    if (undated.length) nextActions.push(`Schedule due dates for ${Math.min(undated.length, 3)} undated task${undated.length === 1 ? '' : 's'}.`);
    if (blocked.length) nextActions.push(`Resolve blocker on ${taskLabel(blocked[0])}.`);
    if (!nextActions.length) nextActions.push('Maintain momentum by closing one medium-priority task this cycle.');

    answer = [
      'Project summary:',
      `- Total tasks: ${cards.length}`,
      `- Completed: ${doneCards.length} (${completionRate}%)`,
      `- Open: ${openCards.length}`,
      `- Overdue: ${overdue.length}`,
      `- Due in 7 days: ${dueSoon.length}`,
      `- Blocked: ${blocked.length}`,
      '',
      dueSoon.length ? `Near-term focus:\n${fmt(sortByDue(dueSoon), 3)}` : 'Near-term focus: no due-soon tasks right now.',
      '',
      'Suggested next actions:',
      nextActions.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    ].join('\n');
  } else if (intent === 'milestone_plan' && specificallyMentioned) {
    const target = specificallyMentioned;
    const delta = daysUntil(target.dueDate);
    answer = [
      `Here is a practical plan for ${taskName(target)}${target.dueDate ? `, due ${fmtDate(target.dueDate)}` : ''}.`,
      '',
      'Risk checks:',
      `1. Scope check: confirm what “done” means for ${taskName(target)} so the task does not keep expanding.`,
      `2. Dependency check: verify whether this task depends on another person, bug fix, approval, or environment setup.`,
      `3. Schedule check: ${delta == null ? 'set a due date before committing more work to it.' : delta < 0 ? 'it is already late, so re-baseline it immediately.' : delta <= 3 ? 'it is close enough to need daily follow-up.' : 'it still has room, but should be broken into short checkpoints now.'}`,
      '',
      'Next 3 actions:',
      `1. Break ${taskName(target)} into 2-3 concrete subtasks with visible completion points.`,
      `2. Confirm the owner and clear the first blocker or dependency today.`,
      `3. Add or update the next checkpoint date so progress is visible before the final due date.`,
    ].join('\n');
  } else if (intent === 'milestone_plan') {
    answer = [
      'I can build a milestone plan, but I need a specific task or milestone name.',
      '',
      'Try one of these:',
      '1. help me plan this milestone "Fix Bug"',
      '2. plan this task "Conduct Project Risk Assessment"',
      '3. plan milestone "Release Readiness"',
    ].join('\n');
  } else if (intent === 'recommendation_explain') {
    answer = recommendationExplanation();
  } else if (intent === 'overdue_recovery') {
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
      `You have ${overdue.length} overdue task${overdue.length === 1 ? '' : 's'}. Here is the most practical recovery path.`,
      '',
      `Overdue now:`,
      overdue.length ? fmt([...overdue].sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')))) : '- None overdue right now',
      '',
      'What to do next:',
      concreteSteps.length ? concreteSteps.join('\n') : '1. No overdue tasks to recover right now.',
      '',
      'You are back under control when:',
      '- each overdue task has owner, updated due date, and next concrete step.',
      '- no overdue task remains without status update by end of day.',
    ].join('\n');
  } else if (intent === 'priority_ranking') {
    const explicitSet = mentionedCards.length ? mentionedCards : [...overdue, ...dueSoon];
    const ranked = sortByDue(explicitSet);
    answer = [
      ranked.length
        ? 'Here is the priority order, ranked by delivery risk and urgency.'
        : 'There are no overdue or due-soon tasks to rank right now.',
      '',
      ranked.length
        ? ranked.slice(0, 6).map((task, i) => `${i + 1}. ${taskLabel(task)}\n   Why: ${priorityReason(task)}`).join('\n')
        : '- No overdue or due-soon tasks found',
    ].join('\n');
  } else if (intent === 'blockers') {
    answer = [
      blocked.length
        ? 'These are the tasks that need unblock actions first.'
        : 'There are no tasks currently marked blocked or at risk.',
      '',
      `Blocked or at-risk tasks:`,
      blocked.length ? fmt(blocked) : '- No blocked tasks currently flagged',
      '',
      'Mitigation checklist:',
      '1. Assign one owner for the unblock action.',
      '2. Name the exact dependency or decision that is blocking progress.',
      '3. Set a deadline for the unblock decision, not just the task due date.',
      '4. Add a fallback path if the dependency is not resolved in time.',
    ].join('\n');
  } else if (intent === 'sprint_window') {
    answer = [
      'Here is a practical 14-day execution view based on what is already on the board.',
      '',
      `Tasks due within 14 days:`,
      due14.length ? fmt([...due14].sort((a, b) => String(a.dueDate || '').localeCompare(String(b.dueDate || '')))) : '- No dated tasks in the next 14 days',
      '',
      undated.length ? `Also schedule these undated tasks so they stop hiding risk:\n${fmt(undated, 4)}` : 'No undated open tasks to schedule.',
    ].join('\n');
  } else {
    answer = [
      'Here is the current dashboard summary in plain language.',
      '',
      `You have ${openCards.length} open task${openCards.length === 1 ? '' : 's'}, ${overdue.length} overdue, ${dueSoon.length} due in the next 7 days, and ${blocked.length} blocked.`,
      '',
      overdue.length ? `Overdue tasks:\n${fmt(overdue, 5)}` : 'Overdue tasks: none',
      dueSoon.length ? `\nDue soon:\n${fmt(dueSoon, 5)}` : '\nDue soon: none',
      blocked.length ? `\nBlocked tasks:\n${fmt(blocked, 5)}` : '\nBlocked tasks: none',
      '',
      'Ask me things like “rank the due-soon tasks,” “explain this recommendation,” or “help me plan this milestone.”',
    ].join('\n');
  }

  if (wantsAssignees && intent !== 'assignee_assignment') {
    answer = `${answer}\n\n${assigneeSection()}`;
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
