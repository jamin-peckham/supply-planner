// Client-side state: the library cache, the open trip and the current user.
// Polls /api/revision and refetches when anything changed on the server.
import { api } from './api.js';
import { storage } from './ui.js';

export const UNCATEGORIZED_ID = '00000000-0000-0000-0000-000000000001';
const POLL_MS = 3000;

const byId = (list) => new Map(list.map((o) => [o.id, o]));

export const store = {
  users: [],
  categories: [],
  supplies: [],
  sets: [],
  trips: [],
  maps: { users: new Map(), categories: new Map(), supplies: new Map(), sets: new Map(), trips: new Map() },
  trip: null,
  currentUserId: storage.get('currentUserId'),
  revision: null,
  // Re-renders are deferred while the user is mid-interaction (drag, modal, menu).
  busy: 0,
  _pendingRender: false,
  _listeners: [],

  subscribe(fn) {
    this._listeners.push(fn);
  },

  emit() {
    if (this.busy > 0) {
      this._pendingRender = true;
      return;
    }
    this._pendingRender = false;
    for (const fn of this._listeners) fn(this);
  },

  hold() {
    this.busy += 1;
  },

  release() {
    this.busy = Math.max(0, this.busy - 1);
    if (this.busy === 0 && this._pendingRender) this.emit();
  },

  name(kind, id) {
    return this.maps[kind].get(id)?.display_name ?? '(deleted)';
  },

  async loadAll() {
    const [rev, users, categories, supplies, sets, trips] = await Promise.all([
      api.get('/revision'),
      api.get('/users'),
      api.get('/categories'),
      api.get('/supplies?include_archived=true'),
      api.get('/standard-sets'),
      api.get('/trips'),
    ]);
    Object.assign(this, { users, categories, supplies, sets, trips, revision: rev.revision });
    this.maps = {
      users: byId(users),
      categories: byId(categories),
      supplies: byId(supplies),
      sets: byId(sets),
      trips: byId(trips),
    };
    if (this.currentUserId && !this.maps.users.has(this.currentUserId)) this.setCurrentUser(null, false);
    if (this.trip) this.trip = this.maps.trips.get(this.trip.id) ?? null;
    this.emit();
  },

  // Called with the trip returned by any trip mutation, so the board updates immediately.
  setTrip(trip) {
    this.trip = trip;
    if (trip) {
      this.maps.trips.set(trip.id, trip);
      const i = this.trips.findIndex((t) => t.id === trip.id);
      if (i >= 0) this.trips[i] = trip;
    }
    this.emit();
  },

  openTrip(id) {
    this.trip = id ? this.maps.trips.get(id) ?? null : null;
    storage.set('openTripId', this.trip?.id ?? null);
    const hash = this.trip ? `#/trip/${this.trip.id}` : '#/';
    if (location.hash !== hash) history.replaceState(null, '', hash);
    this.emit();
  },

  setCurrentUser(id, notify = true) {
    this.currentUserId = id || null;
    storage.set('currentUserId', this.currentUserId);
    if (notify) this.emit();
  },

  async poll() {
    try {
      const { revision } = await fetch('/api/revision').then((r) => r.json());
      if (revision !== this.revision) await this.loadAll();
    } catch {
      /* server unreachable; try again next tick */
    }
  },

  startPolling() {
    setInterval(() => {
      if (!document.hidden) this.poll();
    }, POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.poll();
    });
  },
};

// --- Trip item arithmetic ----------------------------------------------------------
// An item needs `count` (or one per member when per_person); contributions say who
// brings how many, each with its own status and packed flag.

export const target = (trip, item) => (item.per_person ? trip.member_ids.length : item.count);
export const covered = (item) => item.contributions.reduce((n, c) => n + c.count, 0);
export const isShort = (trip, item) => covered(item) < target(trip, item);
export const contributionOf = (item, userId) => item.contributions.find((c) => c.owner_id === userId) ?? null;

/** Fully packed: enough people claimed it and every claim is packed. */
export const isPacked = (trip, item) =>
  item.contributions.length > 0 && !isShort(trip, item) && item.contributions.every((c) => c.packed);

/** Members who haven't claimed their own one of a per-person item. */
export const openSlots = (trip, item) =>
  item.per_person ? trip.member_ids.filter((id) => !contributionOf(item, id)) : [];
