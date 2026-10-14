// Library sidebar: one collapsible section per object type; supplies are listed
// under their default category in the Categories & Supplies section.
// [+] on a section header creates; [+] on an entry adds it to the open trip;
// right-click opens the entry menu; entries can be dragged onto the board.
import { addToTrip, createEntity, editEntity, entityMenu } from './actions.js';
import { showContextMenu } from './contextMenu.js';
import { makeDraggable } from './dnd.js';
import { store, UNCATEGORIZED_ID } from './store.js';
import { esc, storage } from './ui.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function formatDates(t) {
  if (!t.start_date && !t.end_date) return `${plural(t.items.length, 'item')}`;
  return [t.start_date, t.end_date].filter(Boolean).join(' → ');
}

const SECTIONS = [
  {
    type: 'trip',
    title: 'Trips',
    icon: 'bi-signpost-split',
    list: (s) => s.trips,
    subtitle: (t) => formatDates(t),
    addIcon: 'bi-box-arrow-in-right',
    addTitle: 'Open trip',
  },
  {
    type: 'user',
    title: 'Users',
    icon: 'bi-people',
    list: (s) => s.users,
    subtitle: (u) => u.email,
    addTitle: 'Add to trip as member',
  },
  {
    // Categories with their supplies nested under each supply's default category.
    type: 'category',
    title: 'Categories & Supplies',
    icon: 'bi-tags',
    list: (s) => s.categories,
    count: (s) => s.supplies.filter((x) => !x.archived).length,
    countTitle: 'Supplies',
    tree: true,
    create: [
      { type: 'category', label: 'New category', icon: 'bi-tags' },
      { type: 'supply', label: 'New supply', icon: 'bi-backpack' },
    ],
    addTitle: 'Add category card to trip',
  },
  {
    type: 'set',
    title: 'Standard Sets',
    icon: 'bi-collection',
    list: (s) => s.sets,
    subtitle: (x) => `${plural(x.supplies.length, 'supply', 'supplies')} · ${plural(x.category_ids.length, 'category', 'categories')}`,
    addTitle: 'Apply set to trip',
  },
];

const SUPPLY_ENTRY = {
  type: 'supply',
  subtitle: (x) => (x.default_count > 1 ? `×${x.default_count}` : ''),
  addTitle: 'Add to trip (default category)',
};

const expanded = storage.get('sidebarExpanded', { trip: true, category: true });
const collapsedCats = new Set(storage.get('sidebarCollapsedCategories', []));
const filters = {};

function entryHtml(section, obj, sub = section.subtitle(obj), tag = 'li') {
  const s = store;
  const active = section.type === 'trip' && s.trip?.id === obj.id;
  const me = section.type === 'user' && s.currentUserId === obj.id;
  return `<${tag} class="lib-entry${active ? ' active' : ''}" tabindex="0" draggable="true"
      data-drag-type="${section.type}" data-drag-id="${obj.id}" data-drag-name="${esc(obj.display_name)}">
    <div class="lib-entry-text">
      <span class="lib-entry-name">${esc(obj.display_name)}${me ? ' <i class="bi bi-person-check text-primary" title="You"></i>' : ''}</span>
      ${sub ? `<small class="lib-entry-sub">${esc(sub)}</small>` : ''}
    </div>
    <button type="button" class="btn btn-icon" data-act="add" title="${esc(section.addTitle)}" aria-label="${esc(section.addTitle)}">
      <i class="bi ${section.addIcon || 'bi-plus-lg'}"></i></button>
  </${tag}>`;
}

// One group per category: the category entry, then its supplies. A filter matching
// the category shows all its supplies; otherwise only matching supplies are shown.
function treeHtml(section, q) {
  const groups = new Map(store.categories.map((c) => [c.id, []]));
  for (const sup of store.supplies) {
    if (sup.archived) continue;
    (groups.get(sup.default_category_id) ?? groups.get(UNCATEGORIZED_ID))?.push(sup);
  }
  const matches = (o) => o.display_name.toLowerCase().includes(q);
  return store.categories
    .map((cat) => {
      const all = groups.get(cat.id);
      const supplies = !q || matches(cat) ? all : all.filter(matches);
      if (q && !supplies.length && !matches(cat)) return '';
      const open = !!q || !collapsedCats.has(cat.id);
      return `<li class="lib-group" data-category-id="${cat.id}">
        <div class="lib-cat-row">
          <button type="button" class="btn btn-icon lib-cat-toggle" data-act="toggle-cat" aria-expanded="${open}"
            aria-label="${open ? 'Collapse' : 'Expand'} ${esc(cat.display_name)}"${all.length ? '' : ' disabled'}>
            <i class="bi bi-chevron-right lib-chevron"></i></button>
          ${entryHtml(section, cat, `${plural(all.length, 'supply', 'supplies')}${cat.builtin ? ' · built-in' : ''}`, 'div')}
        </div>
        ${open && supplies.length ? `<ul class="lib-sublist">${supplies.map((x) => entryHtml(SUPPLY_ENTRY, x)).join('')}</ul>` : ''}
      </li>`;
    })
    .join('');
}

