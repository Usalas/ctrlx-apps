"""Fake Data Layer for UI development without a ctrlX (DLTREND_MOCK=1). Not used in the snap."""

import math
import random
import time

_T0 = time.time()


def _t():
    return time.time() - _T0


_LEAVES = {
    "framework/metrics/system/cpu-utilisation-percent": ("float64", lambda: 22 + 12 * math.sin(_t() / 9) + random.uniform(-3, 3)),
    "framework/metrics/system/memused-percent": ("float64", lambda: 41 + 3 * math.sin(_t() / 30)),
    "framework/metrics/system/memavailable-mb": ("float64", lambda: 2380 - 60 * math.sin(_t() / 30)),
    "framework/metrics/system/memused-mb": ("float64", lambda: 1650 + 60 * math.sin(_t() / 30)),
    "framework/metrics/system/memtotal-mb": ("float64", lambda: 4030.0),
    "framework/state": ("string", lambda: "running"),
    "motion/axs/Axis_1/state/values/actual/pos": ("float64", lambda: 180 * math.sin(_t() / 6)),
    "motion/axs/Axis_1/state/values/actual/vel": ("float64", lambda: 30 * math.cos(_t() / 6)),
    "plc/app/Application/sym/PLC_PRG/iCounter": ("int32", lambda: int(_t() * 10) % 1000),
    "plc/app/Application/sym/PLC_PRG/bRunning": ("bool8", lambda: int(_t() / 5) % 2 == 0),
    "diagnosis/temperature": ("float32", lambda: 47.5 + random.uniform(-0.4, 0.4)),
}


def _children(path):
    path = path.strip("/")
    prefix = path + "/" if path else ""
    kids = set()
    for leaf in _LEAVES:
        if leaf.startswith(prefix) and leaf != path:
            kids.add(leaf[len(prefix):].split("/")[0])
    return sorted(kids)


class MockDataLayer:
    def browse(self, path, token):
        kids = _children(path)
        if not kids and path.strip("/") not in _LEAVES:
            return {"ok": False, "error": "DL_INVALID_ADDRESS", "children": []}
        return {"ok": True, "children": kids}

    def read_many(self, paths, token):
        out = []
        for p in paths:
            if p not in _LEAVES:
                out.append({"path": p, "ok": False, "error": "DL_INVALID_ADDRESS"})
                continue
            tname, fn = _LEAVES[p]
            v = fn()
            if isinstance(v, bool):
                out.append({"path": p, "ok": True, "type": tname, "value": 1.0 if v else 0.0, "text": str(v).lower()})
            elif isinstance(v, (int, float)):
                out.append({"path": p, "ok": True, "type": tname, "value": float(v), "text": f"{v:.4g}"})
            else:
                out.append({"path": p, "ok": True, "type": tname, "value": None, "text": v})
        return out

    def close(self):
        pass
