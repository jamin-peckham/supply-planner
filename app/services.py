"""Business rules: validation, cascades and trip composition.

Every public function takes the Database lock, so each call is atomic with
respect to other requests. Objects are deep-copied before mutation so a failed
write never leaves the in-memory cache half-updated.
"""

from collections.abc import Callable
from typing import Any

from pydantic import BaseModel

from .models import (
    UNCATEGORIZED_ID,
    Category,
    CloneIn,
    Contribution,
    ContributionPatch,
    ItemIn,
    ItemMoveIn,
    ItemPatch,
    SetSupply,
    StandardSet,
    StandardSetIn,
    Status,
    Supply,
    SupplyIn,
    Trip,
    TripIn,
    TripItem,
    User,
)
from .storage import Database, Repository


class NotFound(Exception):
    pass


class Invalid(Exception):
    pass


def _require[T: BaseModel](repo: Repository[T], obj_id: str | None, label: str) -> T:
    obj = repo.get(obj_id) if obj_id else None
    if obj is None:
        raise NotFound(f"{label} not found: {obj_id}")
    return obj


def _patch[T: BaseModel](repo: Repository[T], obj_id: str, label: str, patch: BaseModel) -> T:
    obj = _require(repo, obj_id, label)
    changes = {k: v for k, v in patch.model_dump(exclude_unset=True).items() if v is not None}
    updated = obj.model_validate(obj.model_dump() | changes)
    return repo.save(updated)


def _find_by_name[T: BaseModel](repo: Repository[T], name: str) -> T | None:
    key = name.strip().casefold()
    return next((o for o in repo.all() if o.display_name.casefold() == key), None)


# --- Users -------------------------------------------------------------------


def create_user(db: Database, display_name: str, email: str = "") -> User:
    with db.lock:
        return db.users.save(User(display_name=display_name, email=email))


def update_user(db: Database, user_id: str, patch: BaseModel) -> User:
    with db.lock:
        return _patch(db.users, user_id, "User", patch)


def delete_user(db: Database, user_id: str) -> None:
    """Remove the user and clear them from every trip (membership and ownership)."""
    with db.lock:
        _require(db.users, user_id, "User")
        for trip in db.trips.all():
            if user_id in trip.member_ids or any(i.contribution(user_id) for i in trip.items):
                _mutate_trip(db, trip.id, lambda t: _drop_user_from_trip(t, user_id))
        db.users.delete(user_id)


def _drop_user_from_trip(trip: Trip, user_id: str) -> None:
    trip.member_ids = [m for m in trip.member_ids if m != user_id]
    for item in trip.items:
        item.contributions = [c for c in item.contributions if c.owner_id != user_id]


# --- Categories --------------------------------------------------------------


def create_category(db: Database, display_name: str, description: str = "") -> Category:
    with db.lock:
        return db.categories.save(Category(display_name=display_name, description=description))


def find_or_create_category(db: Database, name: str) -> Category:
    with db.lock:
        return _find_by_name(db.categories, name) or create_category(db, name)


def update_category(db: Database, category_id: str, patch: BaseModel) -> Category:
    with db.lock:
        return _patch(db.categories, category_id, "Category", patch)


def _replace_category(ids: list[str], old: str, new: str) -> list[str]:
    out: list[str] = []
    for cid in ids:
        cid = new if cid == old else cid
        if cid not in out:
            out.append(cid)
    return out


