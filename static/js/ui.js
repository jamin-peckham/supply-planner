// Small DOM helpers shared by every module.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts.at(-1)[0] : '')).toUpperCase() || '?';
}

export function toast(message, variant = 'secondary') {
  const host = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast align-items-center text-bg-${variant} border-0`;
  el.setAttribute('role', 'alert');
  el.innerHTML = `<div class="d-flex"><div class="toast-body">${esc(message)}</div>
    <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button></div>`;
  host.append(el);
  const t = bootstrap.Toast.getOrCreateInstance(el, { delay: 4000 });
  el.addEventListener('hidden.bs.toast', () => el.remove());
  t.show();
}

export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(`supply-planner:${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`supply-planner:${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable: preference just isn't remembered */
    }
  },
};
