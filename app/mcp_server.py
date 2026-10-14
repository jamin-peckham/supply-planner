"""MCP server exposing the planner to AI agents.

Tools are designed for a model rather than mirroring REST: every reference
accepts a display name *or* a GUID, results use names instead of bare GUIDs,
and item operations are bulk. All writes go through `services`, so browsers
viewing a trip see agent edits on their next poll.

Served in-process at /mcp (streamable HTTP). It must share the process with the
REST API because storage relies on one in-process lock and cache.
"""

import hmac
import os
from collections.abc import Callable
from datetime import date
from functools import wraps
from typing import Any, Literal

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field, ValidationError
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.types import Receive, Scope, Send

from . import services as svc
from .models import (
    UNCATEGORIZED_ID,
    CloneIn,
    ContributionPatch,
    ItemIn,
    ItemMoveIn,
    ItemPatch,
    Status,
    SupplyIn,
    Trip,
    TripIn,
    TripItem,
    TripPatch,
)
from .storage import Database, Repository, get_db

INSTRUCTIONS = """\
Trip Supply Planner: a shared library of users, categories, supplies and standard sets,
composed into trips. Each trip item is a library supply with a target count (or one per
member when per_person) and contributions: who brings how many, each with its own status
(needed = still to buy, owned) and packed flag. Several people can share one item, e.g.
Alice brings 4 of 6 water jugs and Bob 2. Refer to anything by display name or id. Typical flow:
list_trips / get_trip to orient, search_library to reuse existing supplies and standard sets,
then add_items / update_items in bulk. trip_gaps shows what still needs attention.
People watching the trip in a browser see your changes within a few seconds."""

mcp = MCPServer("supply-planner", title="Trip Supply Planner", instructions=INSTRUCTIONS)

READ = ToolAnnotations(read_only_hint=True, open_world_hint=False)
WRITE = ToolAnnotations(read_only_hint=False, destructive_hint=False, open_world_hint=False)
REMOVE = ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=False)


def _tool_errors[F: Callable[..., Any]](fn: F) -> F:
    """Turn domain errors into ToolErrors so the model sees the message."""

    @wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return fn(*args, **kwargs)
        except (svc.NotFound, svc.Invalid) as e:
            raise ToolError(str(e)) from e
        except ValidationError as e:
            raise ToolError("; ".join(err["msg"] for err in e.errors())) from e

    return wrapper  # type: ignore[return-value]


# --- Name/id resolution --------------------------------------------------------


def _resolve[T: BaseModel](repo: Repository[T], ref: str, label: str) -> T:
    ref = ref.strip()
    if obj := repo.get(ref):
        return obj
    key = ref.casefold()
    matches = [o for o in repo.all() if o.display_name.casefold() == key]
    if not matches:
        matches = [o for o in repo.all() if key in o.display_name.casefold()]
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise ToolError(f"No {label} matches '{ref}'.")
    names = ", ".join(f"'{m.display_name}' ({m.id})" for m in matches[:10])
    raise ToolError(f"'{ref}' matches several {label}s: {names}. Use the exact name or id.")


def _trip(db: Database, ref: str) -> Trip:
    return _resolve(db.trips, ref, "trip")


def _user_id(db: Database, ref: str | None) -> str | None:
    if ref is None or ref.strip().lower() in ("", "none", "nobody", "unassigned"):
        return None
    return _resolve(db.users, ref, "user").id


def _category_id(db: Database, ref: str) -> str:
    """Resolve a category by id/exact name, creating it when the name is new."""
    if obj := db.categories.get(ref.strip()):
        return obj.id
    return svc.find_or_create_category(db, ref).id


def _item(db: Database, trip: Trip, ref: str) -> str:
    """Resolve a trip item by item id or by its supply's name."""
    if any(i.id == ref for i in trip.items):
        return ref
    key = ref.strip().casefold()
    matches = [i for i in trip.items if _name(db.supplies, i.supply_id).casefold() == key]
    if len(matches) == 1:
        return matches[0].id
    if not matches:
        raise ToolError(f"No item named '{ref}' on trip '{trip.display_name}'.")
    raise ToolError(
        f"'{ref}' appears {len(matches)} times on this trip; use an item id: "
        + ", ".join(f"{m.id} (category: {_name(db.categories, m.category_id)})" for m in matches)
    )


