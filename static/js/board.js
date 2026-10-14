// Main screen: the open trip as a grid of category cards.
// Cards and items each show two direct controls (select checkbox, remove). An item's
// chips are the people bringing it: tap one to step it from still-to-get to has-it to
// packed, + to claim it yourself.
// Selected items get bulk actions (pack, owned, assign…) from the bar at the bottom;
// everything else lives in the right-click menu or the edit modal.
import { addToTrip, cloneFrom, createEntity, editEntity, removeEntity, saveAsSet, tripCall } from './actions.js';
import { api } from './api.js';
import { showContextMenu } from './contextMenu.js';
import { dropZone, makeDraggable, mark } from './dnd.js';
import { confirmDialog, editItem, editTrip, formModal } from './modals.js';
import { contributionOf, covered, isPacked, isShort, openSlots, store, target } from './store.js';
import { esc, initials, storage, toast } from './ui.js';

const me = () => store.currentUserId;
const mine = (item) => (me() ? contributionOf(item, me()) : null);

const FILTERS = {
  all: { label: 'All', test: () => true },
  // Short on claims, or someone still has to get theirs.
  needed: { label: 'Needed', test: (i) => isShort(store.trip, i) || i.contributions.some((c) => c.status === 'needed') },
  // What I'm bringing, plus my empty slot on per-person items.
  mine: { label: 'Mine', test: (i) => !!mine(i) || openSlots(store.trip, i).includes(me()) },
  unpacked: { label: 'Unpacked', test: (i) => !isPacked(store.trip, i) },
};
let filter = storage.get('boardFilter', 'all');
if (!FILTERS[filter]) filter = 'all';

const board = () => document.getElementById('board');
const findItem = (id) => store.trip?.items.find((i) => i.id === id);

// Selected item ids. Local to this browser; cleared when another trip opens.
const selected = new Set();
let selectionTripId = null;
let anchorId = null; // last clicked item, for shift-click ranges

// Reorder mode shows drag grips, for touch screens where HTML5 drag doesn't work.
let reordering = false;
const GRIP = '<span class="grip" data-grip data-act="grip" title="Drag to reorder" aria-hidden="true"><i class="bi bi-grip-vertical"></i></span>';

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
  const packed = trip.items.filter((i) => isPacked(trip, i)).length;
  const needed = trip.items.filter(FILTERS.needed.test).length;
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

// More chips than this collapse into a "+N" chip that opens the editor.
const MAX_CHIPS = 3;

const STATE_TEXT = { packed: 'packed', owned: 'has it', needed: 'still has to get it' };
// Tapping a chip steps it along: still to get → has it → packed → back to still to get.
const NEXT_STATE = {
  needed: { label: 'mark as has it', body: { status: 'owned' } },
  owned: { label: 'mark packed', body: { packed: true } },
  packed: { label: 'start over (still to get)', body: { status: 'needed' } }, // needing it unpacks it
};

function chipHtml(item, c) {
  const who = store.name('users', c.owner_id);
  const state = c.packed ? 'packed' : c.status;
  const n = c.count > 1 && !item.per_person ? `<span class="chip-n">×${c.count}</span>` : '';
  const title = `${who}${c.count > 1 ? ` ×${c.count}` : ''}: ${STATE_TEXT[state]}. Tap to ${NEXT_STATE[state].label}.`;
  return `<button type="button" class="chip chip-${state}${c.owner_id === me() ? ' is-me' : ''}" data-act="chip" data-user="${c.owner_id}"
    title="${esc(title)}" aria-label="${esc(title)}">${esc(initials(who))}${n}${c.packed ? '<i class="bi bi-check-lg"></i>' : ''}</button>`;
}

function slotHtml(userId) {
  const who = store.name('users', userId);
  const title = `${who} hasn't claimed theirs yet. Tap to claim.`;
  return `<button type="button" class="chip chip-slot${userId === me() ? ' is-me' : ''}" data-act="slot" data-user="${userId}"
    title="${esc(title)}" aria-label="${esc(title)}">${esc(initials(who))}</button>`;
}

