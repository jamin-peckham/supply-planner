// One reusable right-click menu, styled as a Bootstrap dropdown.
import { store } from './store.js';
import { esc } from './ui.js';

let menu;
let open = false;

function close() {
  if (!open) return;
  open = false;
  menu.classList.remove('show');
  store.release();
}

/**
 * items: [{ label, icon, action, danger, disabled }], { header } or 'divider'.
 * Accepts a mouse event (positions at the pointer) or an element (positions under it).
 */
export function showContextMenu(anchor, items) {
  menu ??= document.getElementById('ctxMenu');
  close();
  menu.innerHTML = items
    .map((it, i) => {
      if (it === 'divider') return '<li><hr class="dropdown-divider"></li>';
      if (it.header) return `<li><h6 class="dropdown-header">${esc(it.header)}</h6></li>`;
      const cls = `dropdown-item${it.danger ? ' text-danger' : ''}${it.disabled ? ' disabled' : ''}`;
      const icon = it.icon ? `<i class="bi ${it.icon} me-2"></i>` : '';
      return `<li><button type="button" class="${cls}" data-index="${i}">${icon}${esc(it.label)}</button></li>`;
    })
    .join('');
  menu.onclick = (e) => {
    const btn = e.target.closest('[data-index]');
    if (!btn) return;
    const item = items[Number(btn.dataset.index)];
    close();
    item.action?.();
  };

  let x;
  let y;
  if (anchor instanceof Event) {
    anchor.preventDefault();
    x = anchor.clientX;
    y = anchor.clientY;
  } else {
    const r = anchor.getBoundingClientRect();
    x = r.left;
    y = r.bottom;
  }
  menu.classList.add('show');
  open = true;
  store.hold();
  const { innerWidth: w, innerHeight: h } = window;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = `${Math.max(4, Math.min(x, w - mw - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, h - mh - 4))}px`;
  menu.querySelector('button:not(.disabled)')?.focus();
}

export function initContextMenu() {
  menu = document.getElementById('ctxMenu');
  document.addEventListener('pointerdown', (e) => {
    if (open && !menu.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  document.addEventListener('scroll', close, true);
}