def _name(repo: Repository[Any], obj_id: str | None) -> str:
    obj = repo.get(obj_id) if obj_id else None
    return obj.display_name if obj else "(deleted)"


# --- Presentation --------------------------------------------------------------


def _missing_people(db: Database, trip: Trip, item: TripItem) -> list[str]:
    """Members without their own one of a per-person item."""
    if not item.per_person:
        return []
    return [_name(db.users, m) for m in trip.member_ids if not item.contribution(m)]


def _item_view(db: Database, trip: Trip, item: TripItem) -> dict[str, Any]:
    members = len(trip.member_ids)
    target = item.target(members)
    return {
        "id": item.id,
        "name": _name(db.supplies, item.supply_id),
        "target": target,
        **({"per_person": True} if item.per_person else {}),
        "covered": item.covered(),
        "short": max(0, target - item.covered()),
        "packed": item.fully_packed(members),
        "bringing": [
            {"who": _name(db.users, c.owner_id), "count": c.count, "status": c.status.value, "packed": c.packed}
            for c in item.contributions
        ],
        **({"notes": item.notes} if item.notes else {}),
    }


def _trip_view(db: Database, trip: Trip) -> dict[str, Any]:
    categories = []
    for cid in trip.category_ids:
        items = [_item_view(db, trip, i) for i in trip.items if i.category_id == cid]
        categories.append({"category": _name(db.categories, cid), "items": items})
    total = len(trip.items)
    members = len(trip.member_ids)
    return {
        "id": trip.id,
        "name": trip.display_name,
        "description": trip.description,
        "start_date": trip.start_date.isoformat() if trip.start_date else None,
        "end_date": trip.end_date.isoformat() if trip.end_date else None,
        "members": [_name(db.users, m) for m in trip.member_ids],
        "totals": {
            "items": total,
            "packed": sum(i.fully_packed(members) for i in trip.items),
            "short": sum(i.covered() < i.target(members) for i in trip.items),
            "to_buy": sum(c.status == Status.NEEDED for i in trip.items for c in i.contributions),
        },
        "categories": categories,
    }


def trip_markdown(db: Database, trip: Trip) -> str:
    view = _trip_view(db, trip)
    dates = " → ".join(d for d in (view["start_date"], view["end_date"]) if d)
    lines = [f"# {trip.display_name}", ""]
    if dates:
        lines.append(f"Dates: {dates}")
    lines.append(f"Members: {', '.join(view['members']) or 'none'}")
    t = view["totals"]
    lines += [f"Packed {t['packed']}/{t['items']} · {t['short']} short · {t['to_buy']} to buy", ""]
    for cat in view["categories"]:
        lines.append(f"## {cat['category']}")
        for i in cat["items"]:
            box = "x" if i["packed"] else " "
            each = " (one per person)" if i.get("per_person") else ""
            who = ", ".join(
                f"{b['who']}{f' ×{b['count']}' if b['count'] > 1 else ''} ({'packed' if b['packed'] else b['status']})"
                for b in i["bringing"]
            )
            lines.append(f"- [{box}] {i['name']}{each} {i['covered']}/{i['target']} — {who or 'unclaimed'}")
        if not cat["items"]:
            lines.append("- (empty)")
        lines.append("")
    return "\n".join(lines)


# --- Read tools ----------------------------------------------------------------


@mcp.tool(annotations=READ)
@_tool_errors
def list_trips() -> list[dict[str, Any]]:
    """List all trips with dates, members and packing progress."""
    db = get_db()
    out = []
    for trip in db.trips.all():
        view = _trip_view(db, trip)
        view.pop("categories")
        out.append(view)
    return out


@mcp.tool(annotations=READ)
@_tool_errors
def get_trip(trip: str) -> dict[str, Any]:
    """Get a trip's members and every item grouped by category (name or id)."""
    db = get_db()
    return _trip_view(db, _trip(db, trip))


