"""YAML file persistence: one file per object at <data_dir>/<kind>/<id>.yaml.

All objects are cached in memory at startup. Writes are atomic (temp file +
os.replace). A single process-wide RLock serializes every mutation, so the app
must run with one worker.
"""

import os
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path

import yaml
from pydantic import BaseModel

from .models import UNCATEGORIZED_ID, Category, StandardSet, Supply, Trip, User


class Repository[T: BaseModel]:
    def __init__(self, root: Path, kind: str, model: type[T], on_change: Callable[[], None]):
        self.dir = root / kind
        self.model = model
        self._on_change = on_change
        self.dir.mkdir(parents=True, exist_ok=True)
        self._items: dict[str, T] = {}
        for path in sorted(self.dir.glob("*.yaml")):
            with path.open(encoding="utf-8") as f:
                obj = model.model_validate(yaml.safe_load(f) or {})
            self._items[obj.id] = obj

    def all(self) -> list[T]:
        return sorted(self._items.values(), key=lambda o: o.display_name.casefold())

    def get(self, obj_id: str) -> T | None:
        return self._items.get(obj_id)

    def __contains__(self, obj_id: object) -> bool:
        return obj_id in self._items

    def save(self, obj: T) -> T:
        data = obj.model_dump(mode="json")
        fd, tmp = tempfile.mkstemp(dir=self.dir, suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)
            os.replace(tmp, self.dir / f"{obj.id}.yaml")
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
        self._items[obj.id] = obj
        self._on_change()
        return obj

    def delete(self, obj_id: str) -> None:
        self._items.pop(obj_id, None)
        (self.dir / f"{obj_id}.yaml").unlink(missing_ok=True)
        self._on_change()


class Database:
    def __init__(self, root: Path):
        self.root = root
        self.lock = threading.RLock()
        # Bumped on every save/delete; clients poll it to know when to refetch.
        # Seeded from the clock so a restart never repeats a value a client has seen.
        self.revision = time.time_ns() // 1_000_000  # ms: stays within JS safe-integer range
        self.users = Repository(root, "users", User, self._bump)
        self.categories = Repository(root, "categories", Category, self._bump)
        self.supplies = Repository(root, "supplies", Supply, self._bump)
        self.standard_sets = Repository(root, "standard_sets", StandardSet, self._bump)
        self.trips = Repository(root, "trips", Trip, self._bump)
        if UNCATEGORIZED_ID not in self.categories:
            self.categories.save(
                Category(id=UNCATEGORIZED_ID, display_name="Uncategorized", builtin=True)
            )

    def _bump(self) -> None:
        self.revision += 1


_db: Database | None = None


def init_db(root: Path) -> Database:
    global _db
    _db = Database(root)
    return _db


def get_db() -> Database:
    if _db is None:
        raise RuntimeError("Database not initialized")
    return _db
