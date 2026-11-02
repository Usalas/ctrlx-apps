"""STL files, scene and settings stored in the ctrlX active configuration."""

import json
import os
import re
import tempfile
from pathlib import Path

APP_NAME = os.environ.get("SNAP_INSTANCE_NAME", "ctrlx-demo-3dviewer")
MODEL_NAME = re.compile(r"^[\w\-. ()]{1,120}\.stl$", re.I)

DEFAULT_SCENE = {"version": 1, "units": "mm", "parts": [], "frames": {}, "overlay": {}}
DEFAULT_SETTINGS = {"safeAreaNodes": [], "pointNodes": [], "autoDiscover": True}


def data_dir():
    """Prefer the active solution so models and scene are saved/restored with the ctrlX configuration."""
    if os.environ.get("STLM_DATA"):
        return Path(os.environ["STLM_DATA"])
    snap_common = os.environ.get("SNAP_COMMON")
    if snap_common:
        solution = Path(snap_common) / "solutions" / "activeConfiguration"
        if solution.is_dir():
            return solution / APP_NAME
        return Path(snap_common) / "data"
    return Path(__file__).resolve().parent.parent / "data"


class Storage:
    def __init__(self, root=None):
        self.root = Path(root or data_dir())
        self.models = self.root / "models"
        self.models.mkdir(parents=True, exist_ok=True)
        self.scene_file = self.root / "scene.json"
        self.settings_file = self.root / "settings.json"

    def model_path(self, name):
        if not MODEL_NAME.match(name or "") or name.startswith("."):
            raise ValueError(f"invalid model name: {name!r}")
        return self.models / name

    def list_models(self):
        items = []
        for path in sorted(self.models.glob("*")):
            if path.is_file() and path.suffix.lower() == ".stl":
                stat = path.stat()
                items.append({"name": path.name, "size": stat.st_size, "modified": stat.st_mtime})
        return items

    def _read_json(self, path, default):
        try:
            with open(path, encoding="utf-8") as f:
                return {**default, **json.load(f)}
        except FileNotFoundError:
            return dict(default)

    def _write_json(self, path, data):
        fd, tmp = tempfile.mkstemp(dir=self.root, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)

    def load_scene(self):
        return self._read_json(self.scene_file, DEFAULT_SCENE)

    def save_scene(self, scene):
        if not isinstance(scene, dict) or not isinstance(scene.get("parts"), list):
            raise ValueError("scene must be an object with a 'parts' list")
        self._write_json(self.scene_file, scene)

    def load_settings(self):
        return self._read_json(self.settings_file, DEFAULT_SETTINGS)

    def save_settings(self, settings):
        clean = {
            "safeAreaNodes": [str(s).strip() for s in settings.get("safeAreaNodes", []) if str(s).strip()],
            "pointNodes": [str(s).strip() for s in settings.get("pointNodes", []) if str(s).strip()],
            "autoDiscover": bool(settings.get("autoDiscover", True)),
        }
        self._write_json(self.settings_file, clean)
        return clean