@mcp.tool(annotations=READ)
@_tool_errors
def search_library(
    kind: Literal["users", "categories", "supplies", "standard_sets"], query: str = ""
) -> list[dict[str, Any]]:
    """Search the reusable library. Empty query lists everything of that kind.

    Reuse existing supplies and standard sets before inventing new ones.
    """
    db = get_db()
    key = query.strip().casefold()

    def hit(name: str) -> bool:
        return key in name.casefold()

    if kind == "users":
        return [{"id": u.id, "name": u.display_name, "email": u.email} for u in db.users.all() if hit(u.display_name)]
    if kind == "categories":
        return [{"id": c.id, "name": c.display_name, "description": c.description} for c in db.categories.all() if hit(c.display_name)]
    if kind == "supplies":
        return [
            {
                "id": s.id,
                "name": s.display_name,
                "default_category": _name(db.categories, s.default_category_id),
                "default_count": s.default_count,
                **({"per_person": True} if s.per_person else {}),
                **({"notes": s.notes} if s.notes else {}),
            }
            for s in db.supplies.all()
            if not s.archived and hit(s.display_name)
        ]
    return [
        {
            "id": s.id,
            "name": s.display_name,
            "description": s.description,
            "supplies": [
                {"name": _name(db.supplies, x.supply_id), "category": _name(db.categories, x.category_id), "count": x.count}
                for x in s.supplies
            ],
        }
        for s in db.standard_sets.all()
        if hit(s.display_name)
    ]


@mcp.tool(annotations=READ)
@_tool_errors
def trip_gaps(trip: str) -> dict[str, Any]:
    """What still needs attention on a trip.

    short: items nobody (or not enough people) has claimed; per-person items list who is missing.
    to_buy: claims whose owner still has to get the item. unpacked: claims not packed yet.
    bringing_by_person: each member's packing list.
    """
    db = get_db()
    t = _trip(db, trip)
    members = len(t.member_ids)
    short = []
    to_buy: list[str] = []
    unpacked: list[str] = []
    by_person: dict[str, list[str]] = {_name(db.users, m): [] for m in t.member_ids}
    for i in t.items:
        name = _name(db.supplies, i.supply_id)
        if (missing := i.target(members) - i.covered()) > 0:
            entry = {"name": name, "category": _name(db.categories, i.category_id), "missing": missing}
            if i.per_person:
                entry["missing_people"] = _missing_people(db, t, i)
            short.append(entry)
        for c in i.contributions:
            who = _name(db.users, c.owner_id)
            label = f"{name} ×{c.count}" if c.count > 1 else name
            if c.status == Status.NEEDED:
                to_buy.append(f"{label} ({who})")
            if not c.packed:
                unpacked.append(f"{label} ({who})")
            by_person.setdefault(who, []).append(f"{label} ({'packed' if c.packed else c.status.value})")
    return {
        "trip": t.display_name,
        "short": short,
        "to_buy": to_buy,
        "unpacked": unpacked,
        "empty_categories": [_name(db.categories, c) for c in t.category_ids if not any(i.category_id == c for i in t.items)],
        "bringing_by_person": by_person,
    }


# --- Trip write tools ----------------------------------------------------------


class ItemSpec(BaseModel):
    name: str = Field(description="Supply name; reuses the library supply or creates a new one")
    category: str | None = Field(None, description="Category name or id; created if new. Defaults to the supply's default category")
    count: int | None = Field(None, ge=1, description="How many are needed. Defaults to the supply's default count")
    per_person: bool | None = Field(None, description="One per trip member instead of a fixed count. Defaults to the supply's setting")
    owner: str | None = Field(None, description="User name or id who brings it (all of it, or their one for per-person); joins the trip")
    status: Literal["needed", "owned"] = Field("needed", description="Whether the owner still has to get it")


class Share(BaseModel):
    who: str = Field(description="User name or id; joins the trip automatically")
    count: int | None = Field(None, ge=0, description="How many they bring; 0 drops their claim. New claims default to what is still missing")
    status: Literal["needed", "owned"] | None = None
    packed: bool | None = None


class ItemChange(BaseModel):
    item: str = Field(description="Item id, or the supply name if it appears once on the trip")
    count: int | None = Field(None, ge=1, description="How many are needed in total")
    per_person: bool | None = None
    category: str | None = Field(None, description="Move to this category (name or id; created if new)")
    notes: str | None = None
    packed: bool | None = Field(None, description="Pack or unpack every claim on the item")
    status: Literal["needed", "owned"] | None = Field(None, description="Set every claim on the item")
    bringing: list[Share] | None = Field(None, description="Add or change claims; people not listed keep theirs")


