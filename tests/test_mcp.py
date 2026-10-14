import asyncio
import json

import pytest
from mcp.server.mcpserver.exceptions import ToolError

from app.mcp_server import mcp


def call(tool, /, **args):
    result = asyncio.run(mcp.call_tool(tool, args))
    if result.structured_content is not None:
        data = result.structured_content
        # Non-object return types are wrapped as {"result": ...}
        return data["result"] if set(data) == {"result"} else data
    return json.loads(result.content[0].text)


@pytest.fixture
def seeded(client):
    call("create_user", name="Alice Smith", email="alice@example.com")
    call("create_user", name="Bob")
    trip = call("create_trip", name="Lake", members=["Alice Smith"])
    return trip


def test_create_trip_and_add_items_by_name(seeded):
    trip = call(
        "add_items",
        trip="Lake",
        items=[
            {"name": "Stove", "category": "Cooking", "count": 2, "owner": "Bob"},
            {"name": "Tent", "category": "Shelter", "status": "owned"},
            {"name": "Stove", "category": "Cooking", "owner": "alice smith"},
        ],
    )
    cats = {c["category"]: c["items"] for c in trip["categories"]}
    assert set(cats) == {"Cooking", "Shelter"}
    [stove] = cats["Cooking"]  # the second Stove became Alice's claim on the same item
    assert (stove["target"], stove["covered"]) == (3, 3)
    assert [(b["who"], b["count"]) for b in stove["bringing"]] == [("Bob", 2), ("Alice Smith", 1)]
    assert cats["Shelter"][0]["bringing"] == [] and cats["Shelter"][0]["short"] == 1
    assert set(trip["members"]) == {"Alice Smith", "Bob"}  # owners join
    # library remembers new supplies/categories
    assert [s["name"] for s in call("search_library", kind="supplies")] == ["Stove", "Tent"]


def _find(trip, name):
    return next(i for c in trip["categories"] for i in c["items"] if i["name"] == name)


def test_update_items_splits_and_ambiguity(seeded):
    call("add_items", trip="Lake", items=[{"name": "Water", "count": 6}, {"name": "Stove"}, {"name": "Stove", "category": "Cooking"}])
    trip = call("update_items", trip="Lake", changes=[{"item": "Water", "bringing": [{"who": "Alice Smith", "count": 4}, {"who": "Bob"}]}])
    water = _find(trip, "Water")
    assert [(b["who"], b["count"]) for b in water["bringing"]] == [("Alice Smith", 4), ("Bob", 2)]
    assert water["short"] == 0 and not water["packed"]

    trip = call("update_items", trip="Lake", changes=[{"item": "Water", "packed": True}])
    water = _find(trip, "Water")
    assert water["packed"] and all(b["status"] == "owned" for b in water["bringing"])

    trip = call("update_items", trip="Lake", changes=[{"item": "Water", "bringing": [{"who": "Bob", "count": 0}]}])
    assert _find(trip, "Water")["short"] == 2

    with pytest.raises(ToolError, match="appears 2 times"):
        call("update_items", trip="Lake", changes=[{"item": "Stove", "packed": True}])


def test_per_person_items(seeded):
    call("create_supply", name="Sleeping bag", per_person=True)
    trip = call("add_items", trip="Lake", items=[{"name": "Sleeping bag"}])
    bag = _find(trip, "Sleeping bag")
    assert bag["per_person"] and bag["target"] == 1  # one member so far
    trip = call("update_trip", trip="Lake", add_members=["Bob"])
    assert _find(trip, "Sleeping bag")["target"] == 2
    call("update_items", trip="Lake", changes=[{"item": "Sleeping bag", "bringing": [{"who": "Bob"}]}])
    gaps = call("trip_gaps", trip="Lake")
    assert gaps["short"] == [{"name": "Sleeping bag", "category": "Uncategorized", "missing": 1, "missing_people": ["Alice Smith"]}]


def test_errors_are_readable(seeded):
    with pytest.raises(ToolError, match="No trip matches 'Nowhere'"):
        call("get_trip", trip="Nowhere")
    with pytest.raises(ToolError, match="No user matches"):
        call("add_items", trip="Lake", items=[{"name": "Rope", "owner": "Zed"}])


