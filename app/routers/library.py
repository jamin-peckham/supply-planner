"""CRUD endpoints for library objects: users, categories, supplies, standard sets."""

from fastapi import APIRouter, Query

from .. import services as svc
from ..models import (
    Category,
    CategoryIn,
    CategoryPatch,
    StandardSet,
    StandardSetIn,
    StandardSetPatch,
    Supply,
    SupplyIn,
    SupplyPatch,
    User,
    UserIn,
    UserPatch,
)
from ..storage import get_db

router = APIRouter(prefix="/api")


@router.get("/revision")
def revision() -> dict[str, int]:
    """Changes on any save/delete; clients poll this to know when to refetch."""
    return {"revision": get_db().revision}


# --- Users -------------------------------------------------------------------


@router.get("/users")
def list_users() -> list[User]:
    return get_db().users.all()


@router.post("/users", status_code=201)
def create_user(body: UserIn) -> User:
    return svc.create_user(get_db(), body.display_name, body.email)


@router.get("/users/{user_id}")
def get_user(user_id: str) -> User:
    return svc._require(get_db().users, user_id, "User")


@router.patch("/users/{user_id}")
def update_user(user_id: str, body: UserPatch) -> User:
    return svc.update_user(get_db(), user_id, body)


@router.delete("/users/{user_id}", status_code=204)
def delete_user(user_id: str) -> None:
    svc.delete_user(get_db(), user_id)


# --- Categories --------------------------------------------------------------


@router.get("/categories")
def list_categories() -> list[Category]:
    return get_db().categories.all()


@router.post("/categories", status_code=201)
def create_category(body: CategoryIn) -> Category:
    return svc.create_category(get_db(), body.display_name, body.description)


@router.get("/categories/{category_id}")
def get_category(category_id: str) -> Category:
    return svc._require(get_db().categories, category_id, "Category")


@router.patch("/categories/{category_id}")
def update_category(category_id: str, body: CategoryPatch) -> Category:
    return svc.update_category(get_db(), category_id, body)


@router.delete("/categories/{category_id}", status_code=204)
def delete_category(category_id: str) -> None:
    svc.delete_category(get_db(), category_id)


# --- Supplies ----------------------------------------------------------------


@router.get("/supplies")
def list_supplies(q: str = "", include_archived: bool = Query(False)) -> list[Supply]:
    key = q.strip().casefold()
    return [
        s
        for s in get_db().supplies.all()
        if (include_archived or not s.archived) and key in s.display_name.casefold()
    ]


@router.post("/supplies", status_code=201)
def create_supply(body: SupplyIn) -> Supply:
    return svc.create_supply(get_db(), body)


@router.get("/supplies/{supply_id}")
def get_supply(supply_id: str) -> Supply:
    return svc._require(get_db().supplies, supply_id, "Supply")


@router.patch("/supplies/{supply_id}")
def update_supply(supply_id: str, body: SupplyPatch) -> Supply:
    return svc.update_supply(get_db(), supply_id, body)


@router.delete("/supplies/{supply_id}")
def delete_supply(supply_id: str) -> dict[str, bool]:
    return svc.delete_supply(get_db(), supply_id)


# --- Standard sets -----------------------------------------------------------


@router.get("/standard-sets")
def list_standard_sets() -> list[StandardSet]:
    return get_db().standard_sets.all()


@router.post("/standard-sets", status_code=201)
def create_standard_set(body: StandardSetIn) -> StandardSet:
    return svc.create_standard_set(get_db(), body)


@router.post("/standard-sets/from-trip/{trip_id}", status_code=201)
def standard_set_from_trip(trip_id: str, display_name: str | None = None) -> StandardSet:
    return svc.standard_set_from_trip(get_db(), trip_id, display_name)


@router.get("/standard-sets/{set_id}")
def get_standard_set(set_id: str) -> StandardSet:
    return svc._require(get_db().standard_sets, set_id, "Standard set")


@router.patch("/standard-sets/{set_id}")
def update_standard_set(set_id: str, body: StandardSetPatch) -> StandardSet:
    return svc.update_standard_set(get_db(), set_id, body)


@router.delete("/standard-sets/{set_id}", status_code=204)
def delete_standard_set(set_id: str) -> None:
    svc.delete_standard_set(get_db(), set_id)