@mcp.tool(annotations=WRITE)
@_tool_errors
def create_trip(
    name: str,
    description: str = "",
    start_date: date | None = None,
    end_date: date | None = None,
    members: list[str] | None = None,
    template_trip: str | None = None,
    standard_sets: list[str] | None = None,
) -> dict[str, Any]:
    """Create a trip, optionally copying another trip as a template and applying standard sets.

    A template copy keeps the template's members, categories and items (statuses kept,
    owners cleared, everything unpacked).
    """
    db = get_db()
    with db.lock:
        member_ids = [_resolve(db.users, m, "user").id for m in members or []]
        set_ids = [_resolve(db.standard_sets, s, "standard set").id for s in standard_sets or []]
        if template_trip:
            source = _trip(db, template_trip)
            t = svc.clone_trip(db, source.id, CloneIn(display_name=name, keep_members=True))
            patch = {"start_date": start_date, "end_date": end_date}
            if description:
                patch["description"] = description
            t = svc.update_trip(db, t.id, TripPatch(**patch))
            for uid in member_ids:
                t = svc.add_member(db, t.id, uid)
        else:
            t = svc.create_trip(
                db,
                TripIn(display_name=name, description=description, start_date=start_date, end_date=end_date, member_ids=member_ids),
            )
        for sid in set_ids:
            t = svc.apply_standard_set(db, t.id, sid)
        return _trip_view(db, t)


@mcp.tool(annotations=WRITE)
@_tool_errors
def update_trip(
    trip: str,
    name: str | None = None,
    description: str | None = None,
    start_date: date | None = None,
    end_date: date | None = None,
    add_members: list[str] | None = None,
    remove_members: list[str] | None = None,
) -> dict[str, Any]:
    """Rename a trip, change its description or dates, or add/remove members.

    Removing a member drops their claims on this trip.
    """
    db = get_db()
    with db.lock:
        t = _trip(db, trip)
        fields = {"display_name": name, "description": description, "start_date": start_date, "end_date": end_date}
        patch = {k: v for k, v in fields.items() if v is not None}
        if patch:
            t = svc.update_trip(db, t.id, TripPatch(**patch))
        for m in add_members or []:
            t = svc.add_member(db, t.id, _resolve(db.users, m, "user").id)
        for m in remove_members or []:
            t = svc.remove_member(db, t.id, _resolve(db.users, m, "user").id)
        return _trip_view(db, t)


@mcp.tool(annotations=WRITE)
@_tool_errors
def add_categories(trip: str, categories: list[str]) -> dict[str, Any]:
    """Add category cards to a trip by name or id. New names are created in the library."""
    db = get_db()
    with db.lock:
        t = _trip(db, trip)
        for c in categories:
            t = svc.add_trip_category(db, t.id, _category_id(db, c), None)
        return _trip_view(db, t)


@mcp.tool(annotations=WRITE)
@_tool_errors
def add_items(trip: str, items: list[ItemSpec]) -> dict[str, Any]:
    """Add supplies to a trip in bulk. Unknown supplies and categories are added to the library.

    A supply appears once per category. Adding it again with an owner adds that person's
    claim to the existing item (raising its count if needed) instead of a second row.
    """
    db = get_db()
    with db.lock:
        t = _trip(db, trip)
        for spec in items:
            category_id = _category_id(db, spec.category) if spec.category else None
            # A name goes through find-or-create, which also restores archived supplies.
            by_id = spec.name in db.supplies
            body = ItemIn(
                supply_id=spec.name if by_id else None,
                new_name=None if by_id else spec.name,
                category_id=category_id,
                count=spec.count,
                per_person=spec.per_person,
                status=Status(spec.status),
                owner_id=_user_id(db, spec.owner),
            )
            t = svc.add_item(db, t.id, body)
        return _trip_view(db, t)


@mcp.tool(annotations=WRITE)
@_tool_errors
def update_items(trip: str, changes: list[ItemChange]) -> dict[str, Any]:
    """Change items in bulk: target count, per-person, category, notes, and who brings how many.

    Split an item between people with `bringing`, e.g. [{"who": "Alice", "count": 4}, {"who": "Bob", "count": 2}].
    """
    db = get_db()
    with db.lock:
        t = _trip(db, trip)
        for ch in changes:
            item_id = _item(db, t, ch.item)
            patch: dict[str, Any] = {}
            for key in ("count", "per_person", "packed", "notes"):
                if getattr(ch, key) is not None:
                    patch[key] = getattr(ch, key)
            if ch.status is not None:
                patch["status"] = Status(ch.status)
            if ch.category is not None:
                patch["category_id"] = _category_id(db, ch.category)
            if patch:
                t = svc.update_item(db, t.id, item_id, ItemPatch(**patch))
            for share in ch.bringing or []:
                user_id = _resolve(db.users, share.who, "user").id
                if share.count == 0:
                    t = svc.remove_contribution(db, t.id, item_id, user_id)
                    continue
                claim = ContributionPatch(
                    count=share.count,
                    status=Status(share.status) if share.status else None,
                    packed=share.packed,
                )
                t = svc.set_contribution(db, t.id, item_id, user_id, claim)
        return _trip_view(db, t)