def delete_category(db: Database, category_id: str) -> None:
    """Delete a category; everything that used it falls back to Uncategorized."""
    with db.lock:
        category = _require(db.categories, category_id, "Category")
        if category.builtin:
            raise Invalid("The built-in Uncategorized category cannot be deleted")

        for supply in db.supplies.all():
            if supply.default_category_id == category_id:
                db.supplies.save(supply.model_copy(update={"default_category_id": UNCATEGORIZED_ID}))

        for sset in db.standard_sets.all():
            if category_id in sset.category_ids or any(s.category_id == category_id for s in sset.supplies):
                sset = sset.model_copy(deep=True)
                sset.category_ids = _replace_category(sset.category_ids, category_id, UNCATEGORIZED_ID)
                for s in sset.supplies:
                    if s.category_id == category_id:
                        s.category_id = UNCATEGORIZED_ID
                if any(s.category_id == UNCATEGORIZED_ID for s in sset.supplies) and UNCATEGORIZED_ID not in sset.category_ids:
                    sset.category_ids.append(UNCATEGORIZED_ID)
                db.standard_sets.save(sset)

        def move_to_uncategorized(trip: Trip) -> None:
            had_items = False
            for item in trip.items:
                if item.category_id == category_id:
                    item.category_id = UNCATEGORIZED_ID
                    had_items = True
            trip.category_ids = _replace_category(trip.category_ids, category_id, UNCATEGORIZED_ID)
            if had_items and UNCATEGORIZED_ID not in trip.category_ids:
                trip.category_ids.append(UNCATEGORIZED_ID)

        for trip in db.trips.all():
            if category_id in trip.category_ids or any(i.category_id == category_id for i in trip.items):
                _mutate_trip(db, trip.id, move_to_uncategorized)

        db.categories.delete(category_id)


# --- Supplies ----------------------------------------------------------------


def create_supply(db: Database, body: SupplyIn) -> Supply:
    with db.lock:
        _require(db.categories, body.default_category_id, "Category")
        return db.supplies.save(Supply(**body.model_dump()))


def find_or_create_supply(db: Database, name: str, category_id: str | None) -> Supply:
    """Reuse a library supply by (case-insensitive) name, un-archiving it if needed."""
    with db.lock:
        existing = _find_by_name(db.supplies, name)
        if existing:
            if existing.archived:
                existing = db.supplies.save(existing.model_copy(update={"archived": False}))
            return existing
        return create_supply(
            db, SupplyIn(display_name=name, default_category_id=category_id or UNCATEGORIZED_ID)
        )


def update_supply(db: Database, supply_id: str, patch: BaseModel) -> Supply:
    with db.lock:
        if getattr(patch, "default_category_id", None):
            _require(db.categories, patch.default_category_id, "Category")
        return _patch(db.supplies, supply_id, "Supply", patch)


def supply_in_use(db: Database, supply_id: str) -> bool:
    return any(i.supply_id == supply_id for t in db.trips.all() for i in t.items) or any(
        s.supply_id == supply_id for ss in db.standard_sets.all() for s in ss.supplies
    )


def delete_supply(db: Database, supply_id: str) -> dict[str, bool]:
    """Hard-delete an unused supply; archive one that trips or sets still reference."""
    with db.lock:
        supply = _require(db.supplies, supply_id, "Supply")
        if supply_in_use(db, supply_id):
            db.supplies.save(supply.model_copy(update={"archived": True}))
            return {"archived": True, "deleted": False}
        db.supplies.delete(supply_id)
        return {"archived": False, "deleted": True}


# --- Standard sets -----------------------------------------------------------


def _validate_set(db: Database, category_ids: list[str], supplies: list[SetSupply]) -> None:
    for cid in category_ids:
        _require(db.categories, cid, "Category")
    for s in supplies:
        _require(db.supplies, s.supply_id, "Supply")
        _require(db.categories, s.category_id, "Category")


def _normalize_set(sset: StandardSet) -> StandardSet:
    for s in sset.supplies:
        if s.category_id not in sset.category_ids:
            sset.category_ids.append(s.category_id)
    sset.category_ids = list(dict.fromkeys(sset.category_ids))
    return sset


def create_standard_set(db: Database, body: StandardSetIn) -> StandardSet:
    with db.lock:
        _validate_set(db, body.category_ids, body.supplies)
        return db.standard_sets.save(_normalize_set(StandardSet(**body.model_dump())))


