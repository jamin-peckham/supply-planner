import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    with TestClient(app) as c:
        yield c


@pytest.fixture
def make(client):
    """Small helpers for creating library objects."""

    class Make:
        def user(self, name="Alice", email=""):
            return client.post("/api/users", json={"display_name": name, "email": email}).json()

        def category(self, name="Cooking"):
            return client.post("/api/categories", json={"display_name": name}).json()

        def supply(self, name="Stove", category_id=None, default_count=1):
            body = {"display_name": name, "default_count": default_count}
            if category_id:
                body["default_category_id"] = category_id
            return client.post("/api/supplies", json=body).json()

        def trip(self, name="Lake", **kw):
            return client.post("/api/trips", json={"display_name": name, **kw}).json()

    return Make()
