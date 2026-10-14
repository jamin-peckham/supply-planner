// Drag-and-drop helpers. Payload is {type, id} where type is one of
// trip | user | category | supply | set | item | card (a category card on the board).
// Mice use native HTML5 drag; a [data-grip] handle drives the same drop zones with
// pointer events, which also works on touch screens where HTML5 drag doesn't.
import { store } from './store.js';

const MIME = 'application/x-supply-planner';
let current = null;
let marked = null; // element showing where a drop would land
const zones = new WeakMap(); // drop zone element -> its options, for grip drags
let grip = null; // the grip drag in progress

/** Show an insertion marker (`drop-before`, `drop-after`, `drop-end`) on el; null clears it. */
export function mark(el, cls) {
  if (marked && (marked.el !== el || marked.cls !== cls)) marked.el.classList.remove(marked.cls);
  marked = el ? { el, cls } : null;
  el?.classList.add(cls);
}

/** Start dragging el; returns the element that visually moves (el or its data-drag-preview ancestor). */
function beginDrag(el) {
  current = { type: el.dataset.dragType, id: el.dataset.dragId };
  const moved = (el.dataset.dragPreview && el.closest(el.dataset.dragPreview)) || el;
  moved.classList.add('dragging');
  document.body.classList.add(`dragging-${current.type}`);
  store.hold();
  return moved;
}

function endDrag() {
  document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  mark(null);
  document.body.classList.remove(...[...document.body.classList].filter((c) => c.startsWith('dragging-')));
  document.querySelectorAll('.drop-over').forEach((el) => el.classList.remove('drop-over'));
  current = null;
  store.release();
}

export function makeDraggable(container) {
  container.addEventListener('dragstart', (e) => {
    const el = e.target.closest('[data-drag-type]');
    if (!el) return;
    if (grip) return e.preventDefault();
    const moved = beginDrag(el);
    e.dataTransfer.setData(MIME, JSON.stringify(current));
    e.dataTransfer.setData('text/plain', el.dataset.dragName || '');
    e.dataTransfer.effectAllowed = 'copyMove';
    // data-drag-preview names an ancestor to drag as a whole, e.g. a card by its header.
    if (moved !== el) {
      const r = moved.getBoundingClientRect();
      e.dataTransfer.setDragImage(moved, e.clientX - r.left, e.clientY - r.top);
    }
  });
  container.addEventListener('dragend', () => {
    if (!grip) endDrag();
  });
  container.addEventListener('pointerdown', startGripDrag);
}

// --- Grip drags (pointer events) ---------------------------------------------------

function scrollParent(el) {
  for (let n = el; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return document.scrollingElement;
}

/** The innermost registered drop zone under (x, y) that accepts the current payload. */
function zoneAt(x, y) {
  for (let n = document.elementFromPoint(x, y); n; n = n.parentElement) {
    const opts = zones.get(n);
    if (opts?.accepts(current)) return { el: n, ...opts };
  }
  return null;
}

function hover() {
  const { x, y, ghost } = grip;
  ghost.style.left = `${x - grip.dx}px`;
  ghost.style.top = `${y - grip.dy}px`;
  const zone = zoneAt(x, y);
  if (grip.zone && grip.zone.el !== zone?.el) grip.zone.el.classList.remove('drop-over');
  grip.zone = zone;
  if (!zone) return mark(null);
  zone.el.classList.add('drop-over');
  zone.onOver?.(current, { clientX: x, clientY: y });
}

/** Scroll while the pointer is near the top or bottom edge of the scroller. */
function autoScroll() {
  if (!grip) return;
  const s = grip.scroller;
  const { top, bottom } = s === document.scrollingElement ? { top: 0, bottom: innerHeight } : s.getBoundingClientRect();
  const edge = 56;
  const over = grip.y < top + edge ? grip.y - top - edge : grip.y > bottom - edge ? grip.y - bottom + edge : 0;
  if (over) {
    const before = s.scrollTop;
    s.scrollTop += Math.max(-20, Math.min(20, over / 3));
    if (s.scrollTop !== before) hover();
  }
  grip.raf = requestAnimationFrame(autoScroll);
}

function startGripDrag(e) {
  const handle = e.target.closest('[data-grip]');
  const el = handle?.closest('[data-drag-type]');
  if (!el || current || !e.isPrimary || e.button !== 0) return;
  e.preventDefault();
  const moved = beginDrag(el);
  const r = moved.getBoundingClientRect();
  const ghost = moved.cloneNode(true);
  ghost.classList.remove('dragging');
  ghost.classList.add('drag-ghost');
  ghost.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
  ghost.style.width = `${r.width}px`;
  document.body.append(ghost);
  grip = {
    pointerId: e.pointerId,
    ghost,
    dx: e.clientX - r.left,
    dy: e.clientY - r.top,
    x: e.clientX,
    y: e.clientY,
    scroller: scrollParent(moved),
    zone: null,
  };
  hover();
  grip.raf = requestAnimationFrame(autoScroll);

  const onMove = (ev) => {
    if (ev.pointerId !== grip.pointerId) return;
    grip.x = ev.clientX;
    grip.y = ev.clientY;
    hover();
  };
  const finish = (ev) => {
    if (ev.pointerId !== grip.pointerId) return;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    const { zone, x, y } = grip;
    cancelAnimationFrame(grip.raf);
    ghost.remove();
    // Drop before endDrag: releasing the store may re-render the board under us.
    if (ev.type === 'pointerup' && zone) zone.onDrop(current, { clientX: x, clientY: y });
    grip = null;
    endDrag();
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
}

/**
 * Register a drop target. `accepts(payload)` decides whether the zone lights up;
 * `onDrop(payload, event)` handles it. Inner zones win over outer ones.
 * `onOver(payload, event)`, if given, runs on every dragover the zone claims,
 * typically to `mark()` the insertion point. Grip drags pass `{clientX, clientY}` as the event.
 */
export function dropZone(el, opts) {
  const { accepts, onDrop, onOver } = opts;
  zones.set(el, opts);
  el.addEventListener('dragover', (e) => {
    if (!current || !accepts(current)) return;
    if (e.defaultPrevented) {
      // An inner zone already claimed this drag.
      el.classList.remove('drop-over');
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = current.type === 'item' ? 'move' : 'copy';
    el.classList.add('drop-over');
    onOver?.(current, e);
  });
  el.addEventListener('dragleave', (e) => {
    if (el.contains(e.relatedTarget)) return;
    el.classList.remove('drop-over');
    if (marked && el.contains(marked.el)) mark(null);
  });
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop-over');
    mark(null);
    if (e.defaultPrevented) return;
    let payload = current;
    try {
      payload = JSON.parse(e.dataTransfer.getData(MIME)) || current;
    } catch {
      /* fall back to the in-memory payload */
    }
    if (!payload || !accepts(payload)) return;
    e.preventDefault();
    onDrop(payload, e);
  });
}