def update_standard_set(db: Database, set_id: str, patch: BaseModel) -> StandardSet:
    with db.lock:
        current = _require(db.standard_sets, set_id, "Standard set")
        changes = patch.model_dump(exclude_unset=True)
        merged = StandardSet.model_validate(current.model_dump() | changes)
        _validate_set(db, merged.category_ids, merged.supplies)
        return db.standard_sets.save(_normalize_set(merged))


def delete_standard_set(db: Database, set_id: str) -> None:
    with db.lock:
        _require(db.standard_sets, set_id, "Standard set")
        db.standard_sets.delete(set_id)


def standard_set_from_trip(db: Database, trip_id: str, display_name: str | None) -> StandardSet:
    with db.lock:
        trip = _require(db.trips, trip_id, "Trip")
        seen: dict[tuple[str, str], SetSupply] = {}
        for item in trip.items:
            key = (item.supply_id, item.category_id)
            if key not in seen:
                seen[key] = SetSupply(supply_id=item.supply_id, category_id=item.category_id, count=item.count)
        sset = StandardSet(
            display_name=display_name or f"{trip.display_name} set",
            category_ids=list(trip.category_ids),
            supplies=list(seen.values()),
        )
        return db.standard_sets.save(_normalize_set(sset))


def adopt_trip_categories(db: Database, trip_id: str, category_id: str | None = None) -> dict[str, list[Supply]]:
    """Set each supply's library default category to the card it sits on in a trip.

    Limited to one card when category_id is given. A supply that sits on several
    cards (and no card was named) is ambiguous, so it is reported and left alone.
    """
    with db.lock:
        trip = _require(db.trips, trip_id, "Trip")
        cards: dict[str, set[str]] = {}
        for item in trip.items:
            if category_id is None or item.category_id == category_id:
                cards.setdefault(item.supply_id, set()).add(item.category_id)
        updated, ambiguous = [], []
        for supply_id, cats in cards.items():
            supply = _require(db.supplies, supply_id, "Supply")
            if len(cats) > 1:
                ambiguous.append(supply)
            elif (cid := next(iter(cats))) != supply.default_category_id:
                updated.append(db.supplies.save(supply.model_copy(update={"default_category_id": cid})))
        return {"updated": updated, "ambiguous": ambiguous}


# --- Trips -------------------------------------------------------------------


def _mutate_trip(db: Database, trip_id: str, fn: Callable[[Trip], Any]) -> Trip:
    """Apply fn to a copy of the trip, bump its version and persist it.

    A change that leaves the trip as it was (such as dropping an item back where
    it came from) is not saved, so watching browsers don't refetch for nothing.
    """
    with db.lock:
        original = _require(db.trips, trip_id, "Trip")
        trip = original.model_copy(deep=True)
        fn(trip)
        if trip == original:
            return original
        trip.version += 1
        return db.trips.save(Trip.model_validate(trip.model_dump()))


def _ensure_category(trip: Trip, category_id: str) -> None:
    if category_id not in trip.category_ids:
        trip.category_ids.append(category_id)


def _ensure_member(trip: Trip, user_id: str) -> None:
    if user_id not in trip.member_ids:
        trip.member_ids.append(user_id)


def _find_item(trip: Trip, item_id: str) -> TripItem:
    item = next((i for i in trip.items if i.id == item_id), None)
    if item is None:
        raise NotFound(f"Item not found: {item_id}")
    return item


def _place_items(trip: Trip, item_ids: list[str], category_id: str, before_id: str | None) -> None:
    """Move items into a category, in front of `before_id` or at the end of its card.

    Moved items keep their relative order from the trip.
    """
    wanted = set(item_ids)
    for item_id in wanted:
        _find_item(trip, item_id)
    if before_id in wanted:
        raise Invalid("An item can't be moved in front of itself")
    moving = [i for i in trip.items if i.id in wanted]
    rest = [i for i in trip.items if i.id not in wanted]
    if before_id:
        before = _find_item(trip, before_id)
        if before.category_id != category_id:
            raise Invalid("before_id must be an item in the target category")
        index = rest.index(before)
    else:
        last = max((n for n, i in enumerate(rest) if i.category_id == category_id), default=len(rest) - 1)
        index = last + 1
    for item in moving:
        item.category_id = category_id
    trip.items = rest[:index] + moving + rest[index:]
    _ensure_category(trip, category_id)


