from app.models import UNCATEGORIZED_ID


def test_add_item_uses_default_category_and_adds_card(client, make):
    cat = make.category("Cooking")
    s = make.supply("Stove", cat["id"], default_count=2)
    t = make.trip()
    r = client.post(f"/api/trips/{t['id']}/items", json={"supply_id": s["id"]})
    trip = r.json()
    assert trip["category_ids"] == [cat["id"]]
    assert trip["items"][0]["category_id"] == cat["id"]
    assert trip["items"][0]["count"] == 2
    assert trip["items"][0]["status"] == "needed" and trip["items"][0]["packed"] is False
    assert trip["version"] == 1


def test_add_item_by_new_name_creates_library_supply(client, make):
    t = make.trip()
    trip = client.post(f"/api/trips/{t['id']}/items", json={"new_name": "Headlamp"}).json()
    supplies = client.get("/api/supplies").json()
    assert [s["display_name"] for s in supplies] == ["Headlamp"]
    assert trip["items"][0]["supply_id"] == supplies[0]["id"]
    assert trip["category_ids"] == [UNCATEGORIZED_ID]
    # same name again reuses the library supply
    client.post(f"/api/trips/{t['id']}/items", json={"new_name": "headlamp"})
    assert len(client.get("/api/supplies").json()) == 1


def test_same_supply_can_appear_twice(client, make):
    s = make.supply("Stove")
    a, b = make.user("A"), make.user("B")
    t = make.trip()
    client.post(f"/api/trips/{t['id']}/items", json={"supply_id": s["id"], "owner_id": a["id"]})
    trip = client.post(f"/api/trips/{t['id']}/items", json={"supply_id": s["id"], "owner_id": b["id"]}).json()
    assert len(trip["items"]) == 2
    assert set(trip["member_ids"]) == {a["id"], b["id"]}  # owners join automatically


def test_move_item_and_pack(client, make):
    c1, c2 = make.category("A"), make.category("B")
    s = make.supply("Stove", c1["id"])
    t = make.trip()
    trip = client.post(f"/api/trips/{t['id']}/items", json={"supply_id": s["id"]}).json()
    item_id = trip["items"][0]["id"]
    trip = client.patch(f"/api/trips/{t['id']}/items/{item_id}", json={"category_id": c2["id"]}).json()
    assert trip["items"][0]["category_id"] == c2["id"]
    assert c2["id"] in trip["category_ids"]
    trip = client.put(f"/api/trips/{t['id']}/categories/{c2['id']}/packed", json={"packed": True}).json()
    assert trip["items"][0]["packed"] is True
    trip = client.patch(f"/api/trips/{t['id']}/items/{item_id}", json={"owner_id": None, "status": "owned"}).json()
    assert trip["items"][0]["status"] == "owned"


def test_remove_category_removes_its_items(client, make):
    cat = make.category()
    s = make.supply("Stove", cat["id"])
    t = make.trip()
    client.post(f"/api/trips/{t['id']}/items", json={"supply_id": s["id"]})
    trip = client.delete(f"/api/trips/{t['id']}/categories/{cat['id']}").json()
    assert trip["category_ids"] == [] and trip["items"] == []


def test_add_category_by_new_name(client, make):
    t = make.trip()
    trip = client.post(f"/api/trips/{t['id']}/categories", json={"new_name": "First Aid"}).json()
    cats = {c["display_name"]: c["id"] for c in client.get("/api/categories").json()}
    assert trip["category_ids"] == [cats["First Aid"]]


def test_polling_since(client, make):
    t = make.trip()
    assert client.get(f"/api/trips/{t['id']}?since=0").json() == {"changed": False}
    client.post(f"/api/trips/{t['id']}/items", json={"new_name": "Rope"})
    assert client.get(f"/api/trips/{t['id']}?since=0").json()["version"] == 1


def test_members(client, make):
    u = make.user()
    t = make.trip()
    trip = client.post(f"/api/trips/{t['id']}/members/{u['id']}").json()
    assert trip["member_ids"] == [u["id"]]
    trip = client.post(f"/api/trips/{t['id']}/items", json={"new_name": "Rope", "owner_id": u["id"]}).json()
    trip = client.delete(f"/api/trips/{t['id']}/members/{u['id']}").json()
    assert trip["member_ids"] == [] and trip["items"][0]["owner_id"] is None


def test_clone_trip(client, make):
    u = make.user()
    t = make.trip(member_ids=[u["id"]])
    trip = client.post(f"/api/trips/{t['id']}/items", json={"new_name": "Rope", "owner_id": u["id"], "status": "owned"}).json()
    client.patch(f"/api/trips/{t['id']}/items/{trip['items'][0]['id']}", json={"packed": True})

    clone = client.post(
        f"/api/trips/{t['id']}/clone",
        json={"display_name": "Lake 2", "keep_members": True, "keep_owners": False, "reset_status_to_needed": True},
    ).json()
    assert clone["id"] != t["id"] and clone["template_source_id"] == t["id"]
    assert clone["member_ids"] == [u["id"]]
    item = clone["items"][0]
    assert item["id"] != trip["items"][0]["id"]
    assert item["owner_id"] is None and item["status"] == "needed" and item["packed"] is False