function renderList(section) {
  const ul = document.querySelector(`[data-section="${section.type}"] .lib-list`);
  const q = (filters[section.type] || '').trim().toLowerCase();
  let html;
  if (section.tree) {
    html = treeHtml(section, q);
  } else {
    const items = section.list(store).filter((o) => !q || o.display_name.toLowerCase().includes(q));
    html = items.map((o) => entryHtml(section, o)).join('');
  }
  ul.innerHTML = html || `<li class="lib-empty">${q ? 'No matches' : 'Nothing yet — use + to create one'}</li>`;
  ul.closest('[data-section]').querySelector('.lib-count').textContent = (section.count ?? ((s) => section.list(s).length))(store);
}

function renderUserPicker() {
  const sel = document.getElementById('currentUser');
  sel.innerHTML =
    `<option value="">— pick yourself —</option>` +
    store.users.map((u) => `<option value="${u.id}"${u.id === store.currentUserId ? ' selected' : ''}>${esc(u.display_name)}</option>`).join('');
}

export function renderSidebar() {
  renderUserPicker();
  SECTIONS.forEach(renderList);
}

export function initSidebar() {
  const root = document.getElementById('library');
  root.innerHTML = SECTIONS.map(
    (s) => `<section class="lib-section" data-section="${s.type}">
      <div class="lib-header">
        <button type="button" class="lib-toggle" aria-expanded="${!!expanded[s.type]}" data-act="toggle">
          <i class="bi bi-chevron-right lib-chevron"></i><i class="bi ${s.icon}"></i>
          <span>${s.title}</span><span class="badge rounded-pill text-bg-secondary lib-count"${s.countTitle ? ` title="${s.countTitle}"` : ''}>0</span>
        </button>
        <button type="button" class="btn btn-icon" data-act="create" title="${s.create ? 'New…' : `New ${s.title.replace(/s$/, '').toLowerCase()}`}" aria-label="Create">
          <i class="bi bi-plus-lg"></i></button>
      </div>
      <div class="lib-body"${expanded[s.type] ? '' : ' hidden'}>
        <input type="search" class="form-control form-control-sm lib-filter" placeholder="Filter ${s.title.toLowerCase()}…" aria-label="Filter ${s.title}">
        <ul class="lib-list"></ul>
      </div>
    </section>`,
  ).join('');

  root.addEventListener('click', (e) => {
    const sectionEl = e.target.closest('[data-section]');
    if (!sectionEl) return;
    const type = sectionEl.dataset.section;
    const section = SECTIONS.find((s) => s.type === type);
    const actEl = e.target.closest('[data-act]');
    const act = actEl?.dataset.act;
    if (act === 'toggle') {
      const body = sectionEl.querySelector('.lib-body');
      body.hidden = !body.hidden;
      expanded[type] = !body.hidden;
      sectionEl.querySelector('.lib-toggle').setAttribute('aria-expanded', String(!body.hidden));
      storage.set('sidebarExpanded', expanded);
    } else if (act === 'create') {
      if (section.create) {
        showContextMenu(actEl, section.create.map((c) => ({ ...c, action: () => createEntity(c.type) })));
      } else {
        createEntity(type);
      }
    } else if (act === 'toggle-cat') {
      const id = actEl.closest('.lib-group').dataset.categoryId;
      if (collapsedCats.has(id)) collapsedCats.delete(id);
      else collapsedCats.add(id);
      storage.set('sidebarCollapsedCategories', [...collapsedCats]);
      renderList(section);
    } else if (act === 'add') {
      const entry = actEl.closest('.lib-entry');
      addToTrip(entry.dataset.dragType, entry.dataset.dragId);
    }
  });
  root.addEventListener('dblclick', (e) => {
    const entry = e.target.closest('.lib-entry');
    if (entry && !e.target.closest('[data-act]')) editEntity(entry.dataset.dragType, entry.dataset.dragId);
  });
  root.addEventListener('keydown', (e) => {
    const entry = e.target.closest('.lib-entry');
    if (entry && e.key === 'Enter' && e.target === entry) addToTrip(entry.dataset.dragType, entry.dataset.dragId);
  });
  root.addEventListener('contextmenu', (e) => {
    const entry = e.target.closest('.lib-entry');
    if (!entry) return;
    showContextMenu(e, entityMenu(entry.dataset.dragType, entry.dataset.dragId));
  });
  root.addEventListener('input', (e) => {
    if (!e.target.classList.contains('lib-filter')) return;
    const type = e.target.closest('[data-section]').dataset.section;
    filters[type] = e.target.value;
    renderList(SECTIONS.find((s) => s.type === type));
  });
  makeDraggable(root);

  document.getElementById('currentUser').addEventListener('change', (e) => store.setCurrentUser(e.target.value));
}
