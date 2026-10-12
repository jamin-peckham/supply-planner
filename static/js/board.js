// Main screen: the open trip as a grid of category cards.
// Cards and items each show two direct controls (packed toggle, remove);
// everything else lives in the right-click menu or the edit modal.
import { addToTrip, cloneFrom, createEntity, editEntity, removeEntity, saveAsSet, tripCall } from './actions.js';
import { showContextMenu } from './contextMenu.js';
import { dropZone, makeDraggable } from './dnd.js';
import { confirmDialog, editItem, editTrip, formModal } from './modals.js';
import { store } from './store.js';
import { esc, initials, storage } from './ui.js';

const FILTERS = {
  all: { label: 'All', test: () => true },
  needed: { label: 'Needed', test: (i) => i.status === 'needed' },
  mine: { label: 'Mine', test: (i) => !!store.currentUserId && i.owner_id === store.currentUserId },
  unpacked: { label: 'Unpacked', test: (i) => !i.packed },
};
let filter = storage.get('boardFilter', 'all');
if (!FILTERS[filter]) filter = 'all';

const board = () => document.getElementById('board');
const findItem = (id) => store.trip?.items.find((i) => i.id === id);

// --- Rendering -----------------------------------------------------------------

function emptyState() {
  const trips = store.trips;
  return `<div class="empty-state">
    <i class="bi bi-signpost-split display-4 text-body-tertiary"></i>
    <h2 class="h4 mt-3">No trip open</h2>
    <p class="text-body-secondary">Pick a trip from the sidebar, or start a new one.</p>
    <button type="button" class="btn btn-primary" data-act="new-trip"><i class="bi bi-plus-lg"></i> New trip</button>
    ${
      trips.length
        ? `<div class="list-group mt-4 text-start recent-trips">${trips
            .map(
              (t) => `<button type="button" class="list-group-item list-group-item-action" data-act="open-trip" data-id="${t.id}">
                <span class="fw-semibold">${esc(t.display_name)}</span>
                <small class="text-body-secondary ms-2">${esc([t.start_date, t.end_date].filter(Boolean).join(' → '))}</small></button>`,
            )
            .join('')}</div>`
        : ''
    }
  </div>`;
}

function headerHtml(trip) {
  const total = trip.items.length;
  const packed = trip.items.filter((i) => i.packed).length;
  const needed = trip.items.filter((i) => i.status === 'needed').length;
  const pct = total ? Math.round((packed / total) * 100) : 0;
  const me = store.currentUserId;
  const dates = [trip.start_date, trip.end_date].filter(Boolean).join(' → ');
  const chips = trip.member_ids
    .map(
      (id) => `<span class="member-chip${id === me ? ' is-me' : ''}" title="${esc(store.name('users', id))}">
        <span class="avatar">${esc(initials(store.name('users', id)))}</span>${esc(store.name('users', id))}
        <button type="button" class="btn-close" data-act="remove-member" data-id="${id}" aria-label="Remove ${esc(store.name('users', id))}"></button>
      </span>`,
    )
    .join('');
  const join =
    me && !trip.member_ids.includes(me)
      ? `<button type="button" class="btn btn-sm btn-outline-primary" data-act="join"><i class="bi bi-person-plus"></i> Join</button>`
      : '';
  return `<header class="trip-header">
    <div class="d-flex align-items-start gap-2 flex-wrap">
      <div class="me-auto">
        <h1 class="h3 mb-0 trip-title">${esc(trip.display_name)}</h1>
        ${dates || trip.description ? `<div class="text-body-secondary small">${esc(dates)}${dates && trip.description ? ' · ' : ''}${esc(trip.description)}</div>` : ''}
      </div>
      <button type="button" class="btn btn-sm btn-outline-secondary" data-act="edit-trip" title="Edit trip"><i class="bi bi-pencil"></i></button>
      <button type="button" class="btn btn-sm btn-outline-secondary" data-act="trip-menu" title="More" aria-label="More trip actions"><i class="bi bi-three-dots"></i></button>
    </div>
    <div class="members mt-2">${chips || '<span class="text-body-secondary small">No members yet — drag users here or use + in the sidebar.</span>'}${join}</div>
    <div class="d-flex align-items-center gap-3 flex-wrap mt-2">
      <div class="progress flex-grow-1" role="progressbar" aria-label="Packed" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
        <div class="progress-bar bg-success" style="width:${pct}%"></div>
      </div>
      <span class="small text-nowrap"><strong>${packed}</strong>/${total} packed</span>
      <span class="badge text-bg-warning-subtle border border-warning-subtle text-warning-emphasis">${needed} needed</span>
      <div class="btn-group btn-group-sm" role="group" aria-label="Filter items">
        ${Object.entries(FILTERS)
          .map(([k, f]) => `<button type="button" class="btn btn-outline-secondary${k === filter ? ' active' : ''}" data-act="filter" data-filter="${k}">${f.label}</button>`)
          .join('')}
      </div>
    </div>
  </header>`;
}

