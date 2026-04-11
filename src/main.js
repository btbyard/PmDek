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
import { subscribeToCards, unsubscribeFromCards, initCardEvents } from './cards.js';
import { renderBoardsHome, openCreateBoardModal }                 from './boards-home.js';
import { initAiChat, setAiChatMode, toggleAiChat }               from './ai-chat.js';

// ─── Module state ─────────────────────────────────────────────────────────────

/** Authenticated user, set on sign-in and cleared on sign-out. */
let _user = null;

// Tracks whether the email form is in sign-in or register mode.
let _emailMode = 'signin'; // 'signin' | 'register'

// Ordered list of boards for prev/next navigation.
let _boardsList = [];
let _currentBoardId = null;

// ─── Auth lifecycle ───────────────────────────────────────────────────────────

initAuth(
  async (user) => {
    _user = user;
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

function _openBoard(boardId, board) {
  // board may be a plain {id, title, columns} object from the tile click,
  // or just a title string from the create-board flow — normalise both.
  const boardObj = (typeof board === 'object' && board !== null)
    ? board
    : { id: boardId, title: board, columns: [] };

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
  subscribeToCards();
  initCardEvents(_user);
  setAiChatMode('board');
  _showView('board');
}

function _updateDeckNavArrows() {
  const idx      = _boardsList.findIndex((b) => b.id === _currentBoardId);
  const prevBtn  = document.getElementById('deck-prev-btn');
  const nextBtn  = document.getElementById('deck-next-btn');
  if (prevBtn) prevBtn.disabled = idx <= 0;
  if (nextBtn) nextBtn.disabled = idx < 0 || idx >= _boardsList.length - 1;
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

document.getElementById('ai-trigger-btn')?.addEventListener('click', () => {
  toggleAiChat();
});

// ─── AI help modals (? buttons) ───────────────────────────────────────────────

const _BOARDS_HELP_EXAMPLES = [
  'Create a PM deck for a mobile e-commerce app',
  'Set up a deck for a machine learning data pipeline project',
  'Build a Kanban board for launching a SaaS product',
  'Create a deck for a REST API backend service',
  'Design a project plan for a mobile calculator app',
];

const _BOARD_HELP_EXAMPLES = [
  'Create a new card for writing unit tests',
  'Add a task to set up CI/CD with GitHub Actions',
  'Create a subtask for code review on the auth module',
  'Add a new task: implement user login',
  'Create a card for performance testing the dashboard',
];

function _openAiHelpModal(examples, heading) {
  const modalRoot = document.getElementById('modal-root');
  const items = examples.map((ex) => `
    <li class="flex items-start gap-2 text-sm text-gray-700">
      <span class="text-amber-500 mt-0.5 flex-shrink-0">✨</span>
      <span class="italic">"${ex}"</span>
    </li>`).join('');

  modalRoot.innerHTML = `
    <div class="modal-backdrop fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <div class="flex items-center gap-2 mb-4">
          <span class="text-lg">✨</span>
          <h3 class="text-base font-semibold text-gray-800">${heading}</h3>
        </div>
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
  _openAiHelpModal(_BOARDS_HELP_EXAMPLES, 'Example prompts — Boards');
});
document.getElementById('ai-board-help-btn-board')?.addEventListener('click', () => {
  _openAiHelpModal(_BOARD_HELP_EXAMPLES, 'Example prompts — Board tasks');
});

document.getElementById('reset-col-widths-btn')?.addEventListener('click', () => {
  resetColumnWidths();
});

document.getElementById('project-timeline-btn')?.addEventListener('click', () => {
  _openTimelineModal();
});

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

    const q = query(
      collection(db, 'completionLog'),
      where('boardId', '==', _currentBoardId),
      orderBy('completedAt', 'desc'),
    );
    const snap = await getDocs(q);
    const logs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

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
      const date    = log.completedAt?.toDate?.();
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
    const body = document.getElementById('timeline-body');
    if (body) body.innerHTML = '<p class="text-sm text-red-500 py-4 text-center">Failed to load timeline. The index may still be building — try again in a minute.</p>';
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

  menu.innerHTML = `
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
};

// Hide all views immediately — auth state callback will reveal the correct one.
// This prevents any view flashing before Firebase resolves auth.
Object.values(_views).forEach((el) => { if (el) el.style.display = 'none'; });

const _viewDisplayMap = {
  landing: 'flex',
  boards:  'flex',
  board:   'flex',
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

