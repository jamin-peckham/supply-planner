from app.models import UNCATEGORIZED_ID


def test_uncategorized_is_seeded_and_protected(client):
    cats = client.get("/api/categories").json()
    assert [c["id"] for c in cats] == [UNCATEGORIZED_ID]
    assert client.delete(f"/api/categories/{UNCATEGORIZED_ID}").status_code == 400
    r = client.patch(f"/api/categories/{UNCATEGORIZED_ID}", json={"display_name": "Misc"})
    assert r.json()["display_name"] == "Misc"


def test_user_crud(client, make):
    u = make.user("Alice", "a@example.com")
    assert u["id"] and u["email"] == "a@example.com"
    r = client.patch(f"/api/users/{u['id']}", json={"display_name": "Alicia"})
    assert r.json()["display_name"] == "Alicia" and r.json()["email"] == "a@example.com"
    assert client.delete(f"/api/users/{u['id']}").status_code == 204
    assert client.get(f"/api/users/{u['id']}").status_code == 404


def test_empty_name_rejected(client):
    assert client.post("/api/users", json={"display_name": "  "}).status_code == 422


def test_supply_requires_existing_category(client):
    r = client.post("/api/supplies", json={"display_name": "X", "default_category_id": "nope"})
    assert r.status_code == 404


def test_supply_search_and_archive(client, make):
    s = make.supply("Camp Stove")
    make.supply("Tent")
    assert [x["display_name"] for x in client.get("/api/supplies?q=stove").json()] == ["Camp Stove"]
    # unused -> hard delete
    assert client.delete(f"/api/supplies/{s['id']}").json() == {"archived": False, "deleted": True}


def test_persistence_survives_restart(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app import config
    from app.main import app

    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    with TestClient(app) as c:
        uid = c.post("/api/users", json={"display_name": "Bob"}).json()["id"]
    assert (tmp_path / "users" / f"{uid}.yaml").exists()
    with TestClient(app) as c:
        assert c.get(f"/api/users/{uid}").json()["display_name"] == "Bob"


def test_standard_set_normalizes_categories(client, make):
    cat = make.category("Cooking")
    s = make.supply("Stove", cat["id"])
    r = client.post(
        "/api/standard-sets",
        json={"display_name": "Base", "supplies": [{"supply_id": s["id"], "category_id": cat["id"]}]},
    )
    assert r.status_code == 201
    assert r.json()["category_ids"] == [cat["id"]]
