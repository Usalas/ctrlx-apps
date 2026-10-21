"""Writable fake Data Layer for UI development without a ctrlX (HMI_MOCK=1). Removed from the snap."""

import math
import random
import threading
import time

_T0 = time.time()
_lock = threading.Lock()


def _t():
    return time.time() - _T0


_STATIC = {
    "plc/app/Application/sym/PLC_PRG/bStart": ["bool8", False],
    "plc/app/Application/sym/PLC_PRG/bStop": ["bool8", False],
    "plc/app/Application/sym/PLC_PRG/bRunning": ["bool8", False],
    "plc/app/Application/sym/PLC_PRG/rSpeedSetpoint": ["float64", 50.0],
    "plc/app/Application/sym/PLC_PRG/iMode": ["int16", 1],
    "plc/app/Application/sym/PLC_PRG/sRecipe": ["string", "Default"],
}
_DYNAMIC = {
    "framework/metrics/system/cpu-utilisation-percent": ("float64", lambda: 22 + 12 * math.sin(_t() / 9) + random.uniform(-3, 3)),
    "framework/metrics/system/memused-percent": ("float64", lambda: 41 + 3 * math.sin(_t() / 30)),
    "plc/app/Application/sym/PLC_PRG/rActualSpeed": ("float64", lambda: _speed()),
    "plc/app/Application/sym/PLC_PRG/rTemperature": ("float32", lambda: 61 + 9 * math.sin(_t() / 12)),
    "plc/app/Application/sym/PLC_PRG/iCounter": ("int32", lambda: int(_t() * 5) % 10000 if _STATIC["plc/app/Application/sym/PLC_PRG/bRunning"][1] else 0),
    "motion/axs/vMaster/state/values/actual/pos": ("float64", lambda: (_t() * 36) % 360),
}


def _speed():
    run = _STATIC["plc/app/Application/sym/PLC_PRG/bRunning"][1]
    sp = _STATIC["plc/app/Application/sym/PLC_PRG/rSpeedSetpoint"][1]
    return (sp + random.uniform(-0.5, 0.5)) if run else 0.0


def _all():
    return list(_STATIC) + list(_DYNAMIC)


def _logic():
    # tiny PLC: start/stop pushbuttons latch bRunning
    s = _STATIC
    if s["plc/app/Application/sym/PLC_PRG/bStart"][1]:
        s["plc/app/Application/sym/PLC_PRG/bRunning"][1] = True
    if s["plc/app/Application/sym/PLC_PRG/bStop"][1]:
        s["plc/app/Application/sym/PLC_PRG/bRunning"][1] = False


class MockDataLayer:
    def browse(self, path, token):
        path = path.strip("/")
        pre = path + "/" if path else ""
        kids = sorted({k[len(pre):].split("/")[0] for k in _all() if k.startswith(pre) and k != path})
        if not kids and path not in _all():
            return {"ok": False, "error": "DL_INVALID_ADDRESS", "children": []}
        return {"ok": True, "children": kids}

    def read_many(self, paths, token):
        out = []
        with _lock:
            _logic()
            for p in paths:
                if p in _STATIC:
                    t, v = _STATIC[p]
                elif p in _DYNAMIC:
                    t, v = _DYNAMIC[p][0], _DYNAMIC[p][1]()
                else:
                    out.append({"path": p, "ok": False, "error": "DL_INVALID_ADDRESS"})
                    continue
                if t == "bool8":
                    out.append({"path": p, "ok": True, "type": t, "value": 1.0 if v else 0.0, "text": str(v).lower()})
                elif t == "string":
                    out.append({"path": p, "ok": True, "type": t, "value": None, "text": v})
                else:
                    out.append({"path": p, "ok": True, "type": t, "value": float(v), "text": f"{v:.6g}" if isinstance(v, float) else str(v)})
        return out

    def write(self, path, value, token):
        with _lock:
            if path not in _STATIC:
                return {"ok": False, "error": "DL_PERMISSION_DENIED" if path in _DYNAMIC else "DL_INVALID_ADDRESS"}
            t = _STATIC[path][0]
            try:
                if t == "bool8":
                    v = str(value).strip().lower() in ("1", "true", "on", "yes")
                elif t.startswith("int"):
                    v = int(float(value))
                elif t.startswith("float"):
                    v = float(value)
                else:
                    v = str(value)
            except Exception:
                return {"ok": False, "error": f"'{value}' does not fit type {t}"}
            _STATIC[path][1] = v
            _logic()
        return {"ok": True, "error": None}

    def close(self):
        pass