/** The people bringing an item (me first), empty per-person slots, and a claim button. */
function chipsHtml(trip, item) {
  const meFirst = (a, b) => (b === me()) - (a === me());
  const chips = [
    ...[...item.contributions].sort((a, b) => meFirst(a.owner_id, b.owner_id)).map((c) => chipHtml(item, c)),
    ...openSlots(trip, item).sort(meFirst).map(slotHtml),
  ];
  const shown = chips.length > MAX_CHIPS + 1 ? chips.slice(0, MAX_CHIPS) : chips;
  const more = chips.length - shown.length;
  // Per-person items are claimed through your own slot; elsewhere + adds you.
  const canClaim = !mine(item) && !openSlots(trip, item).includes(me());
  return `<span class="chips">${shown.join('')}${
    more ? `<button type="button" class="chip chip-more" data-act="edit-item" title="Show everyone">+${more}</button>` : ''
  }${canClaim ? '<button type="button" class="chip chip-claim" data-act="claim" title="I\'ll bring this" aria-label="I\'ll bring this"><i class="bi bi-plus-lg"></i></button>' : ''}</span>`;
}

function itemHtml(trip, item) {
  const supply = store.maps.supplies.get(item.supply_id);
  const name = supply?.display_name ?? '(deleted supply)';
  const need = target(trip, item);
  const have = covered(item);
  // A fraction only when it says something: a count above one, per-person, or not yet claimed.
  const fraction =
    item.per_person || need > 1 || have < need
      ? `<span class="item-count ${have < need ? 'is-short' : 'is-met'}" title="${have} of ${need} claimed${item.per_person ? ' (one per person)' : ''}">${
          item.per_person ? '<i class="bi bi-people"></i>' : ''
        }${have}/${need}</span>`
      : '';
  return `<li class="item${isPacked(trip, item) ? ' is-packed' : ''}" draggable="true" data-drag-type="item" data-drag-id="${item.id}" data-drag-name="${esc(name)}">
    ${GRIP}
    <input class="form-check-input mt-0" type="checkbox" data-act="select-item" aria-label="Select ${esc(name)}">
    <span class="item-name" title="${esc(item.notes || name)}">${esc(name)}</span>
    ${fraction}
    ${chipsHtml(trip, item)}
    <button type="button" class="btn btn-icon" data-act="remove-item" title="Remove from trip" aria-label="Remove ${esc(name)}"><i class="bi bi-x-lg"></i></button>
  </li>`;
}

function cardHtml(trip, categoryId) {
  const all = trip.items.filter((i) => i.category_id === categoryId);
  const shown = all.filter(FILTERS[filter].test);
  const packed = all.filter((i) => isPacked(trip, i)).length;
  const allPacked = all.length > 0 && packed === all.length;
  const name = store.name('categories', categoryId);
  const body = shown.length
    ? shown.map((i) => itemHtml(trip, i)).join('')
    : `<li class="item-empty">${all.length ? 'No items match the filter' : 'Drop supplies here'}</li>`;
  return `<article class="card cat-card${allPacked ? ' is-packed' : ''}" data-category-id="${categoryId}">
    <div class="card-header" draggable="true" data-drag-type="card" data-drag-id="${categoryId}" data-drag-name="${esc(name)}" data-drag-preview=".cat-card" title="Drag to reorder">
      ${GRIP}
      <input class="form-check-input mt-0" type="checkbox" data-act="select-cat" ${shown.length ? '' : 'disabled'}
        title="Select all" aria-label="Select all in ${esc(name)}">
      <span class="cat-name">${esc(name)}</span>
      <span class="cat-progress" title="Packed">${packed}/${all.length}</span>
      <button type="button" class="btn btn-icon" data-act="remove-cat" title="Remove from trip" aria-label="Remove ${esc(name)} from trip"><i class="bi bi-x-lg"></i></button>
    </div>
    <ul class="items">${body}</ul>
    <form class="quick-add" data-act="quick-add">
      <input class="form-control form-control-sm" list="supplyOptions-${categoryId}" placeholder="Add supply…" aria-label="Add supply to ${esc(name)}">
      <datalist id="supplyOptions-${categoryId}">${supplyOptions(categoryId)}</datalist>
    </form>
  </article>`;
}

/** Autocomplete for a card's quick-add: library supplies whose default category is this one. */
function supplyOptions(categoryId) {
  return store.supplies
    .filter((s) => !s.archived && s.default_category_id === categoryId)
    .map((s) => `<option value="${esc(s.display_name)}"></option>`)
    .join('');
}