def test_gaps_sets_and_templates(seeded):
    call("add_items", trip="Lake", items=[{"name": "Rope", "owner": "Bob"}, {"name": "Map", "owner": "Alice Smith", "status": "owned"}, {"name": "Tarp"}])
    call("add_categories", trip="Lake", categories=["First Aid"])
    gaps = call("trip_gaps", trip="Lake")
    assert gaps["to_buy"] == ["Rope (Bob)"]
    assert [i["name"] for i in gaps["short"]] == ["Tarp"]
    assert gaps["empty_categories"] == ["First Aid"]
    assert gaps["bringing_by_person"] == {"Alice Smith": ["Map (owned)"], "Bob": ["Rope (needed)"]}

    call("save_trip_as_standard_set", trip="Lake", name="Basics")
    new = call("create_trip", name="River", template_trip="Lake", start_date="2027-06-01")
    assert new["start_date"] == "2027-06-01"
    assert new["totals"]["items"] == 3 and new["totals"]["short"] == 3

    empty = call("create_trip", name="Beach", standard_sets=["Basics"])
    assert empty["totals"]["items"] == 3


def test_remove_and_rename(seeded):
    call("add_items", trip="Lake", items=[{"name": "Rope", "category": "Gear"}])
    call("rename_library_entry", kind="category", entry="Gear", new_name="Equipment")
    trip = call("get_trip", trip="Lake")
    assert [c["category"] for c in trip["categories"]] == ["Equipment"]
    trip = call("remove_items", trip="Lake", items=["Rope"])
    assert trip["totals"]["items"] == 0
    trip = call("remove_category_from_trip", trip="Lake", category="Equipment")
    assert trip["categories"] == []


def test_trip_resource_markdown(seeded):
    from app.mcp_server import trip_markdown
    from app.storage import get_db

    call("add_items", trip="Lake", items=[{"name": "Tent", "category": "Shelter", "count": 2}, {"name": "Stove", "owner": "Bob"}])
    db = get_db()
    md = trip_markdown(db, db.trips.all()[0])
    assert "# Lake" in md and "## Shelter" in md and "- [ ] Tent 0/2 — unclaimed" in md
    assert "- [ ] Stove 1/1 — Bob (needed)" in md


INIT = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}},
}
HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


def test_http_endpoint_and_token(client, monkeypatch):
    r = client.post("/mcp", json=INIT, headers={**HEADERS, "Host": "192.168.1.10:8085"})
    assert r.status_code == 200, r.text
    assert r.json()["result"]["serverInfo"]["name"] == "supply-planner"

    monkeypatch.setenv("MCP_TOKEN", "s3cret")
    assert client.post("/mcp", json=INIT, headers=HEADERS).status_code == 401
    r = client.post("/mcp", json=INIT, headers={**HEADERS, "Authorization": "Bearer s3cret"})
    assert r.status_code == 200
    # REST API stays open (token only guards MCP)
    assert client.get("/api/trips").status_code == 200


def test_move_items_and_categories(seeded):
    call("add_items", trip="Lake", items=[{"name": "Stove", "category": "Cooking"}, {"name": "Pot", "category": "Cooking"}, {"name": "Tent", "category": "Shelter"}])
    trip = call("move_items", trip="Lake", items=["Pot"], before="Stove")
    assert [i["name"] for i in trip["categories"][0]["items"]] == ["Pot", "Stove"]
    trip = call("move_items", trip="Lake", items=["Stove"], category="Shelter")
    cats = {c["category"]: [i["name"] for i in c["items"]] for c in trip["categories"]}
    assert cats == {"Cooking": ["Pot"], "Shelter": ["Tent", "Stove"]}
    trip = call("move_category", trip="Lake", category="Shelter", before="Cooking")
    assert [c["category"] for c in trip["categories"]] == ["Shelter", "Cooking"]


def test_update_library_defaults(seeded):
    call("create_supply", name="Stove", default_category="Cooking")
    call("create_supply", name="Rope", default_category="Misc")
    call("add_items", trip="Lake", items=[
        {"name": "Stove", "category": "Kitchen"},
        {"name": "Rope", "category": "Kitchen"},
        {"name": "Rope", "category": "Shelter"},
    ])
    result = call("update_library_defaults", trip="Lake")
    assert result == {"updated": [{"name": "Stove", "default_category": "Kitchen"}], "ambiguous": ["Rope"]}
    result = call("update_library_defaults", trip="Lake", category="Shelter")
    assert result["updated"] == [{"name": "Rope", "default_category": "Shelter"}]
