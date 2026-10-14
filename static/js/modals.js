// Modal dialogs: a generic form builder, a confirm dialog and an editor per object type.
import { api } from './api.js';
import { store, UNCATEGORIZED_ID } from './store.js';
import { esc } from './ui.js';

let seq = 0;

function optionList(options, selected) {
  return options
    .map((o) => `<option value="${esc(o.value)}"${o.value === selected ? ' selected' : ''}>${esc(o.label)}</option>`)
    .join('');
}

function fieldHtml(f) {
  const id = `f${++seq}-${f.name}`;
  const req = f.required ? ' required' : '';
  const help = f.help ? `<div class="form-text">${esc(f.help)}</div>` : '';
  switch (f.type) {
    case 'checkbox':
      return `<div class="form-check mb-3"><input class="form-check-input" type="checkbox" id="${id}" name="${f.name}"${f.value ? ' checked' : ''}>
        <label class="form-check-label" for="${id}">${esc(f.label)}</label>${help}</div>`;
    case 'select':
      return `<div class="mb-3"><label class="form-label" for="${id}">${esc(f.label)}</label>
        <select class="form-select" id="${id}" name="${f.name}"${req}>${optionList(f.options, f.value ?? '')}</select>${help}</div>`;
    case 'textarea':
      return `<div class="mb-3"><label class="form-label" for="${id}">${esc(f.label)}</label>
        <textarea class="form-control" id="${id}" name="${f.name}" rows="2"${req}>${esc(f.value)}</textarea>${help}</div>`;
    case 'custom':
      return `<div class="mb-3" data-custom="${f.name}">${f.label ? `<div class="form-label">${esc(f.label)}</div>` : ''}${f.render()}</div>`;
    default: {
      const min = f.min !== undefined ? ` min="${f.min}"` : '';
      const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
      return `<div class="mb-3"><label class="form-label" for="${id}">${esc(f.label)}</label>
        <input class="form-control" type="${f.type || 'text'}" id="${id}" name="${f.name}" value="${esc(f.value)}"${min}${ph}${req}>${help}</div>`;
    }
  }
}

function readField(form, f) {
  if (f.type === 'custom') return f.read(form.querySelector(`[data-custom="${f.name}"]`));
  const el = form.elements[f.name];
  if (f.type === 'checkbox') return el.checked;
  if (f.type === 'number') return el.value === '' ? null : Number(el.value);
  if (f.type === 'date') return el.value || null;
  return el.value;
}

/**
 * Show a form in a modal. Resolves with onSubmit's result, or null if cancelled.
 * If onSubmit throws, the modal stays open so the user can correct the input.
 */
export function formModal({ title, fields, submitLabel = 'Save', size = '', danger = false, onSubmit }) {
  return new Promise((resolve) => {
    const host = document.getElementById('modalHost');
    const wrap = document.createElement('div');
    wrap.className = 'modal fade';
    wrap.tabIndex = -1;
    wrap.innerHTML = `
      <div class="modal-dialog modal-dialog-scrollable ${size}">
        <form class="modal-content" novalidate>
          <div class="modal-header"><h1 class="modal-title fs-5">${esc(title)}</h1>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>
          <div class="modal-body">${fields.map(fieldHtml).join('')}</div>
          <div class="modal-footer">
            <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
            <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(submitLabel)}</button>
          </div>
        </form>
      </div>`;
    host.append(wrap);
    const form = wrap.querySelector('form');
    for (const f of fields) f.mount?.(form.querySelector(`[data-custom="${f.name}"]`));

    const modal = new bootstrap.Modal(wrap);
    let result = null;
    store.hold();
    wrap.addEventListener('shown.bs.modal', () => form.querySelector('input:not([type=checkbox]),select,textarea')?.focus());
    wrap.addEventListener('hidden.bs.modal', () => {
      modal.dispose();
      wrap.remove();
      store.release();
      resolve(result);
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!form.checkValidity()) {
        form.classList.add('was-validated');
        return;
      }
      const values = Object.fromEntries(fields.map((f) => [f.name, readField(form, f)]));
      const btn = form.querySelector('[type=submit]');
      btn.disabled = true;
      try {
        result = onSubmit ? await onSubmit(values) : values;
        modal.hide();
      } catch {
        btn.disabled = false; // error already shown as a toast
      }
    });
    modal.show();
  });
}

export async function confirmDialog(message, { title = 'Are you sure?', confirmLabel = 'Remove', danger = true } = {}) {
  const ok = await formModal({
    title,
    submitLabel: confirmLabel,
    danger,
    fields: [{ name: 'msg', type: 'custom', render: () => `<p class="mb-0">${esc(message)}</p>`, read: () => true }],
  });
  return ok !== null;
}

