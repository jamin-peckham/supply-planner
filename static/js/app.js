// Entry point: wire modules together, load data, restore the open trip, start polling.
import { initBoard, renderBoard } from './board.js';
import { initContextMenu } from './contextMenu.js';
import { initSidebar, renderSidebar } from './sidebar.js';
import { store } from './store.js';
import { storage } from './ui.js';

function tripIdFromHash() {
  return location.hash.match(/^#\/trip\/([\w-]+)/)?.[1] ?? null;
}

async function main() {
  initContextMenu();
  initSidebar();
  initBoard();
  store.subscribe(() => {
    renderSidebar();
    renderBoard();
  });

  await store.loadAll();
  store.openTrip(tripIdFromHash() ?? storage.get('openTripId'));
  window.addEventListener('hashchange', () => store.openTrip(tripIdFromHash()));
  store.startPolling();
}

main();
