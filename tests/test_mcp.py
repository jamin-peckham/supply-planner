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
    assert [(i["name"], i["count"], i["owner"]) for i in cats["Cooking"]] == [("Stove", 2, "Bob"), ("Stove", 1, "Alice Smith")]
    assert set(trip["members"]) == {"Alice Smith", "Bob"}  # owners join
    # library remembers new supplies/categories
    assert [s["name"] for s in call("search_library", kind="supplies")] == ["Stove", "Tent"]


def test_update_items_by_name_and_ambiguity(seeded):
    call("add_items", trip="Lake", items=[{"name": "Tent"}, {"name": "Stove"}, {"name": "Stove"}])
    trip = call("update_items", trip="Lake", changes=[{"item": "Tent", "packed": True, "owner": "Bob", "status": "owned"}])
    tent = next(i for c in trip["categories"] for i in c["items"] if i["name"] == "Tent")
    assert tent["packed"] and tent["owner"] == "Bob" and tent["status"] == "owned"

    with pytest.raises(ToolError, match="appears 2 times"):
        call("update_items", trip="Lake", changes=[{"item": "Stove", "packed": True}])

    trip = call("update_items", trip="Lake", changes=[{"item": "Tent", "owner": "none"}])
    tent = next(i for c in trip["categories"] for i in c["items"] if i["name"] == "Tent")
    assert tent["owner"] is None


def test_errors_are_readable(seeded):
    with pytest.raises(ToolError, match="No trip matches 'Nowhere'"):
        call("get_trip", trip="Nowhere")
    with pytest.raises(ToolError, match="No user matches"):
        call("add_items", trip="Lake", items=[{"name": "Rope", "owner": "Zed"}])


def test_gaps_sets_and_templates(seeded):
    call("add_items", trip="Lake", items=[{"name": "Rope", "owner": "Bob"}, {"name": "Map", "status": "owned"}])
    call("add_categories", trip="Lake", categories=["First Aid"])
    gaps = call("trip_gaps", trip="Lake")
    assert [i["name"] for i in gaps["needed"]] == ["Rope"]
    assert [i["name"] for i in gaps["unassigned"]] == ["Map"]
    assert gaps["empty_categories"] == ["First Aid"]
    assert gaps["bringing_by_person"] == {"Alice Smith": [], "Bob": ["Rope"]}

    call("save_trip_as_standard_set", trip="Lake", name="Basics")
    new = call("create_trip", name="River", template_trip="Lake", start_date="2027-06-01")
    assert new["start_date"] == "2027-06-01"
    assert new["totals"]["items"] == 2 and new["totals"]["unassigned"] == 2

    empty = call("create_trip", name="Beach", standard_sets=["Basics"])
    assert empty["totals"]["items"] == 2


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

    call("add_items", trip="Lake", items=[{"name": "Tent", "category": "Shelter", "count": 2}])
    db = get_db()
    md = trip_markdown(db, db.trips.all()[0])
    assert "# Lake" in md and "## Shelter" in md and "- [ ] Tent ×2 (needed)" in md


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
