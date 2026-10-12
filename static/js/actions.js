// Operations shared by the sidebar and the board: create, edit, remove and
// "add to trip" for every library object type.
import { api } from './api.js';
import * as modals from './modals.js';
import { store } from './store.js';
import { toast } from './ui.js';

export const TYPES = {
  trip: { label: 'Trip', path: 'trips', map: 'trips', edit: modals.editTrip },
  user: { label: 'User', path: 'users', map: 'users', edit: modals.editUser },
  category: { label: 'Category', path: 'categories', map: 'categories', edit: modals.editCategory },
  supply: { label: 'Supply', path: 'supplies', map: 'supplies', edit: modals.editSupply },
  set: { label: 'Standard set', path: 'standard-sets', map: 'sets', edit: modals.editSet },
};

const get = (type, id) => store.maps[TYPES[type].map].get(id);

function requireTrip() {
  if (!store.trip) {
    toast('Open or create a trip first.', 'warning');
    return null;
  }
  return store.trip;
}

export async function createEntity(type) {
  const created = await TYPES[type].edit();
  if (!created) return;
  await store.loadAll();
  if (type === 'trip') store.openTrip(created.id);
  if (type === 'user' && !store.currentUserId) store.setCurrentUser(created.id);
}

export async function editEntity(type, id) {
  const obj = get(type, id);
  if (obj && (await TYPES[type].edit(obj))) await store.loadAll();
}

const REMOVE_MESSAGES = {
  trip: (n) => `Delete the trip “${n}”? This cannot be undone.`,
  user: (n) => `Remove ${n}? They will leave every trip and their items become unassigned.`,
  category: (n) => `Delete the category “${n}”? Its supplies move to Uncategorized in the library, trips and sets.`,
  supply: (n) => `Delete the supply “${n}”? If a trip or set still uses it, it is archived instead.`,
  set: (n) => `Delete the standard set “${n}”? Trips it was applied to are not changed.`,
};

export async function removeEntity(type, id) {
  const obj = get(type, id);
  if (!obj) return;
  if (!(await modals.confirmDialog(REMOVE_MESSAGES[type](obj.display_name)))) return;
  const result = await api.del(`/${TYPES[type].path}/${id}`);
  if (type === 'supply' && result?.archived) toast(`“${obj.display_name}” is still used, so it was archived.`, 'info');
  if (type === 'trip' && store.trip?.id === id) store.openTrip(null);
  if (type === 'user' && store.currentUserId === id) store.setCurrentUser(null);
  await store.loadAll();
}

/** Put a library object onto the open trip. `categoryId` targets a specific card for supplies. */
export async function addToTrip(type, id, { categoryId } = {}) {
  if (type === 'trip') return store.openTrip(id);
  const trip = requireTrip();
  if (!trip) return;
  const base = `/trips/${trip.id}`;
  let updated;
  switch (type) {
    case 'user':
      updated = await api.post(`${base}/members/${id}`);
      break;
    case 'category':
      updated = await api.post(`${base}/categories`, { category_id: id });
      break;
    case 'supply':
      updated = await api.post(`${base}/items`, { supply_id: id, category_id: categoryId ?? null });
      break;
    case 'set':
      updated = await api.post(`${base}/apply-set/${id}`);
      toast(`Applied “${store.name('sets', id)}”.`, 'success');
      break;
    default:
      return;
  }
  store.setTrip(updated);
}

/** Run a trip mutation and push the returned trip into the store. */
export async function tripCall(method, path, body) {
  const trip = requireTrip();
  if (!trip) return;
  store.setTrip(await api[method](`/trips/${trip.id}${path}`, body));
}

export function entityMenu(type, id) {
  const obj = get(type, id);
  if (!obj) return [];
  const isOpenTrip = type === 'trip' && store.trip?.id === id;
  const items = [
    {
      label: type === 'trip' ? (isOpenTrip ? 'Already open' : 'Open') : 'Add to trip',
      icon: type === 'trip' ? 'bi-box-arrow-in-right' : 'bi-plus-lg',
      disabled: isOpenTrip || (type !== 'trip' && !store.trip),
      action: () => addToTrip(type, id),
    },
    { label: 'Edit…', icon: 'bi-pencil', action: () => editEntity(type, id) },
  ];
  if (type === 'trip') {
    items.push(
      { label: 'Use as template…', icon: 'bi-copy', action: () => cloneFrom(obj) },
      { label: 'Save as standard set…', icon: 'bi-collection', action: () => saveAsSet(obj) },
    );
  }
  if (type === 'user') {
    items.push({
      label: store.currentUserId === id ? 'This is me' : 'Set as me',
      icon: 'bi-person-check',
      disabled: store.currentUserId === id,
      action: () => store.setCurrentUser(id),
    });
  }
  items.push('divider', {
    label: type === 'category' && obj.builtin ? 'Built-in (cannot delete)' : 'Remove…',
    icon: 'bi-trash',
    danger: true,
    disabled: type === 'category' && obj.builtin,
    action: () => removeEntity(type, id),
  });
  return items;
}

export async function cloneFrom(trip) {
  const created = await modals.cloneTrip(trip);
  if (!created) return;
  await store.loadAll();
  store.openTrip(created.id);
}

export async function saveAsSet(trip) {
  if (await modals.setFromTrip(trip)) {
    toast('Standard set saved.', 'success');
    await store.loadAll();
  }
}