def create_trip(db: Database, body: TripIn) -> Trip:
    with db.lock:
        for uid in body.member_ids:
            _require(db.users, uid, "User")
        return db.trips.save(Trip(**body.model_dump()))


def update_trip(db: Database, trip_id: str, patch: BaseModel) -> Trip:
    nullable = {"start_date", "end_date"}
    changes = {
        k: v for k, v in patch.model_dump(exclude_unset=True).items() if v is not None or k in nullable
    }

    def apply(trip: Trip) -> None:
        for key, value in changes.items():
            setattr(trip, key, value)

    return _mutate_trip(db, trip_id, apply)


def delete_trip(db: Database, trip_id: str) -> None:
    with db.lock:
        _require(db.trips, trip_id, "Trip")
        db.trips.delete(trip_id)


def clone_trip(db: Database, trip_id: str, body: CloneIn) -> Trip:
    """Create a new trip using an existing one as a template."""
    with db.lock:
        source = _require(db.trips, trip_id, "Trip")
        keep_owners = body.keep_owners and body.keep_members
        items = [
            TripItem(
                supply_id=i.supply_id,
                category_id=i.category_id,
                count=i.count,
                per_person=i.per_person,
                contributions=[
                    c.model_copy(update={"packed": False, "status": Status.NEEDED if body.reset_status_to_needed else c.status})
                    for c in i.contributions
                ]
                if keep_owners
                else [],
                notes=i.notes,
            )
            for i in source.items
        ]
        trip = Trip(
            display_name=body.display_name,
            description=source.description,
            member_ids=list(source.member_ids) if body.keep_members else [],
            category_ids=list(source.category_ids),
            items=items,
            template_source_id=source.id,
        )
        return db.trips.save(trip)


def add_member(db: Database, trip_id: str, user_id: str) -> Trip:
    with db.lock:
        _require(db.users, user_id, "User")
        return _mutate_trip(db, trip_id, lambda t: _ensure_member(t, user_id))


def remove_member(db: Database, trip_id: str, user_id: str) -> Trip:
    return _mutate_trip(db, trip_id, lambda t: _drop_user_from_trip(t, user_id))


def add_trip_category(db: Database, trip_id: str, category_id: str | None, new_name: str | None) -> Trip:
    with db.lock:
        if category_id:
            _require(db.categories, category_id, "Category")
        elif new_name and new_name.strip():
            category_id = find_or_create_category(db, new_name).id
        else:
            raise Invalid("category_id or new_name is required")
        return _mutate_trip(db, trip_id, lambda t: _ensure_category(t, category_id))


def remove_trip_category(db: Database, trip_id: str, category_id: str) -> Trip:
    """Take a category card off the trip, along with its items."""

    def apply(trip: Trip) -> None:
        trip.category_ids = [c for c in trip.category_ids if c != category_id]
        trip.items = [i for i in trip.items if i.category_id != category_id]

    return _mutate_trip(db, trip_id, apply)


def move_trip_category(db: Database, trip_id: str, category_id: str, before_id: str | None) -> Trip:
    """Reorder a category card: in front of `before_id`, or last."""

    def apply(trip: Trip) -> None:
        if category_id not in trip.category_ids:
            raise NotFound(f"Category not on this trip: {category_id}")
        if before_id == category_id:
            return
        if before_id and before_id not in trip.category_ids:
            raise NotFound(f"Category not on this trip: {before_id}")
        ids = [c for c in trip.category_ids if c != category_id]
        ids.insert(ids.index(before_id) if before_id else len(ids), category_id)
        trip.category_ids = ids

    return _mutate_trip(db, trip_id, apply)


