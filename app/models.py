"""Domain models.

Two layers:
- Library objects (User, Category, Supply, StandardSet) are reusable definitions.
- A Trip composes library objects by GUID and only stores trip-specific state
  (member/category id lists and TripItems).
"""

from datetime import date
from enum import StrEnum
from typing import Any
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

UNCATEGORIZED_ID = "00000000-0000-0000-0000-000000000001"


def new_id() -> str:
    return str(uuid4())


def _clean_name(value: str) -> str:
    value = value.strip()
    if not value:
        raise ValueError("display_name must not be empty")
    return value


class Status(StrEnum):
    OWNED = "owned"
    NEEDED = "needed"


class Entity(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: str = Field(default_factory=new_id)
    display_name: str

    _clean = field_validator("display_name")(_clean_name)


# --- Library -----------------------------------------------------------------


class User(Entity):
    email: str = ""


class Category(Entity):
    description: str = ""
    builtin: bool = False


class Supply(Entity):
    default_category_id: str = UNCATEGORIZED_ID
    default_count: int = Field(default=1, ge=1)
    per_person: bool = False  # trips need one per member instead of default_count
    notes: str = ""
    archived: bool = False


class SetSupply(BaseModel):
    supply_id: str
    category_id: str
    count: int = Field(default=1, ge=1)


class StandardSet(Entity):
    description: str = ""
    category_ids: list[str] = Field(default_factory=list)
    supplies: list[SetSupply] = Field(default_factory=list)


# --- Trip --------------------------------------------------------------------


class Contribution(BaseModel):
    """One person's share of a trip item. An item has at most one per owner."""

    owner_id: str
    count: int = Field(default=1, ge=1)
    status: Status = Status.NEEDED
    packed: bool = False


class TripItem(BaseModel):
    """A supply on a trip: how many are needed, and who brings how many.

    The target is `count`, or one per trip member when `per_person` is set.
    """

    id: str = Field(default_factory=new_id)
    supply_id: str
    category_id: str
    count: int = Field(default=1, ge=1)
    per_person: bool = False
    contributions: list[Contribution] = Field(default_factory=list)
    notes: str = ""

    def contribution(self, owner_id: str) -> Contribution | None:
        return next((c for c in self.contributions if c.owner_id == owner_id), None)

    def target(self, member_count: int) -> int:
        return member_count if self.per_person else self.count

    def covered(self) -> int:
        return sum(c.count for c in self.contributions)

    def fully_packed(self, member_count: int) -> bool:
        return (
            bool(self.contributions)
            and self.covered() >= self.target(member_count)
            and all(c.packed for c in self.contributions)
        )


class Trip(Entity):
    description: str = ""
    start_date: date | None = None
    end_date: date | None = None
    member_ids: list[str] = Field(default_factory=list)
    category_ids: list[str] = Field(default_factory=list)
    items: list[TripItem] = Field(default_factory=list)
    version: int = 0
    template_source_id: str | None = None

    @model_validator(mode="before")
    @classmethod
    def _migrate_legacy_items(cls, data: Any) -> Any:
        """Convert trips saved before v0.7, whose items had one owner_id/status/packed each.

        An owned item becomes that owner's contribution. An unowned item that was marked
        owned or packed goes to the trip's first member, so nothing is lost. Rows for the
        same supply on the same card (the old way to split an item) merge into one item.
        The converted trip is written back on its next save.
        """
        if not isinstance(data, dict):
            return data
        items = data.get("items") or []
        if not any(isinstance(i, dict) and "contributions" not in i for i in items):
            return data
        members = data.get("member_ids") or []
        merged: dict[tuple[str, str], dict[str, Any]] = {}
        for raw in items:
            item = dict(raw)
            if "contributions" not in item:
                owner = item.pop("owner_id", None)
                status = item.pop("status", Status.NEEDED)
                packed = item.pop("packed", False)
                if owner is None and (packed or status == Status.OWNED) and members:
                    owner = members[0]
                item["contributions"] = (
                    [{"owner_id": owner, "count": item.get("count", 1), "status": Status.OWNED if packed else status, "packed": packed}]
                    if owner
                    else []
                )
            key = (item.get("supply_id"), item.get("category_id"))
            if key not in merged:
                merged[key] = item
                continue
            first = merged[key]
            first["count"] = first.get("count", 1) + item.get("count", 1)
            for c in item["contributions"]:
                same = next((x for x in first["contributions"] if x["owner_id"] == c["owner_id"]), None)
                if same is None:
                    first["contributions"].append(c)
                else:
                    same["count"] += c["count"]
                    same["packed"] = same["packed"] and c["packed"]
                    if c["status"] == Status.NEEDED:
                        same["status"] = Status.NEEDED
        return {**data, "items": list(merged.values())}


# --- Request bodies ----------------------------------------------------------


class UserIn(BaseModel):
    display_name: str
    email: str = ""


class UserPatch(BaseModel):
    display_name: str | None = None
    email: str | None = None


class CategoryIn(BaseModel):
    display_name: str
    description: str = ""


class CategoryPatch(BaseModel):
    display_name: str | None = None
    description: str | None = None


class SupplyIn(BaseModel):
    display_name: str
    default_category_id: str = UNCATEGORIZED_ID
    default_count: int = Field(default=1, ge=1)
    per_person: bool = False
    notes: str = ""


class SupplyPatch(BaseModel):
    display_name: str | None = None
    default_category_id: str | None = None
    default_count: int | None = Field(default=None, ge=1)
    per_person: bool | None = None
    notes: str | None = None
    archived: bool | None = None


class StandardSetIn(BaseModel):
    display_name: str
    description: str = ""
    category_ids: list[str] = Field(default_factory=list)
    supplies: list[SetSupply] = Field(default_factory=list)


class StandardSetPatch(BaseModel):
    display_name: str | None = None
    description: str | None = None
    category_ids: list[str] | None = None
    supplies: list[SetSupply] | None = None


class TripIn(BaseModel):
    display_name: str
    description: str = ""
    start_date: date | None = None
    end_date: date | None = None
    member_ids: list[str] = Field(default_factory=list)


class TripPatch(BaseModel):
    display_name: str | None = None
    description: str | None = None
    start_date: date | None = None
    end_date: date | None = None


class CloneIn(BaseModel):
    display_name: str
    keep_members: bool = True
    keep_owners: bool = False  # keep who brings what (requires keep_members)
    reset_status_to_needed: bool = False  # for kept contributions


class TripCategoryIn(BaseModel):
    category_id: str | None = None
    new_name: str | None = None


class PackedIn(BaseModel):
    packed: bool


class ItemIn(BaseModel):
    supply_id: str | None = None
    new_name: str | None = None
    category_id: str | None = None
    count: int | None = Field(default=None, ge=1)
    per_person: bool | None = None  # None = the supply's default
    owner_id: str | None = None  # claims the whole item for this person
    status: Status = Status.NEEDED  # of the owner's contribution
    before_id: str | None = None  # item to land in front of; None = end of the card


class ItemMoveIn(BaseModel):
    item_ids: list[str] = Field(min_length=1)
    category_id: str
    before_id: str | None = None  # item to land in front of; None = end of the card


class CategoryMoveIn(BaseModel):
    category_id: str
    before_id: str | None = None  # card to land in front of; None = last


class ItemPatch(BaseModel):
    count: int | None = Field(default=None, ge=1)
    per_person: bool | None = None
    category_id: str | None = None
    notes: str | None = None
    status: Status | None = None  # applied to every contribution
    packed: bool | None = None  # applied to every contribution
    contributions: list[Contribution] | None = None  # replaces them all


class ContributionPatch(BaseModel):
    """Create or change one person's contribution. Unset fields keep their value
    (or a default: the remaining count, or 1 for a per-person item)."""

    count: int | None = Field(default=None, ge=1)
    status: Status | None = None
    packed: bool | None = None
