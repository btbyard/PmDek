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
  signInWithEmail, registerWithEmail, resetPassword,
} from './auth.js';
import { renderBoard, setBoardId, createColumnBlock, resetColumnWidths } from './board.js';
import { subscribeToCards, unsubscribeFromCards, initCardEvents } from './cards.js';
import { openAiModal }                                           from './ai.js';
import { renderBoardsHome, openCreateBoardModal, openAiBoardModal } from './boards-home.js';

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
  openAiBoardModal(_user, (boardId, board) => _openBoard(boardId, board));
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

  setBoardId(boardId);
  renderBoard(boardObj);
  subscribeToCards();
  initCardEvents(_user);
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
  openAiModal('todo');
});

document.getElementById('reset-col-widths-btn')?.addEventListener('click', () => {
  resetColumnWidths();
});

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
    const title = input.value.trim() || 'New Column';
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