def set_category_packed(db: Database, trip_id: str, category_id: str, packed: bool) -> Trip:
    """Pack or unpack every contribution on a card. Unclaimed items stay as they are."""

    def apply(trip: Trip) -> None:
        for item in trip.items:
            if item.category_id == category_id:
                for c in item.contributions:
                    _set_contribution(c, packed=packed)

    return _mutate_trip(db, trip_id, apply)


# --- Contributions -------------------------------------------------------------


def _set_contribution(c: Contribution, count: int | None = None, status: Status | None = None, packed: bool | None = None) -> None:
    """Update a contribution. Packing implies the person has it; needing it means it isn't packed."""
    if count is not None:
        c.count = count
    if status is not None:
        c.status = status
        if status == Status.NEEDED:
            c.packed = False
    if packed is not None:
        c.packed = packed
        if packed:
            c.status = Status.OWNED


def _default_share(trip: Trip, item: TripItem) -> int:
    """What a new contributor brings by default: one each, or whatever is still missing."""
    if item.per_person:
        return 1
    return max(1, item.target(len(trip.member_ids)) - item.covered())


def _upsert_contribution(trip: Trip, item: TripItem, owner_id: str, patch: ContributionPatch) -> None:
    c = item.contribution(owner_id)
    if c is None:
        c = Contribution(owner_id=owner_id, count=patch.count or _default_share(trip, item))
        item.contributions.append(c)
        _ensure_member(trip, owner_id)
    _set_contribution(c, patch.count, patch.status, patch.packed)


def _clean_contributions(db: Database, contributions: list[Contribution]) -> list[Contribution]:
    """Validate owners and merge duplicates (one contribution per person)."""
    merged: dict[str, Contribution] = {}
    for c in contributions:
        _require(db.users, c.owner_id, "User")
        if c.owner_id in merged:
            merged[c.owner_id].count += c.count
        else:
            merged[c.owner_id] = c.model_copy()
    for c in merged.values():
        _set_contribution(c, status=c.status, packed=c.packed)  # keep packed/status consistent
    return list(merged.values())


def set_contribution(db: Database, trip_id: str, item_id: str, user_id: str, patch: ContributionPatch) -> Trip:
    """Claim (part of) an item for a person, or change their claim. They join the trip."""
    with db.lock:
        _require(db.users, user_id, "User")

        def apply(trip: Trip) -> None:
            _upsert_contribution(trip, _find_item(trip, item_id), user_id, patch)

        return _mutate_trip(db, trip_id, apply)


def remove_contribution(db: Database, trip_id: str, item_id: str, user_id: str) -> Trip:
    def apply(trip: Trip) -> None:
        item = _find_item(trip, item_id)
        if not item.contribution(user_id):
            raise NotFound(f"{user_id} is not bringing this item")
        item.contributions = [c for c in item.contributions if c.owner_id != user_id]

    return _mutate_trip(db, trip_id, apply)


