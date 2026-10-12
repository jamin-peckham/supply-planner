// HTML5 drag-and-drop helpers. Payload is {type, id} where type is one of
// trip | user | category | supply | set | item.
import { store } from './store.js';

const MIME = 'application/x-supply-planner';
let current = null;

export function makeDraggable(container) {
  container.addEventListener('dragstart', (e) => {
    const el = e.target.closest('[data-drag-type]');
    if (!el) return;
    current = { type: el.dataset.dragType, id: el.dataset.dragId };
    e.dataTransfer.setData(MIME, JSON.stringify(current));
    e.dataTransfer.setData('text/plain', el.dataset.dragName || '');
    e.dataTransfer.effectAllowed = 'copyMove';
    el.classList.add('dragging');
    document.body.classList.add(`dragging-${current.type}`);
    store.hold();
  });
  container.addEventListener('dragend', (e) => {
    e.target.closest('[data-drag-type]')?.classList.remove('dragging');
    document.body.classList.remove(...[...document.body.classList].filter((c) => c.startsWith('dragging-')));
    document.querySelectorAll('.drop-over').forEach((el) => el.classList.remove('drop-over'));
    current = null;
    store.release();
  });
}

/**
 * Register a drop target. `accepts(payload)` decides whether the zone lights up;
 * `onDrop(payload, event)` handles it. Inner zones win over outer ones.
 */
export function dropZone(el, { accepts, onDrop }) {
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
  });
  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) el.classList.remove('drop-over');
  });
  el.addEventListener('drop', (e) => {
    el.classList.remove('drop-over');
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