function itemHtml(item) {
  const owner = item.owner_id ? store.name('users', item.owner_id) : null;
  const mine = item.owner_id && item.owner_id === store.currentUserId;
  const supply = store.maps.supplies.get(item.supply_id);
  const name = supply?.display_name ?? '(deleted supply)';
  return `<li class="item${item.packed ? ' is-packed' : ''}" draggable="true" data-drag-type="item" data-drag-id="${item.id}" data-drag-name="${esc(name)}">
    <input class="form-check-input mt-0" type="checkbox" data-act="pack-item"${item.packed ? ' checked' : ''} aria-label="Packed">
    <span class="item-name" title="${esc(item.notes || name)}">${esc(name)}</span>
    ${item.count > 1 ? `<span class="item-count">×${item.count}</span>` : ''}
    <span class="item-meta">
      <span class="status-badge status-${item.status}">${item.status}</span>
      ${owner ? `<span class="avatar avatar-sm${mine ? ' is-me' : ''}" title="${esc(owner)}">${esc(initials(owner))}</span>` : ''}
    </span>
    <button type="button" class="btn btn-icon" data-act="remove-item" title="Remove from trip" aria-label="Remove ${esc(name)}"><i class="bi bi-x-lg"></i></button>
  </li>`;
}

function cardHtml(trip, categoryId) {
  const all = trip.items.filter((i) => i.category_id === categoryId);
  const shown = all.filter(FILTERS[filter].test);
  const packed = all.filter((i) => i.packed).length;
  const allPacked = all.length > 0 && packed === all.length;
  const name = store.name('categories', categoryId);
  const body = shown.length
    ? shown.map(itemHtml).join('')
    : `<li class="item-empty">${all.length ? 'No items match the filter' : 'Drop supplies here'}</li>`;
  return `<article class="card cat-card${allPacked ? ' is-packed' : ''}" data-category-id="${categoryId}">
    <div class="card-header">
      <span class="cat-name">${esc(name)}</span>
      <span class="cat-progress">${packed}/${all.length}</span>
      <button type="button" class="btn btn-icon" data-act="pack-cat" ${all.length ? '' : 'disabled'}
        title="${allPacked ? 'Unpack all' : 'Pack all'}" aria-pressed="${allPacked}" aria-label="${allPacked ? 'Unpack' : 'Pack'} all in ${esc(name)}">
        <i class="bi ${allPacked ? 'bi-check2-square' : 'bi-square'}"></i></button>
      <button type="button" class="btn btn-icon" data-act="remove-cat" title="Remove from trip" aria-label="Remove ${esc(name)} from trip"><i class="bi bi-x-lg"></i></button>
    </div>
    <ul class="items">${body}</ul>
    <form class="quick-add" data-act="quick-add">
      <input class="form-control form-control-sm" list="supplyOptions" placeholder="Add supply…" aria-label="Add supply to ${esc(name)}">
    </form>
  </article>`;
}

function tripHtml(trip) {
  const options = store.supplies
    .filter((s) => !s.archived)
    .map((s) => `<option value="${esc(s.display_name)}"></option>`)
    .join('');
  const cards = trip.category_ids.map((c) => cardHtml(trip, c)).join('');
  return `${headerHtml(trip)}
    <datalist id="supplyOptions">${options}</datalist>
    <div class="board-grid">${cards}
      <div class="add-card" data-act="add-category" role="button" tabindex="0">
        <i class="bi bi-plus-lg"></i><span>Add category</span>
        <small>or drag categories, supplies and sets here</small>
      </div>
    </div>`;
}