@mcp.tool(annotations=WRITE)
@_tool_errors
def move_items(trip: str, items: list[str], before: str | None = None, category: str | None = None) -> dict[str, Any]:
    """Reorder items, or move them to a position in another category.

    items: item ids or supply names that appear once; they keep their relative order.
    before: the item to place them in front of; omit to put them at the end of the category.
    category: target category (name or id; created if new). Defaults to the category
    of `before`, else of the first item.
    """
    db = get_db()
    with db.lock:
        t = _trip(db, trip)
        item_ids = [_item(db, t, ref) for ref in items]
        before_id = _item(db, t, before) if before else None
        if category:
            category_id = _category_id(db, category)
        else:
            anchor = before_id or item_ids[0]
            category_id = next(i.category_id for i in t.items if i.id == anchor)
        return _trip_view(db, svc.move_items(db, t.id, ItemMoveIn(item_ids=item_ids, category_id=category_id, before_id=before_id)))


@mcp.tool(annotations=WRITE)
@_tool_errors
def move_category(trip: str, category: str, before: str | None = None) -> dict[str, Any]:
    """Reorder a trip's category cards: put `category` in front of `before`, or last if omitted."""
    db = get_db()
    with db.lock:
        t = _trip(db, trip)
        cid = _resolve(db.categories, category, "category").id
        before_id = _resolve(db.categories, before, "category").id if before else None
        return _trip_view(db, svc.move_trip_category(db, t.id, cid, before_id))


@mcp.tool(annotations=REMOVE)
@_tool_errors
def remove_items(trip: str, items: list[str]) -> dict[str, Any]:
    """Remove items from a trip (item ids, or supply names that appear once). The library is unchanged."""
    db = get_db()
    with db.lock:
        t = _trip(db, trip)
        for ref in items:
            t = svc.delete_item(db, t.id, _item(db, t, ref))
        return _trip_view(db, t)


@mcp.tool(annotations=REMOVE)
@_tool_errors
def remove_category_from_trip(trip: str, category: str) -> dict[str, Any]:
    """Remove a category card and all of its items from a trip. The library is unchanged."""
    db = get_db()
    with db.lock:
        t = _trip(db, trip)
        cid = _resolve(db.categories, category, "category").id
        return _trip_view(db, svc.remove_trip_category(db, t.id, cid))


@mcp.tool(annotations=WRITE)
@_tool_errors
def apply_standard_set(trip: str, standard_set: str) -> dict[str, Any]:
    """Merge a standard set into a trip. Supplies already in the same category are skipped."""
    db = get_db()
    with db.lock:
        t = _trip(db, trip)
        sid = _resolve(db.standard_sets, standard_set, "standard set").id
        return _trip_view(db, svc.apply_standard_set(db, t.id, sid))


@mcp.tool(annotations=WRITE)
@_tool_errors
def save_trip_as_standard_set(trip: str, name: str) -> dict[str, Any]:
    """Save a trip's categories and supplies as a reusable standard set."""
    db = get_db()
    with db.lock:
        sset = svc.standard_set_from_trip(db, _trip(db, trip).id, name)
        return {"id": sset.id, "name": sset.display_name, "supplies": len(sset.supplies), "categories": len(sset.category_ids)}


@mcp.tool(annotations=WRITE)
@_tool_errors
def update_library_defaults(trip: str, category: str | None = None) -> dict[str, Any]:
    """Set supplies' library default category to the category they sit in on this trip.

    Pass a category to limit it to that card. Supplies on several cards are skipped as ambiguous.
    """
    db = get_db()
    with db.lock:
        t = _trip(db, trip)
        cid = _resolve(db.categories, category, "category").id if category else None
        result = svc.adopt_trip_categories(db, t.id, cid)
        return {
            "updated": [{"name": s.display_name, "default_category": _name(db.categories, s.default_category_id)} for s in result["updated"]],
            "ambiguous": [s.display_name for s in result["ambiguous"]],
        }