function tripHtml(trip) {
  const cards = trip.category_ids.map((c) => cardHtml(trip, c)).join('');
  return `${headerHtml(trip)}
    <div class="board-grid">${cards}
      <div class="add-card" data-act="add-category" role="button" tabindex="0">
        <i class="bi bi-plus-lg"></i><span>Add category</span>
        <small>or drag categories, supplies and sets here</small>
      </div>
    </div>
    <div class="board-footer">
      ${reordering ? '<button type="button" class="btn btn-primary reorder-done" data-act="end-reorder"><i class="bi bi-check2"></i><span>Done</span></button>' : ''}
      <div class="bulk-bar" role="toolbar" aria-label="Selected items" hidden></div>
    </div>`;
}

// --- Masonry layout ----------------------------------------------------------------

// Rows are 1px tall (see .is-masonry), so a card's span is its height plus the gap.
const masonryObserver = new ResizeObserver((entries) => {
  for (const { target } of entries) layoutCard(target);
});

function layoutCard(el) {
  const grid = el.parentElement;
  if (!grid) return;
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 0;
  el.style.gridRowEnd = `span ${Math.ceil(el.getBoundingClientRect().height + gap)}`;
}

function initMasonry(grid) {
  masonryObserver.disconnect();
  grid.classList.add('is-masonry');
  for (const el of grid.children) {
    layoutCard(el); // size now so the grid has its real height before scroll is restored
    masonryObserver.observe(el);
  }
}

// --- Selection -------------------------------------------------------------------

function selectedItems() {
  return store.trip ? store.trip.items.filter((i) => selected.has(i.id)) : [];
}

// In the Mine view, pack/owned/needed apply to my share only; elsewhere to everyone's.
const mineOnly = () => filter === 'mine' && !!me();
const scopedClaims = (items) => items.flatMap((i) => (mineOnly() ? [mine(i)].filter(Boolean) : i.contributions));

function bulkBarHtml(items) {
  const n = items.length;
  const claims = scopedClaims(items);
  const none = (test) => !claims.some(test);
  const btn = (act, icon, label, disabled = false, cls = 'btn-outline-secondary') =>
    `<button type="button" class="btn btn-sm ${cls}" data-act="${act}"${disabled ? ' disabled' : ''}><i class="bi ${icon}"></i><span>${label}</span></button>`;
  return `<span class="bulk-count"><strong>${n}</strong> selected${mineOnly() ? ' · your share' : ''}</span>
    <div class="bulk-actions">
      ${btn('bulk-pack', 'bi-check2-square', 'Packed', none((c) => !c.packed))}
      ${btn('bulk-unpack', 'bi-square', 'Unpacked', none((c) => c.packed))}
      ${btn('bulk-owned', 'bi-bag-check', 'Owned', none((c) => c.status !== 'owned'))}
      ${btn('bulk-needed', 'bi-bag', 'Needed', none((c) => c.status !== 'needed'))}
      ${btn('bulk-assign', 'bi-person', 'Assign to…')}
      ${btn('bulk-remove', 'bi-trash', 'Remove', false, 'btn-outline-danger')}
    </div>
    <button type="button" class="btn btn-icon ms-auto" data-act="bulk-clear" title="Clear selection (Esc)" aria-label="Clear selection"><i class="bi bi-x-lg"></i></button>`;
}

/** Reflect `selected` in the DOM without a full re-render (keeps focus and scroll). */
function syncSelection() {
  const root = board();
  root.querySelectorAll('.item[data-drag-id]').forEach((el) => {
    const on = selected.has(el.dataset.dragId);
    el.classList.toggle('is-selected', on);
    el.querySelector('[data-act="select-item"]').checked = on;
  });
  root.querySelectorAll('.cat-card').forEach((card) => {
    const boxes = [...card.querySelectorAll('[data-act="select-item"]')];
    const on = boxes.filter((b) => b.checked).length;
    const all = card.querySelector('[data-act="select-cat"]');
    all.checked = boxes.length > 0 && on === boxes.length;
    all.indeterminate = on > 0 && on < boxes.length;
  });
  const bar = root.querySelector('.bulk-bar');
  if (!bar) return;
  const items = selectedItems();
  bar.hidden = !items.length;
  root.classList.toggle('has-selection', items.length > 0);
  bar.innerHTML = items.length ? bulkBarHtml(items) : '';
}

