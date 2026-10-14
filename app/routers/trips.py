"""Trip endpoints. Every change bumps trip.version and returns the full trip."""

from fastapi import APIRouter

from .. import services as svc
from ..models import (
    CategoryMoveIn,
    CloneIn,
    ContributionPatch,
    ItemIn,
    ItemMoveIn,
    ItemPatch,
    PackedIn,
    Supply,
    Trip,
    TripCategoryIn,
    TripIn,
    TripPatch,
)
from ..storage import get_db

router = APIRouter(prefix="/api/trips")


@router.get("")
def list_trips() -> list[Trip]:
    return get_db().trips.all()


@router.post("", status_code=201)
def create_trip(body: TripIn) -> Trip:
    return svc.create_trip(get_db(), body)


@router.get("/{trip_id}", response_model=None)
def get_trip(trip_id: str, since: int | None = None) -> Trip | dict[str, bool]:
    trip = svc._require(get_db().trips, trip_id, "Trip")
    if since is not None and since == trip.version:
        return {"changed": False}
    return trip


@router.patch("/{trip_id}")
def update_trip(trip_id: str, body: TripPatch) -> Trip:
    return svc.update_trip(get_db(), trip_id, body)


@router.delete("/{trip_id}", status_code=204)
def delete_trip(trip_id: str) -> None:
    svc.delete_trip(get_db(), trip_id)


@router.post("/{trip_id}/clone", status_code=201)
def clone_trip(trip_id: str, body: CloneIn) -> Trip:
    return svc.clone_trip(get_db(), trip_id, body)


@router.post("/{trip_id}/members/{user_id}")
def add_member(trip_id: str, user_id: str) -> Trip:
    return svc.add_member(get_db(), trip_id, user_id)


@router.delete("/{trip_id}/members/{user_id}")
def remove_member(trip_id: str, user_id: str) -> Trip:
    return svc.remove_member(get_db(), trip_id, user_id)


@router.post("/{trip_id}/categories")
def add_category(trip_id: str, body: TripCategoryIn) -> Trip:
    return svc.add_trip_category(get_db(), trip_id, body.category_id, body.new_name)


@router.post("/{trip_id}/categories/move")
def move_category(trip_id: str, body: CategoryMoveIn) -> Trip:
    return svc.move_trip_category(get_db(), trip_id, body.category_id, body.before_id)


@router.delete("/{trip_id}/categories/{category_id}")
def remove_category(trip_id: str, category_id: str) -> Trip:
    return svc.remove_trip_category(get_db(), trip_id, category_id)


@router.put("/{trip_id}/categories/{category_id}/packed")
def set_category_packed(trip_id: str, category_id: str, body: PackedIn) -> Trip:
    return svc.set_category_packed(get_db(), trip_id, category_id, body.packed)


@router.post("/{trip_id}/categories/{category_id}/adopt-defaults")
def adopt_defaults(trip_id: str, category_id: str) -> list[Supply]:
    """Make this card the library default category for the supplies on it."""
    return svc.adopt_trip_categories(get_db(), trip_id, category_id)["updated"]


@router.post("/{trip_id}/items")
def add_item(trip_id: str, body: ItemIn) -> Trip:
    return svc.add_item(get_db(), trip_id, body)


@router.post("/{trip_id}/items/move")
def move_items(trip_id: str, body: ItemMoveIn) -> Trip:
    return svc.move_items(get_db(), trip_id, body)


@router.patch("/{trip_id}/items/{item_id}")
def update_item(trip_id: str, item_id: str, body: ItemPatch) -> Trip:
    return svc.update_item(get_db(), trip_id, item_id, body)


@router.delete("/{trip_id}/items/{item_id}")
def delete_item(trip_id: str, item_id: str) -> Trip:
    return svc.delete_item(get_db(), trip_id, item_id)


@router.put("/{trip_id}/items/{item_id}/contributions/{user_id}")
def set_contribution(trip_id: str, item_id: str, user_id: str, body: ContributionPatch) -> Trip:
    """Claim (part of) an item for a person, or change their claim."""
    return svc.set_contribution(get_db(), trip_id, item_id, user_id, body)


@router.delete("/{trip_id}/items/{item_id}/contributions/{user_id}")
def remove_contribution(trip_id: str, item_id: str, user_id: str) -> Trip:
    return svc.remove_contribution(get_db(), trip_id, item_id, user_id)


@router.post("/{trip_id}/apply-set/{set_id}")
def apply_set(trip_id: str, set_id: str) -> Trip:
    return svc.apply_standard_set(get_db(), trip_id, set_id)