export function renderBoard() {
  const root = board();
  // Keep focus and text in a quick-add box across background re-renders.
  const active = document.activeElement;
  const keep =
    active?.closest?.('.quick-add') && root.contains(active)
      ? { cat: active.closest('.cat-card').dataset.categoryId, value: active.value, pos: active.selectionStart }
      : null;

  const trip = store.trip;
  root.innerHTML = trip ? tripHtml(trip) : emptyState();
  document.title = trip ? `${trip.display_name} · Supply Planner` : 'Supply Planner';
  if (!trip) return;

  root.querySelectorAll('.cat-card').forEach((card) => {
    const categoryId = card.dataset.categoryId;
    dropZone(card, {
      accepts: (p) => p.type === 'supply' || (p.type === 'item' && findItem(p.id)?.category_id !== categoryId),
      onDrop: (p) =>
        p.type === 'supply'
          ? addToTrip('supply', p.id, { categoryId })
          : tripCall('patch', `/items/${p.id}`, { category_id: categoryId }),
    });
  });

  if (keep) {
    const input = root.querySelector(`.cat-card[data-category-id="${keep.cat}"] .quick-add input`);
    if (input) {
      input.value = keep.value;
      input.focus();
      input.setSelectionRange(keep.pos, keep.pos);
    }
  }
}

// --- Interaction ---------------------------------------------------------------

async function removeCategory(categoryId) {
  const count = store.trip.items.filter((i) => i.category_id === categoryId).length;
  const name = store.name('categories', categoryId);
  if (count && !(await confirmDialog(`Remove “${name}” and its ${count} item${count === 1 ? '' : 's'} from this trip?`))) return;
  await tripCall('del', `/categories/${categoryId}`);
}

async function removeMember(userId) {
  const owned = store.trip.items.filter((i) => i.owner_id === userId).length;
  const name = store.name('users', userId);
  if (owned && !(await confirmDialog(`Remove ${name} from this trip? Their ${owned} item${owned === 1 ? '' : 's'} become unassigned.`))) return;
  await tripCall('del', `/members/${userId}`);
}

function setCategoryPacked(categoryId) {
  const items = store.trip.items.filter((i) => i.category_id === categoryId);
  const allPacked = items.length > 0 && items.every((i) => i.packed);
  return tripCall('put', `/categories/${categoryId}/packed`, { packed: !allPacked });
}

async function quickAdd(form) {
  const input = form.querySelector('input');
  const name = input.value.trim();
  if (!name) return;
  const categoryId = form.closest('.cat-card').dataset.categoryId;
  const match = store.supplies.find((s) => s.display_name.toLowerCase() === name.toLowerCase());
  input.value = '';
  await tripCall('post', '/items', match ? { supply_id: match.id, category_id: categoryId } : { new_name: name, category_id: categoryId });
  // A new name also created a library supply; refresh so the sidebar shows it.
  if (!match) await store.loadAll();
  board().querySelector(`.cat-card[data-category-id="${categoryId}"] .quick-add input`)?.focus();
}

async function addCategoryPrompt() {
  const onTrip = new Set(store.trip.category_ids);
  const options = store.categories.filter((c) => !onTrip.has(c.id)).map((c) => ({ value: c.id, label: c.display_name }));
  await formModal({
    title: 'Add category',
    submitLabel: 'Add',
    fields: [
      ...(options.length ? [{ name: 'category_id', label: 'Existing category', type: 'select', options: [{ value: '', label: '—' }, ...options] }] : []),
      { name: 'new_name', label: options.length ? '…or a new category' : 'New category', placeholder: 'e.g. First aid' },
    ],
    onSubmit: async (v) => {
      const body = v.category_id ? { category_id: v.category_id } : { new_name: v.new_name };
      await tripCall('post', '/categories', body);
      if (!v.category_id) await store.loadAll();
      return true;
    },
  });
}

function tripMenu(anchor) {
  const trip = store.trip;
  showContextMenu(anchor, [
    { label: 'Edit trip…', icon: 'bi-pencil', action: () => editEntity('trip', trip.id) },
    { label: 'Use as template…', icon: 'bi-copy', action: () => cloneFrom(trip) },
    { label: 'Save as standard set…', icon: 'bi-collection', action: () => saveAsSet(trip) },
    { label: 'Close trip', icon: 'bi-x-circle', action: () => store.openTrip(null) },
    'divider',
    { label: 'Delete trip…', icon: 'bi-trash', danger: true, action: () => removeEntity('trip', trip.id) },
  ]);
}