/** Ids of the items currently shown on the board, in screen order. */
const visibleIds = () => [...board().querySelectorAll('.item[data-drag-id]')].map((el) => el.dataset.dragId);

function toggleItem(id, { range = false } = {}) {
  const on = !selected.has(id);
  const ids = visibleIds();
  const from = ids.indexOf(anchorId);
  const to = ids.indexOf(id);
  const span = range && from >= 0 && to >= 0 ? ids.slice(Math.min(from, to), Math.max(from, to) + 1) : [id];
  for (const x of span) on ? selected.add(x) : selected.delete(x);
  anchorId = id;
  syncSelection();
}

function toggleCategory(card) {
  const ids = [...card.querySelectorAll('.item[data-drag-id]')].map((el) => el.dataset.dragId);
  const allOn = ids.every((id) => selected.has(id));
  for (const id of ids) allOn ? selected.delete(id) : selected.add(id);
  syncSelection();
}

function clearSelection() {
  selected.clear();
  anchorId = null;
  syncSelection();
}

/** Apply one change to many items, then refetch the trip once. */
async function bulkApply(ids, request) {
  if (!ids.length || !store.trip) return;
  const tripId = store.trip.id;
  await Promise.allSettled(ids.map((id) => request(`/trips/${tripId}/items/${id}`)));
  store.setTrip(await api.get(`/trips/${tripId}`));
}

const bulkPatch = (body) => bulkApply([...selected], (path) => api.patch(path, body));

/** Set packed/status on the selected items' claims: mine in the Mine view, everyone's otherwise. */
function bulkClaims(body) {
  if (!mineOnly()) return bulkPatch(body);
  const ids = selectedItems().filter(mine).map((i) => i.id);
  return bulkApply(ids, (path) => api.put(`${path}/contributions/${me()}`, body));
}

async function bulkRemove() {
  const ids = [...selected];
  if (!(await confirmDialog(`Remove ${ids.length} item${ids.length === 1 ? '' : 's'} from this trip?`))) return;
  await bulkApply(ids, (path) => api.del(path));
  clearSelection();
}

/** Add a person to every selected item. They bring what's still missing (or their own one). */
function assignMenu(anchor) {
  const trip = store.trip;
  const self = me();
  const assign = (userId) => () => bulkApply([...selected], (path) => api.put(`${path}/contributions/${userId}`, {}));
  const others = store.users.filter((u) => !trip.member_ids.includes(u.id));
  showContextMenu(anchor, [
    ...(self ? [{ label: `Me (${store.name('users', self)})`, icon: 'bi-person-check', action: assign(self) }, 'divider'] : []),
    ...(trip.member_ids.length ? [{ header: 'Members' }] : []),
    ...trip.member_ids.filter((id) => id !== self).map((id) => ({ label: store.name('users', id), icon: 'bi-person', action: assign(id) })),
    ...(others.length ? [{ header: 'Others (joins the trip)' }] : []),
    ...others.filter((u) => u.id !== self).map((u) => ({ label: u.display_name, icon: 'bi-person-plus', action: assign(u.id) })),
    'divider',
    { label: 'Clear everyone’s claims', icon: 'bi-person-dash', action: () => bulkPatch({ contributions: [] }) },
  ]);
}

// --- Reordering ------------------------------------------------------------------

/** The item a drop at height `y` would land in front of (null = end of the card), skipping the items being moved. */
function itemSlot(card, y, moving) {
  const rows = [...card.querySelectorAll('.item[data-drag-id]')].filter((el) => !moving.includes(el.dataset.dragId));
  return rows.find((el) => {
    const r = el.getBoundingClientRect();
    return y < r.top + r.height / 2;
  }) ?? null;
}

/** Dropping a card on the left half of another lands in front of it, on the right half after it. */
const dropsAfter = (card, x) => {
  const r = card.getBoundingClientRect();
  return x > r.left + r.width / 2;
};