# --- Library write tools -------------------------------------------------------


@mcp.tool(annotations=WRITE)
@_tool_errors
def create_user(name: str, email: str = "") -> dict[str, Any]:
    """Add a person to the library so they can join trips and own items."""
    db = get_db()
    u = svc.create_user(db, name, email)
    return {"id": u.id, "name": u.display_name, "email": u.email}


@mcp.tool(annotations=WRITE)
@_tool_errors
def create_supply(
    name: str, default_category: str | None = None, default_count: int = 1, per_person: bool = False, notes: str = ""
) -> dict[str, Any]:
    """Add a reusable supply to the library (category created if new). Returns the existing one if the name is taken.

    per_person: trips need one per member (sleeping bag, headlamp) instead of default_count.
    """
    db = get_db()
    with db.lock:
        if existing := next((s for s in db.supplies.all() if s.display_name.casefold() == name.strip().casefold()), None):
            return {"id": existing.id, "name": existing.display_name, "already_existed": True}
        cid = _category_id(db, default_category) if default_category else UNCATEGORIZED_ID
        s = svc.create_supply(db, SupplyIn(display_name=name, default_category_id=cid, default_count=default_count, per_person=per_person, notes=notes))
        return {"id": s.id, "name": s.display_name, "default_category": _name(db.categories, cid)}


@mcp.tool(annotations=WRITE)
@_tool_errors
def rename_library_entry(kind: Literal["user", "category", "supply", "standard_set"], entry: str, new_name: str) -> dict[str, Any]:
    """Rename a library entry. Trips reference entries by id, so the new name shows everywhere."""
    db = get_db()
    repo, label, update = {
        "user": (db.users, "user", svc.update_user),
        "category": (db.categories, "category", svc.update_category),
        "supply": (db.supplies, "supply", svc.update_supply),
        "standard_set": (db.standard_sets, "standard set", svc.update_standard_set),
    }[kind]
    with db.lock:
        obj = _resolve(repo, entry, label)

        class Rename(BaseModel):
            display_name: str

        updated = update(db, obj.id, Rename(display_name=new_name))
        return {"id": updated.id, "name": updated.display_name}


# --- Resource and prompt -------------------------------------------------------


@mcp.resource("trip://{trip_id}", name="trip", description="A trip as a Markdown packing list", mime_type="text/markdown")
def trip_resource(trip_id: str) -> str:
    db = get_db()
    return trip_markdown(db, _trip(db, trip_id))


@mcp.prompt(description="Plan or top up a trip's supplies using the shared library")
def plan_trip(trip: str, notes: str = "") -> str:
    extra = f"\nExtra context from the user: {notes}" if notes else ""
    return f"""Help plan supplies for the trip "{trip}".{extra}

1. Call get_trip and trip_gaps to see what is already there.
2. Call search_library for standard_sets and supplies; prefer reusing existing entries and sets.
3. Propose additions grouped by category with counts, and ask before making large changes.
4. Apply agreed changes with add_items / update_items in bulk (one call per batch, not per item).
5. Use per_person for things everyone brings their own of, and split shared items between people with update_items.
6. Finish with trip_gaps and summarise what is still short, to buy or unassigned."""


# --- HTTP mounting -------------------------------------------------------------


class MCPEndpoint:
    """ASGI endpoint for /mcp with optional bearer-token auth (MCP_TOKEN env var).

    The SDK's session manager can only run once, so each app lifespan builds a
    fresh streamable-HTTP app via `start()` and this endpoint forwards to it.
    """

    def __init__(self) -> None:
        self._app: Starlette | None = None

    def build(self) -> Starlette:
        # host="0.0.0.0" disables the SDK's localhost-only Host check so LAN clients
        # can connect; the REST API is equally reachable, and MCP_TOKEN guards writes.
        self._app = mcp.streamable_http_app(stateless_http=True, json_response=True, host="0.0.0.0")
        return self._app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        token = os.environ.get("MCP_TOKEN", "")
        if token and scope["type"] == "http":
            auth = dict(scope["headers"]).get(b"authorization", b"").decode()
            if not hmac.compare_digest(auth, f"Bearer {token}"):
                await JSONResponse({"error": "unauthorized"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})(scope, receive, send)
                return
        if self._app is None:
            await JSONResponse({"error": "MCP server not started"}, status_code=503)(scope, receive, send)
            return
        await self._app(scope, receive, send)


endpoint = MCPEndpoint()