const categoryOptions = () => store.categories.map((c) => ({ value: c.id, label: c.display_name }));
const userOptions = () => [{ value: '', label: '— none —' }, ...store.users.map((u) => ({ value: u.id, label: u.display_name }))];

// --- Library editors ---------------------------------------------------------

export function editUser(user = null) {
  return formModal({
    title: user ? `Edit ${user.display_name}` : 'New user',
    submitLabel: user ? 'Save' : 'Create',
    fields: [
      { name: 'display_name', label: 'Display name', value: user?.display_name ?? '', required: true },
      { name: 'email', label: 'Email', type: 'email', value: user?.email ?? '' },
    ],
    onSubmit: (v) => (user ? api.patch(`/users/${user.id}`, v) : api.post('/users', v)),
  });
}

export function editCategory(category = null) {
  return formModal({
    title: category ? `Edit ${category.display_name}` : 'New category',
    submitLabel: category ? 'Save' : 'Create',
    fields: [
      { name: 'display_name', label: 'Name', value: category?.display_name ?? '', required: true },
      { name: 'description', label: 'Description', type: 'textarea', value: category?.description ?? '' },
    ],
    onSubmit: (v) => (category ? api.patch(`/categories/${category.id}`, v) : api.post('/categories', v)),
  });
}

export function editSupply(supply = null, preset = {}) {
  return formModal({
    title: supply ? `Edit ${supply.display_name}` : 'New supply',
    submitLabel: supply ? 'Save' : 'Create',
    fields: [
      { name: 'display_name', label: 'Name', value: supply?.display_name ?? '', required: true },
      {
        name: 'default_category_id',
        label: 'Default category',
        type: 'select',
        options: categoryOptions(),
        value: supply?.default_category_id ?? preset.default_category_id ?? UNCATEGORIZED_ID,
        help: 'Used when the supply is added to a trip without picking a category.',
      },
      { name: 'default_count', label: 'Default count', type: 'number', min: 1, value: supply?.default_count ?? 1, required: true },
      { name: 'notes', label: 'Notes', type: 'textarea', value: supply?.notes ?? '' },
    ],
    onSubmit: (v) => (supply ? api.patch(`/supplies/${supply.id}`, v) : api.post('/supplies', v)),
  });
}

function setSuppliesField(initial) {
  const supplies = store.supplies.filter((s) => !s.archived || initial.some((r) => r.supply_id === s.id));
  const row = (r = {}) => {
    const supplyId = r.supply_id ?? supplies[0]?.id ?? '';
    const catId = r.category_id ?? store.maps.supplies.get(supplyId)?.default_category_id ?? UNCATEGORIZED_ID;
    return `<div class="set-row d-flex gap-2 mb-2">
      <select class="form-select form-select-sm" data-k="supply_id" aria-label="Supply">${optionList(
        supplies.map((s) => ({ value: s.id, label: s.display_name })),
        supplyId,
      )}</select>
      <select class="form-select form-select-sm" data-k="category_id" aria-label="Category">${optionList(categoryOptions(), catId)}</select>
      <input class="form-control form-control-sm set-count" type="number" min="1" value="${r.count ?? 1}" data-k="count" aria-label="Count">
      <button type="button" class="btn btn-sm btn-outline-danger" data-remove-row aria-label="Remove row"><i class="bi bi-x-lg"></i></button>
    </div>`;
  };
  return {
    name: 'supplies',
    label: 'Supplies',
    type: 'custom',
    render: () =>
      supplies.length
        ? `<div class="set-rows">${initial.map(row).join('')}</div>
           <button type="button" class="btn btn-sm btn-outline-primary" data-add-row><i class="bi bi-plus-lg"></i> Add supply</button>`
        : '<p class="text-body-secondary small mb-0">Create some supplies first.</p>',
    mount(el) {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-add-row]')) el.querySelector('.set-rows').insertAdjacentHTML('beforeend', row());
        e.target.closest('[data-remove-row]')?.closest('.set-row').remove();
      });
      el.addEventListener('change', (e) => {
        if (e.target.dataset.k !== 'supply_id') return;
        const cat = store.maps.supplies.get(e.target.value)?.default_category_id;
        if (cat) e.target.closest('.set-row').querySelector('[data-k=category_id]').value = cat;
      });
    },
    read: (el) =>
      [...el.querySelectorAll('.set-row')].map((r) => ({
        supply_id: r.querySelector('[data-k=supply_id]').value,
        category_id: r.querySelector('[data-k=category_id]').value,
        count: Math.max(1, Number(r.querySelector('[data-k=count]').value) || 1),
      })),
  };
}

