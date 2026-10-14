// HTML5 drag-and-drop helpers. Payload is {type, id} where type is one of
// trip | user | category | supply | set | item | card (a category card on the board).
import { store } from './store.js';

const MIME = 'application/x-supply-planner';
let current = null;
let marked = null; // element showing where a drop would land

/** Show an insertion marker (`drop-before`, `drop-after`, `drop-end`) on el; null clears it. */
export function mark(el, cls) {
  if (marked && (marked.el !== el || marked.cls !== cls)) marked.el.classList.remove(marked.cls);
  marked = el ? { el, cls } : null;
  el?.classList.add(cls);
}

export function makeDraggable(container) {
  container.addEventListener('dragstart', (e) => {
    const el = e.target.closest('[data-drag-type]');
    if (!el) return;
    current = { type: el.dataset.dragType, id: el.dataset.dragId };
    e.dataTransfer.setData(MIME, JSON.stringify(current));
    e.dataTransfer.setData('text/plain', el.dataset.dragName || '');
    e.dataTransfer.effectAllowed = 'copyMove';
    // data-drag-preview names an ancestor to drag as a whole, e.g. a card by its header.
    const preview = el.dataset.dragPreview && el.closest(el.dataset.dragPreview);
    if (preview) {
      const r = preview.getBoundingClientRect();
      e.dataTransfer.setDragImage(preview, e.clientX - r.left, e.clientY - r.top);
    }
    (preview || el).classList.add('dragging');
    document.body.classList.add(`dragging-${current.type}`);
    store.hold();
  });
  container.addEventListener('dragend', (e) => {
    document.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    mark(null);
    document.body.classList.remove(...[...document.body.classList].filter((c) => c.startsWith('dragging-')));
    document.querySelectorAll('.drop-over').forEach((el) => el.classList.remove('drop-over'));
    current = null;
    store.release();
  });
}

/**
 * Register a drop target. `accepts(payload)` decides whether the zone lights up;
 * `onDrop(payload, event)` handles it. Inner zones win over outer ones.
 * `onOver(payload, event)`, if given, runs on every dragover the zone claims,
 * typically to `mark()` the insertion point.
 */
export function dropZone(el, { accepts, onDrop, onOver }) {
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
