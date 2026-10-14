from app.models import UNCATEGORIZED_ID


def test_delete_user_clears_trips(client, make):
    u = make.user()
    t = make.trip(member_ids=[u["id"]])
    client.post(f"/api/trips/{t['id']}/items", json={"new_name": "Rope", "owner_id": u["id"]})
    client.delete(f"/api/users/{u['id']}")
    trip = client.get(f"/api/trips/{t['id']}").json()
    assert trip["member_ids"] == [] and trip["items"][0]["contributions"] == []


def test_delete_category_moves_everything_to_uncategorized(client, make):
    cat = make.category()
    s = make.supply("Stove", cat["id"])
    sset = client.post(
        "/api/standard-sets",
        json={"display_name": "K", "supplies": [{"supply_id": s["id"], "category_id": cat["id"]}]},
    ).json()
    t = make.trip()
    client.post(f"/api/trips/{t['id']}/items", json={"supply_id": s["id"]})

    assert client.delete(f"/api/categories/{cat['id']}").status_code == 204

    assert client.get(f"/api/supplies/{s['id']}").json()["default_category_id"] == UNCATEGORIZED_ID
    sset = client.get(f"/api/standard-sets/{sset['id']}").json()
    assert sset["category_ids"] == [UNCATEGORIZED_ID]
    assert sset["supplies"][0]["category_id"] == UNCATEGORIZED_ID
    trip = client.get(f"/api/trips/{t['id']}").json()
    assert trip["category_ids"] == [UNCATEGORIZED_ID]
    assert trip["items"][0]["category_id"] == UNCATEGORIZED_ID


def test_rename_propagates_by_reference(client, make):
    cat = make.category("Cooking")
    t = make.trip()
    client.post(f"/api/trips/{t['id']}/categories", json={"category_id": cat["id"]})
    client.patch(f"/api/categories/{cat['id']}", json={"display_name": "Kitchen"})
    trip = client.get(f"/api/trips/{t['id']}").json()
    assert trip["category_ids"] == [cat["id"]]  # trip only stores the GUID


def test_delete_used_supply_archives_it(client, make):
    s = make.supply("Stove")
    t = make.trip()
    client.post(f"/api/trips/{t['id']}/items", json={"supply_id": s["id"]})
    assert client.delete(f"/api/supplies/{s['id']}").json() == {"archived": True, "deleted": False}
    assert client.get("/api/supplies").json() == []
    assert client.get("/api/supplies?include_archived=true").json()[0]["archived"] is True
    # re-adding by name un-archives
    client.post(f"/api/trips/{t['id']}/items", json={"new_name": "Stove"})
    assert client.get("/api/supplies").json()[0]["id"] == s["id"]
