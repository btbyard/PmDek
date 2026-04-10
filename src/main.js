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
import { renderBoard, setBoardId }                               from './board.js';
import { subscribeToCards, unsubscribeFromCards, initCardEvents } from './cards.js';
import { openAiModal }                                           from './ai.js';
import { renderBoardsHome, openCreateBoardModal, openAiBoardModal } from './boards-home.js';

// ─── Module state ─────────────────────────────────────────────────────────────

/** Authenticated user, set on sign-in and cleared on sign-out. */
let _user = null;

// Tracks whether the email form is in sign-in or register mode.
let _emailMode = 'signin'; // 'signin' | 'register'

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
  await renderBoardsHome(_user, _openBoard);
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

  // Update the topbar board title
  const titleEl = document.getElementById('board-title-display');
  if (titleEl) titleEl.textContent = boardObj.title;

  setBoardId(boardId);
  renderBoard(boardObj);
  subscribeToCards();
  initCardEvents(_user);
  _showView('board');
}

document.getElementById('back-to-boards-btn')?.addEventListener('click', () => {
  unsubscribeFromCards();
  _showBoardsHome();
});

document.getElementById('ai-trigger-btn')?.addEventListener('click', () => {
  openAiModal('todo');
});

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