def test_apply_set_and_save_as_set(client, make):
    cat = make.category()
    s1, s2 = make.supply("Stove", cat["id"]), make.supply("Pot", cat["id"])
    sset = client.post(
        "/api/standard-sets",
        json={
            "display_name": "Kitchen",
            "supplies": [
                {"supply_id": s1["id"], "category_id": cat["id"], "count": 1},
                {"supply_id": s2["id"], "category_id": cat["id"], "count": 3},
            ],
        },
    ).json()
    t = make.trip()
    client.post(f"/api/trips/{t['id']}/items", json={"supply_id": s1["id"]})
    trip = client.post(f"/api/trips/{t['id']}/apply-set/{sset['id']}").json()
    assert trip["category_ids"] == [cat["id"]]
    assert sorted((i["supply_id"], i["count"]) for i in trip["items"]) == sorted([(s1["id"], 1), (s2["id"], 3)])
    # applying again adds nothing
    assert len(client.post(f"/api/trips/{t['id']}/apply-set/{sset['id']}").json()["items"]) == 2

    saved = client.post(f"/api/standard-sets/from-trip/{t['id']}?display_name=Copy").json()
    assert saved["display_name"] == "Copy" and len(saved["supplies"]) == 2


def test_revision_changes_on_writes(client, make):
    before = client.get("/api/revision").json()["revision"]
    make.user()
    assert client.get("/api/revision").json()["revision"] > before


def _names(trip, supplies):
    by_id = {s["id"]: s["display_name"] for s in supplies}
    return [(by_id[i["supply_id"]], i["category_id"]) for i in trip["items"]]


def test_move_items_reorders_and_recategorizes(client, make):
    a, b = make.category("A"), make.category("B")
    supplies = [make.supply(n, a["id"]) for n in ("Stove", "Pot", "Fuel")] + [make.supply("Tent", b["id"])]
    t = make.trip()
    for s in supplies:
        trip = client.post(f"/api/trips/{t['id']}/items", json={"supply_id": s["id"]}).json()
    stove, pot, fuel, tent = (i["id"] for i in trip["items"])
    move = lambda **body: client.post(f"/api/trips/{t['id']}/items/move", json=body)

    # within a card: Fuel in front of Stove
    trip = move(item_ids=[fuel], category_id=a["id"], before_id=stove).json()
    assert _names(trip, supplies)[:3] == [("Fuel", a["id"]), ("Stove", a["id"]), ("Pot", a["id"])]
    version = trip["version"]

    # dropping it where it already is changes nothing
    trip = move(item_ids=[fuel], category_id=a["id"], before_id=stove).json()
    assert trip["version"] == version

    # several items to the end of another card keep their relative order
    trip = move(item_ids=[pot, fuel], category_id=b["id"]).json()
    assert _names(trip, supplies) == [("Stove", a["id"]), ("Tent", b["id"]), ("Fuel", b["id"]), ("Pot", b["id"])]

    # into a category not yet on the trip adds the card
    c = make.category("C")
    trip = move(item_ids=[stove], category_id=c["id"]).json()
    assert trip["category_ids"] == [a["id"], b["id"], c["id"]]

    assert move(item_ids=[stove], category_id=a["id"], before_id=tent).status_code == 400
    assert move(item_ids=[stove], category_id=c["id"], before_id=stove).status_code == 400
    assert move(item_ids=["nope"], category_id=a["id"]).status_code == 404


def test_patching_category_moves_item_to_end_of_card(client, make):
    a, b = make.category("A"), make.category("B")
    supplies = [make.supply("Stove", a["id"]), make.supply("Tent", b["id"])]
    t = make.trip()
    for s in supplies:
        trip = client.post(f"/api/trips/{t['id']}/items", json={"supply_id": s["id"]}).json()
    stove = trip["items"][0]["id"]
    trip = client.patch(f"/api/trips/{t['id']}/items/{stove}", json={"category_id": b["id"]}).json()
    assert _names(trip, supplies) == [("Tent", b["id"]), ("Stove", b["id"])]


def test_move_category(client, make):
    a, b, c = make.category("A"), make.category("B"), make.category("C")
    t = make.trip()
    for cat in (a, b, c):
        client.post(f"/api/trips/{t['id']}/categories", json={"category_id": cat["id"]})
    move = lambda **body: client.post(f"/api/trips/{t['id']}/categories/move", json=body)
    assert move(category_id=c["id"], before_id=a["id"]).json()["category_ids"] == [c["id"], a["id"], b["id"]]
    assert move(category_id=c["id"]).json()["category_ids"] == [a["id"], b["id"], c["id"]]
    version = move(category_id=b["id"], before_id=b["id"]).json()["version"]
    assert move(category_id=b["id"], before_id=c["id"]).json()["version"] == version  # already there
    d = make.category("D")
    assert move(category_id=d["id"]).status_code == 404


def test_add_item_at_position(client, make):
    a, b = make.category("A"), make.category("B")
    supplies = [make.supply("Stove", a["id"]), make.supply("Pot", a["id"]), make.supply("Tent", b["id"])]
    t = make.trip()
    trip = client.post(f"/api/trips/{t['id']}/items", json={"supply_id": supplies[0]["id"]}).json()
    stove = trip["items"][0]["id"]
    trip = client.post(f"/api/trips/{t['id']}/items", json={"supply_id": supplies[1]["id"], "before_id": stove}).json()
    assert _names(trip, supplies) == [("Pot", a["id"]), ("Stove", a["id"])]
    # without a category, the item joins the card of the one it lands in front of
    trip = client.post(f"/api/trips/{t['id']}/items", json={"supply_id": supplies[2]["id"], "before_id": stove}).json()
    assert _names(trip, supplies) == [("Pot", a["id"]), ("Tent", a["id"]), ("Stove", a["id"])]
    r = client.post(f"/api/trips/{t['id']}/items", json={"supply_id": supplies[2]["id"], "category_id": b["id"], "before_id": stove})
    assert r.status_code == 400
