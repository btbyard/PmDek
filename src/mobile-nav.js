/**
 * @module mobile-nav
 * @description
 * Mobile navigation handling: view dropdowns, filter dropdowns, and AI chat toggle.
 */

import { closeAiChat, expandAiChat } from './ai-chat.js';

/**
 * Initialize mobile navigation menus and AI chat toggle.
 */
export function initMobileNav() {
  _setupMobileViewsMenu();
  _setupMobileFiltersMenu();
  _setupMobileAiChatToggle();
  _setupMenuClosing();
}

function _setupMobileViewsMenu() {
  const btn = document.getElementById('mobile-views-menu-btn');
  const menu = document.getElementById('mobile-views-menu');
  if (!btn || !menu) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = menu.classList.contains('hidden');
    if (isHidden) {
      document.querySelectorAll('[id$="-menu"]').forEach((m) => m.classList.add('hidden'));
      menu.classList.remove('hidden');
    } else {
      menu.classList.add('hidden');
    }
  });

  const options = menu.querySelectorAll('.mobile-view-option');
  options.forEach((option) => {
    option.addEventListener('click', (e) => {
      const view = e.target.dataset.view;
      menu.classList.add('hidden');

      switch (view) {
        case 'kanban':
          document.getElementById('board-kanban-view-btn')?.click();
          break;
        case 'list':
          document.getElementById('board-list-view-btn')?.click();
          break;
        case 'calendar':
          document.getElementById('board-calendar-view-btn')?.click();
          break;
        case 'timeline':
          document.getElementById('project-timeline-btn')?.click();
          break;
        case 'activity':
          document.getElementById('board-activity-log-btn')?.click();
          break;
        case 'reset':
          document.getElementById('reset-col-widths-btn')?.click();
          break;
      }
    });
  });
}

function _setupMobileFiltersMenu() {
  const btn = document.getElementById('mobile-filters-menu-btn');
  const menu = document.getElementById('mobile-filters-menu');
  if (!btn || !menu) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = menu.classList.contains('hidden');
    if (isHidden) {
      document.querySelectorAll('[id$="-menu"]').forEach((m) => m.classList.add('hidden'));
      menu.classList.remove('hidden');
    } else {
      menu.classList.add('hidden');
    }
  });

  // Map mobile filter buttons to desktop buttons
  const filterMapping = {
    'filter-overdue-btn-mobile': 'filter-overdue-btn',
    'filter-today-btn-mobile': 'filter-today-btn',
    'filter-recurring-btn-mobile': 'filter-recurring-btn',
    'filter-my-tasks-btn-mobile': 'filter-my-tasks-btn',
    'fullscreen-focus-btn-mobile': 'fullscreen-focus-btn',
  };

  Object.entries(filterMapping).forEach(([mobileId, desktopId]) => {
    const btn = document.getElementById(mobileId);
    const desktopBtn = document.getElementById(desktopId);
    if (btn && desktopBtn) {
      btn.addEventListener('click', () => {
        desktopBtn.click();
        menu.classList.add('hidden');
      });
    }
  });
}

function _setupMobileAiChatToggle() {
  const btn = document.getElementById('mobile-ai-chat-toggle');
  const sidebar = document.getElementById('ai-chat-sidebar');
  if (!btn || !sidebar) return;

  btn.addEventListener('click', () => {
    const isOpen = sidebar.classList.contains('mobile-ai-modal') && sidebar.style.display !== 'none';
    if (isOpen) {
      closeAiChat();
      return;
    }

    sidebar.style.display = 'flex';
    sidebar.classList.add('mobile-ai-modal', 'ai-chat-expanded');
    sidebar.classList.remove('ai-chat-collapsed');
    document.body.classList.add('ai-mobile-chat-open');
    btn.classList.add('active');
    expandAiChat();

    // Close other menus while AI drawer is open.
    document.querySelectorAll('[id$="-menu"]').forEach((m) => m.classList.add('hidden'));
  });
}

function _setupMenuClosing() {
  // Close menus when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[id$="-menu-btn"]') && !e.target.closest('[id$="-menu"]')) {
      document.querySelectorAll('[id$="-menu"]').forEach((m) => m.classList.add('hidden'));
    }
  });
}