def add_item(db: Database, trip_id: str, body: ItemIn) -> Trip:
    """Add a supply to the trip. Unknown names become new library supplies.

    Without an explicit category the supply's default category is used (or that of
    `before_id`, the item it lands in front of), and that category is added to the
    trip if it isn't there yet. A supply appears once per card: adding it to a card
    that already has it only adds the owner's claim, if one is given.
    """
    with db.lock:
        trip = _require(db.trips, trip_id, "Trip")
        if body.category_id:
            _require(db.categories, body.category_id, "Category")
        before = _find_item(trip, body.before_id) if body.before_id else None
        if before and body.category_id and before.category_id != body.category_id:
            raise Invalid("before_id must be an item in the target category")
        if body.supply_id:
            supply = _require(db.supplies, body.supply_id, "Supply")
        elif body.new_name and body.new_name.strip():
            supply = find_or_create_supply(db, body.new_name, body.category_id)
        else:
            raise Invalid("supply_id or new_name is required")
        if body.owner_id:
            _require(db.users, body.owner_id, "User")

        category_id = body.category_id or (before and before.category_id) or supply.default_category_id
        if category_id not in db.categories:
            category_id = UNCATEGORIZED_ID
        claim = ContributionPatch(count=body.count, status=body.status)

        def apply(trip: Trip) -> None:
            _ensure_category(trip, category_id)
            existing = next((i for i in trip.items if i.supply_id == supply.id and i.category_id == category_id), None)
            if existing:
                if body.owner_id:
                    _upsert_contribution(trip, existing, body.owner_id, claim)
                    existing.count = max(existing.count, existing.covered())  # "another one", not a duplicate row
                return
            item = TripItem(
                supply_id=supply.id,
                category_id=category_id,
                count=body.count or supply.default_count,
                per_person=supply.per_person if body.per_person is None else body.per_person,
            )
            trip.items.append(item)
            if body.owner_id:
                _upsert_contribution(trip, item, body.owner_id, claim.model_copy(update={"count": None}))
            if body.before_id:
                _place_items(trip, [item.id], category_id, body.before_id)

        return _mutate_trip(db, trip_id, apply)


def update_item(db: Database, trip_id: str, item_id: str, patch: ItemPatch) -> Trip:
    with db.lock:
        changes = {k: v for k, v in patch.model_dump(exclude_unset=True).items() if v is not None}
        if "category_id" in changes:
            _require(db.categories, changes["category_id"], "Category")
        status, packed = changes.pop("status", None), changes.pop("packed", None)
        if patch.contributions is not None:
            changes["contributions"] = _clean_contributions(db, patch.contributions)

        def apply(trip: Trip) -> None:
            item = _find_item(trip, item_id)
            old_category = item.category_id
            for key, value in changes.items():
                setattr(item, key, value)
            for c in item.contributions:
                _ensure_member(trip, c.owner_id)
                _set_contribution(c, status=status, packed=packed)
            if item.category_id != old_category:
                _place_items(trip, [item.id], item.category_id, None)  # lands at the end of its new card
            _ensure_category(trip, item.category_id)

        return _mutate_trip(db, trip_id, apply)


def move_items(db: Database, trip_id: str, body: ItemMoveIn) -> Trip:
    """Move items to a position in a category card (reorder and/or recategorize)."""
    with db.lock:
        _require(db.categories, body.category_id, "Category")
        return _mutate_trip(db, trip_id, lambda t: _place_items(t, body.item_ids, body.category_id, body.before_id))


def delete_item(db: Database, trip_id: str, item_id: str) -> Trip:
    def apply(trip: Trip) -> None:
        _find_item(trip, item_id)
        trip.items = [i for i in trip.items if i.id != item_id]

    return _mutate_trip(db, trip_id, apply)


def apply_standard_set(db: Database, trip_id: str, set_id: str) -> Trip:
    """Merge a standard set into a trip, skipping supplies already in the same category."""
    with db.lock:
        sset = _require(db.standard_sets, set_id, "Standard set")

        def apply(trip: Trip) -> None:
            for cid in sset.category_ids:
                if cid in db.categories:
                    _ensure_category(trip, cid)
            existing = {(i.supply_id, i.category_id) for i in trip.items}
            for s in sset.supplies:
                if s.supply_id not in db.supplies or (s.supply_id, s.category_id) in existing:
                    continue
                cid = s.category_id if s.category_id in db.categories else UNCATEGORIZED_ID
                _ensure_category(trip, cid)
                per_person = db.supplies.get(s.supply_id).per_person
                trip.items.append(TripItem(supply_id=s.supply_id, category_id=cid, count=s.count, per_person=per_person))
                existing.add((s.supply_id, cid))

        return _mutate_trip(db, trip_id, apply)