function cardDropZone(card) {
  const categoryId = card.dataset.categoryId;
  // Dragging a selected item moves the whole selection; a supply from the sidebar moves nothing.
  const moving = (p) => (p.type === 'supply' ? [] : selected.has(p.id) ? [...selected] : [p.id]);
  dropZone(card, {
    accepts: (p) => ['supply', 'item', 'card'].includes(p.type),
    onOver: (p, e) => {
      if (p.type === 'card') return mark(card, dropsAfter(card, e.clientX) ? 'drop-after' : 'drop-before');
      const before = itemSlot(card, e.clientY, moving(p));
      mark(before ?? card.querySelector('.items'), before ? 'drop-before' : 'drop-end');
    },
    onDrop: (p, e) => {
      if (p.type !== 'card') {
        const ids = moving(p);
        const beforeId = itemSlot(card, e.clientY, ids)?.dataset.dragId ?? null;
        return p.type === 'supply'
          ? addToTrip('supply', p.id, { categoryId, beforeId })
          : tripCall('post', '/items/move', { item_ids: ids, category_id: categoryId, before_id: beforeId });
      }
      const order = store.trip.category_ids;
      const before = dropsAfter(card, e.clientX) ? order[order.indexOf(categoryId) + 1] : categoryId;
      return tripCall('post', '/categories/move', { category_id: p.id, before_id: before ?? null });
    },
  });
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
  const scrollTop = root.scrollTop;
  const sameTrip = trip?.id === selectionTripId;
  if (!sameTrip) {
    selected.clear();
    anchorId = null;
    selectionTripId = trip?.id ?? null;
    reordering = false;
  }
  root.innerHTML = trip ? tripHtml(trip) : emptyState();
  root.classList.remove('has-selection');
  root.classList.toggle('is-reordering', reordering);
  document.title = trip ? `${trip.display_name} · Supply Planner` : 'Supply Planner';
  if (!trip) {
    masonryObserver.disconnect();
    return;
  }
  initMasonry(root.querySelector('.board-grid'));
  if (sameTrip) root.scrollTop = scrollTop;

  root.querySelectorAll('.cat-card').forEach(cardDropZone);

  // Drop selected ids that are gone or hidden by the filter.
  const shown = new Set(visibleIds());
  for (const id of selected) if (!shown.has(id)) selected.delete(id);
  syncSelection();

  if (keep) {
    const input = root.querySelector(`.cat-card[data-category-id="${keep.cat}"] .quick-add input`);
    if (input) {
      input.value = keep.value;
      input.focus({ preventScroll: true });
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
  const owned = store.trip.items.filter((i) => contributionOf(i, userId)).length;
  const name = store.name('users', userId);
  if (owned && !(await confirmDialog(`Remove ${name} from this trip? Their claims on ${owned} item${owned === 1 ? '' : 's'} are dropped.`))) return;
  await tripCall('del', `/members/${userId}`);
}

/** Supplies on this card whose library default category is some other category. */
function staleDefaults(categoryId) {
  const ids = new Set(store.trip.items.filter((i) => i.category_id === categoryId).map((i) => i.supply_id));
  return [...ids].map((id) => store.maps.supplies.get(id)).filter((s) => s && s.default_category_id !== categoryId);
}

async function setDefaultsFromCard(categoryId) {
  const supplies = staleDefaults(categoryId);
  if (!supplies.length) return;
  const name = store.name('categories', categoryId);
  const n = supplies.length;
  const list = supplies.map((s) => s.display_name).join(', ');
  if (!(await confirmDialog(`Set the library default category of ${n} suppl${n === 1 ? 'y' : 'ies'} to “${name}”? (${list})`, { title: 'Update library defaults', confirmLabel: 'Update', danger: false }))) return;
  await api.post(`/trips/${store.trip.id}/categories/${categoryId}/adopt-defaults`);
  await store.loadAll();
  toast(`Updated ${n} suppl${n === 1 ? 'y' : 'ies'} to default to “${name}”.`, 'success');
}

/** Claims on a card, and whether every one of them is packed. */
function cardClaims(categoryId) {
  const claims = store.trip.items.filter((i) => i.category_id === categoryId).flatMap((i) => i.contributions);
  return { claims, allPacked: claims.length > 0 && claims.every((c) => c.packed) };
}

function setCategoryPacked(categoryId) {
  return tripCall('put', `/categories/${categoryId}/packed`, { packed: !cardClaims(categoryId).allPacked });
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

function setReordering(on) {
  reordering = on;
  renderBoard();
}

function tripMenu(anchor) {
  const trip = store.trip;
  showContextMenu(anchor, [
    { label: 'Edit trip…', icon: 'bi-pencil', action: () => editEntity('trip', trip.id) },
    { label: reordering ? 'Done reordering' : 'Reorder', icon: 'bi-arrow-down-up', action: () => setReordering(!reordering) },
    { label: 'Use as template…', icon: 'bi-copy', action: () => cloneFrom(trip) },
    { label: 'Save as standard set…', icon: 'bi-collection', action: () => saveAsSet(trip) },
    { label: 'Close trip', icon: 'bi-x-circle', action: () => store.openTrip(null) },
    'divider',
    { label: 'Delete trip…', icon: 'bi-trash', danger: true, action: () => removeEntity('trip', trip.id) },
  ]);
}

const claimPath = (item, userId) => `/items/${item.id}/contributions/${userId}`;
const openEditor = (item) => editItem(store.trip, item).then((t) => t && store.setTrip(t));

/**
 * Claim an item for me. Per-person items and single missing ones are claimed in one
 * tap; otherwise a menu asks how many, defaulting to all that's still missing.
 */
function claim(anchor, item) {
  if (!me()) return toast('Pick yourself under “I am” first.', 'warning');
  const left = target(store.trip, item) - covered(item);
  const bring = (count) => () => tripCall('put', claimPath(item, me()), { count });
  if (item.per_person || left <= 1) return bring(item.per_person ? 1 : Math.max(1, left))();
  const counts = [...new Set([left, 4, 3, 2, 1])].filter((n) => n <= left);
  showContextMenu(anchor, [
    { header: `I'll bring… (${left} still needed)` },
    ...counts.map((n) => ({ label: n === left ? `${n} (all of it)` : String(n), icon: 'bi-plus-lg', action: bring(n) })),
    { label: 'Another amount…', icon: 'bi-123', action: () => askCount(item, me(), left) },
  ]);
}

async function askCount(item, userId, value) {
  await formModal({
    title: `How many ${userId === me() ? 'are you' : `is ${store.name('users', userId)}`} bringing?`,
    submitLabel: 'Save',
    fields: [{ name: 'count', label: store.name('supplies', item.supply_id), type: 'number', min: 1, value, required: true }],
    onSubmit: (v) => tripCall('put', claimPath(item, userId), { count: v.count }),
  });
}

function cycleChip(item, userId) {
  const c = contributionOf(item, userId);
  if (c) return tripCall('put', claimPath(item, userId), NEXT_STATE[c.packed ? 'packed' : c.status].body);
}

function chipMenu(e, item, userId) {
  const c = contributionOf(item, userId);
  if (!c) return;
  const who = userId === me() ? 'You' : store.name('users', userId);
  showContextMenu(e, [
    { header: `${who}${c.count > 1 ? ` ×${c.count}` : ''}` },
    { label: c.packed ? 'Unpack' : 'Pack', icon: c.packed ? 'bi-square' : 'bi-check2-square', action: () => tripCall('put', claimPath(item, userId), { packed: !c.packed }) },
    {
      label: c.status === 'needed' ? 'Mark owned' : 'Mark needed (still to get)',
      icon: c.status === 'needed' ? 'bi-bag-check' : 'bi-bag',
      action: () => tripCall('put', claimPath(item, userId), { status: c.status === 'needed' ? 'owned' : 'needed' }),
    },
    { label: 'Change count…', icon: 'bi-123', action: () => askCount(item, userId, c.count) },
    'divider',
    { label: 'Remove claim', icon: 'bi-person-dash', danger: true, action: () => tripCall('del', claimPath(item, userId)) },
  ]);
}

function itemMenu(e, item) {
  const mineNow = mine(item);
  const claims = item.contributions;
  const allPacked = claims.length > 0 && claims.every((c) => c.packed);
  showContextMenu(e, [
    { label: 'Edit…', icon: 'bi-pencil', action: () => openEditor(item) },
    mineNow
      ? { label: 'Unclaim mine', icon: 'bi-person-dash', action: () => tripCall('del', claimPath(item, me())) }
      : { label: me() ? 'I’ll bring this…' : 'I’ll bring this (pick yourself first)', icon: 'bi-person-check', disabled: !me(), action: () => claim(e, item) },
    {
      label: allPacked ? 'Unpack everyone’s' : 'Pack everyone’s',
      icon: allPacked ? 'bi-square' : 'bi-check2-square',
      disabled: !claims.length,
      action: () => tripCall('patch', `/items/${item.id}`, { packed: !allPacked }),
    },
    {
      label: item.per_person ? 'Use a fixed count' : 'One per person',
      icon: item.per_person ? 'bi-123' : 'bi-people',
      action: () => tripCall('patch', `/items/${item.id}`, { per_person: !item.per_person }),
    },
    { label: 'Edit library supply…', icon: 'bi-backpack', action: () => editEntity('supply', item.supply_id) },
    'divider',
    { label: 'Remove from trip', icon: 'bi-trash', danger: true, action: () => tripCall('del', `/items/${item.id}`) },
  ]);
}

function cardMenu(e, categoryId) {
  const { claims, allPacked } = cardClaims(categoryId);
  showContextMenu(e, [
    { label: allPacked ? 'Unpack all' : 'Pack all', icon: 'bi-check2-square', disabled: !claims.length, action: () => setCategoryPacked(categoryId) },
    { label: 'Rename / edit category…', icon: 'bi-pencil', action: () => editEntity('category', categoryId) },
    { label: 'Update library defaults', icon: 'bi-bookmark-check', disabled: !staleDefaults(categoryId).length, action: () => setDefaultsFromCard(categoryId) },
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
    if (!el) {
      // Clicking anywhere else on an item row toggles its selection.
      const row = e.target.closest('.item[data-drag-id]');
      if (row) toggleItem(row.dataset.dragId, { range: e.shiftKey });
      return;
    }
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
      case 'select-item':
        return toggleItem(itemEl.dataset.dragId, { range: e.shiftKey });
      case 'select-cat':
        return toggleCategory(cardEl);
      case 'chip':
      case 'slot':
      case 'claim':
      case 'edit-item': {
        const item = findItem(itemEl.dataset.dragId);
        if (!item) return;
        if (act === 'chip') return cycleChip(item, el.dataset.user);
        if (act === 'slot') return tripCall('put', claimPath(item, el.dataset.user), {});
        if (act === 'claim') return claim(el, item);
        return openEditor(item);
      }
      case 'remove-item':
        return tripCall('del', `/items/${itemEl.dataset.dragId}`);
      case 'bulk-pack':
        return bulkClaims({ packed: true });
      case 'bulk-unpack':
        return bulkClaims({ packed: false });
      case 'bulk-owned':
        return bulkClaims({ status: 'owned' });
      case 'bulk-needed':
        return bulkClaims({ status: 'needed' });
      case 'bulk-assign':
        return assignMenu(el);
      case 'bulk-remove':
        return bulkRemove();
      case 'bulk-clear':
        return clearSelection();
      case 'remove-cat':
        return removeCategory(cardEl.dataset.categoryId);
      case 'add-category':
        return addCategoryPrompt();
      case 'end-reorder':
        return setReordering(false);
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.add-card')) addCategoryPrompt();
  });
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest?.('input:not([type=checkbox]), textarea, select');
    const menuOpen = document.getElementById('ctxMenu').classList.contains('show');
    if (e.key !== 'Escape' || typing || menuOpen || document.querySelector('.modal.show')) return;
    if (selected.size) clearSelection();
    else if (reordering) setReordering(false);
  }, true); // capture: run before the context menu closes itself on the same Escape
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
      if (item) openEditor(item);
    }
  });
  root.addEventListener('contextmenu', (e) => {
    if (e.target.closest('[data-grip]')) return e.preventDefault(); // a long press on a grip is a drag
    if (!store.trip || e.target.closest('input, textarea')) return;
    const itemEl = e.target.closest('.item');
    if (itemEl) {
      const item = findItem(itemEl.dataset.dragId);
      const chip = e.target.closest('[data-act="chip"]');
      if (item && chip) chipMenu(e, item, chip.dataset.user);
      else if (item) itemMenu(e, item);
      return;
    }
    const cardEl = e.target.closest('.cat-card');
    if (cardEl) return cardMenu(e, cardEl.dataset.categoryId);
    if (e.target.closest('.trip-header')) return tripMenu(e);
  });
}
