"""Persistence of HMI screens.

Preferred location is the active ctrlX Solution (plug `active-solution`), so screens are
saved/loaded/backed up together with the project:
    $SNAP_COMMON/solutions/activeConfiguration/<snap-name>/screens.json
If the Solutions interface is not connected, falls back to $SNAP_COMMON/hmi/screens.json.
Written only when the user presses Save (no cyclic flash writes).
"""

import json
import os
import tempfile
import threading

MAX_BYTES = 2 * 1024 * 1024
_lock = threading.Lock()


def _snap_name():
    return os.getenv("SNAP_INSTANCE_NAME", "ctrlx-demo-hmi")


def location():
    common = os.getenv("SNAP_COMMON")
    if common:
        active = os.path.join(common, "solutions", "activeConfiguration")
        if os.path.isdir(active):
            return os.path.join(active, _snap_name()), "solution"
        return os.path.join(common, "hmi"), "local"
    return os.path.join(os.path.dirname(__file__), "..", "data"), "dev"


def _empty():
    return {"version": 1, "screens": [{"id": "s1", "name": "Main", "widgets": []}]}


def validate(doc):
    if not isinstance(doc, dict) or not isinstance(doc.get("screens"), list) or not doc["screens"]:
        raise ValueError("document must be an object with a non-empty 'screens' list")
    for s in doc["screens"]:
        if not isinstance(s, dict) or not isinstance(s.get("widgets"), list) or not isinstance(s.get("name"), str):
            raise ValueError("each screen needs 'name' and a 'widgets' list")
    return doc


def load():
    d, kind = location()
    path = os.path.join(d, "screens.json")
    with _lock:
        try:
            with open(path, encoding="utf-8") as f:
                doc = validate(json.load(f))
        except FileNotFoundError:
            doc = _empty()
        except (ValueError, json.JSONDecodeError) as exc:
            print("WARNING screens.json unreadable, starting empty:", exc, flush=True)
            doc = _empty()
    return {"doc": doc, "location": kind, "path": path}


def save(raw: bytes):
    if len(raw) > MAX_BYTES:
        raise ValueError("HMI document too large (max 2 MB)")
    doc = validate(json.loads(raw))
    d, kind = location()
    with _lock:
        os.makedirs(d, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=d, prefix=".screens.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(doc, f, indent=1)  # human-readable, diff-friendly in Solutions
            os.chmod(tmp, 0o640)
            os.replace(tmp, os.path.join(d, "screens.json"))  # atomic
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
    return {"ok": True, "location": kind}
