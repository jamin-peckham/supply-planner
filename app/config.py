import os
from pathlib import Path

DATA_DIR = Path(os.environ.get("DATA_DIR", "data")).resolve()
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