function itemMenu(e, item) {
  const me = store.currentUserId;
  const mine = me && item.owner_id === me;
  showContextMenu(e, [
    { label: 'Edit…', icon: 'bi-pencil', action: () => editItem(store.trip, item).then((t) => t && store.setTrip(t)) },
    {
      label: mine ? 'Unclaim' : me ? 'Claim (me)' : 'Claim (pick yourself first)',
      icon: mine ? 'bi-person-dash' : 'bi-person-check',
      disabled: !me,
      action: () => tripCall('patch', `/items/${item.id}`, { owner_id: mine ? null : me }),
    },
    {
      label: item.status === 'needed' ? 'Mark owned' : 'Mark needed',
      icon: item.status === 'needed' ? 'bi-bag-check' : 'bi-bag',
      action: () => tripCall('patch', `/items/${item.id}`, { status: item.status === 'needed' ? 'owned' : 'needed' }),
    },
    {
      label: item.packed ? 'Unpack' : 'Pack',
      icon: item.packed ? 'bi-square' : 'bi-check2-square',
      action: () => tripCall('patch', `/items/${item.id}`, { packed: !item.packed }),
    },
    { label: 'Edit library supply…', icon: 'bi-backpack', action: () => editEntity('supply', item.supply_id) },
    'divider',
    { label: 'Remove from trip', icon: 'bi-trash', danger: true, action: () => tripCall('del', `/items/${item.id}`) },
  ]);
}

function cardMenu(e, categoryId) {
  const items = store.trip.items.filter((i) => i.category_id === categoryId);
  const allPacked = items.length > 0 && items.every((i) => i.packed);
  showContextMenu(e, [
    { label: allPacked ? 'Unpack all' : 'Pack all', icon: 'bi-check2-square', disabled: !items.length, action: () => setCategoryPacked(categoryId) },
    { label: 'Rename / edit category…', icon: 'bi-pencil', action: () => editEntity('category', categoryId) },
    'divider',
    { label: 'Remove from trip', icon: 'bi-trash', danger: true, action: () => removeCategory(categoryId) },
  ]);
}

export function initBoard() {
  const root = board();
  makeDraggable(root);

  // The whole board is the outer drop zone; category cards are inner zones.
  dropZone(root, {
    accepts: (p) => !!store.trip && ['category', 'supply', 'set', 'user', 'trip'].includes(p.type),
    onDrop: (p) => addToTrip(p.type, p.id),
  });

  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const itemEl = el.closest('.item');
    const cardEl = el.closest('.cat-card');
    switch (act) {
      case 'new-trip':
        return createEntity('trip');
      case 'open-trip':
        return store.openTrip(el.dataset.id);
      case 'edit-trip':
        return editTrip(store.trip).then((t) => t && store.setTrip(t));
      case 'trip-menu':
        return tripMenu(el);
      case 'filter':
        filter = el.dataset.filter;
        storage.set('boardFilter', filter);
        return renderBoard();
      case 'join':
        return addToTrip('user', store.currentUserId);
      case 'remove-member':
        return removeMember(el.dataset.id);
      case 'pack-item':
        return tripCall('patch', `/items/${itemEl.dataset.dragId}`, { packed: el.checked });
      case 'remove-item':
        return tripCall('del', `/items/${itemEl.dataset.dragId}`);
      case 'pack-cat':
        return setCategoryPacked(cardEl.dataset.categoryId);
      case 'remove-cat':
        return removeCategory(cardEl.dataset.categoryId);
      case 'add-category':
        return addCategoryPrompt();
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.add-card')) addCategoryPrompt();
  });
  root.addEventListener('submit', (e) => {
    const form = e.target.closest('.quick-add');
    if (!form) return;
    e.preventDefault();
    quickAdd(form);
  });
  root.addEventListener('dblclick', (e) => {
    const itemEl = e.target.closest('.item');
    if (itemEl && !e.target.closest('[data-act]')) {
      const item = findItem(itemEl.dataset.dragId);
      if (item) editItem(store.trip, item).then((t) => t && store.setTrip(t));
    }
  });
  root.addEventListener('contextmenu', (e) => {
    if (!store.trip || e.target.closest('input, textarea')) return;
    const itemEl = e.target.closest('.item');
    if (itemEl) {
      const item = findItem(itemEl.dataset.dragId);
      if (item) itemMenu(e, item);
      return;
    }
    const cardEl = e.target.closest('.cat-card');
    if (cardEl) return cardMenu(e, cardEl.dataset.categoryId);
    if (e.target.closest('.trip-header')) return tripMenu(e);
  });
}