function categoryChecklist(name, label, selected) {
  return {
    name,
    label,
    type: 'custom',
    render: () =>
      `<div class="check-list">${store.categories
        .map(
          (c) => `<div class="form-check"><input class="form-check-input" type="checkbox" value="${c.id}" id="cc-${c.id}"${
            selected.includes(c.id) ? ' checked' : ''
          }><label class="form-check-label" for="cc-${c.id}">${esc(c.display_name)}</label></div>`,
        )
        .join('')}</div>`,
    read: (el) => [...el.querySelectorAll('input:checked')].map((i) => i.value),
  };
}

export function editSet(set = null) {
  return formModal({
    title: set ? `Edit ${set.display_name}` : 'New standard set',
    submitLabel: set ? 'Save' : 'Create',
    size: 'modal-lg',
    fields: [
      { name: 'display_name', label: 'Name', value: set?.display_name ?? '', required: true },
      { name: 'description', label: 'Description', type: 'textarea', value: set?.description ?? '' },
      setSuppliesField(set?.supplies ?? []),
      categoryChecklist('category_ids', 'Categories (added to the trip even when empty)', set?.category_ids ?? []),
    ],
    onSubmit: (v) => (set ? api.patch(`/standard-sets/${set.id}`, v) : api.post('/standard-sets', v)),
  });
}

export function editTrip(trip = null) {
  const fields = [
    { name: 'display_name', label: 'Trip name', value: trip?.display_name ?? '', required: true },
    { name: 'description', label: 'Description', type: 'textarea', value: trip?.description ?? '' },
    { name: 'start_date', label: 'Start date', type: 'date', value: trip?.start_date ?? '' },
    { name: 'end_date', label: 'End date', type: 'date', value: trip?.end_date ?? '' },
  ];
  if (!trip && store.currentUserId) {
    fields.push({ name: 'join', label: `Add me (${store.name('users', store.currentUserId)}) as a member`, type: 'checkbox', value: true });
  }
  return formModal({
    title: trip ? `Edit ${trip.display_name}` : 'New trip',
    submitLabel: trip ? 'Save' : 'Create',
    fields,
    onSubmit: ({ join, ...v }) =>
      trip ? api.patch(`/trips/${trip.id}`, v) : api.post('/trips', { ...v, member_ids: join ? [store.currentUserId] : [] }),
  });
}

export function cloneTrip(trip) {
  return formModal({
    title: `New trip from “${trip.display_name}”`,
    submitLabel: 'Create trip',
    fields: [
      { name: 'display_name', label: 'New trip name', value: `${trip.display_name} (copy)`, required: true },
      { name: 'keep_members', label: 'Keep members', type: 'checkbox', value: true },
      { name: 'keep_owners', label: 'Keep item owners (requires keeping members)', type: 'checkbox', value: false },
      { name: 'reset_status_to_needed', label: 'Reset every item to “needed”', type: 'checkbox', value: false },
    ],
    onSubmit: (v) => api.post(`/trips/${trip.id}/clone`, v),
  });
}

export function setFromTrip(trip) {
  return formModal({
    title: 'Save as standard set',
    submitLabel: 'Save set',
    fields: [{ name: 'display_name', label: 'Set name', value: `${trip.display_name} set`, required: true }],
    onSubmit: (v) => api.post(`/standard-sets/from-trip/${trip.id}?display_name=${encodeURIComponent(v.display_name)}`),
  });
}

export function editItem(trip, item) {
  return formModal({
    title: store.name('supplies', item.supply_id),
    fields: [
      { name: 'count', label: 'Count', type: 'number', min: 1, value: item.count, required: true },
      {
        name: 'status',
        label: 'Status',
        type: 'select',
        value: item.status,
        options: [
          { value: 'needed', label: 'Needed' },
          { value: 'owned', label: 'Owned' },
        ],
      },
      { name: 'owner_id', label: 'Owner', type: 'select', options: userOptions(), value: item.owner_id ?? '', help: 'Owners join the trip automatically.' },
      { name: 'category_id', label: 'Category', type: 'select', options: categoryOptions(), value: item.category_id },
      { name: 'packed', label: 'Packed', type: 'checkbox', value: item.packed },
      { name: 'notes', label: 'Notes', type: 'textarea', value: item.notes ?? '' },
    ],
    onSubmit: (v) => api.patch(`/trips/${trip.id}/items/${item.id}`, { ...v, owner_id: v.owner_id || null }),
  });
}
