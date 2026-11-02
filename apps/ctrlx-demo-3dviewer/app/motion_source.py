"""Sources of motion data: the ctrlX Data Layer, or a built-in simulation.

Both sources expose the same blocking interface; the web server calls them
from a single worker thread.
"""

import json
import logging
import math
import os
import re
import time

log = logging.getLogger("motion")

AXES_ROOT = "motion/axs"
AXIS_POS_NODE = "motion/axs/{name}/state/values/actual/pos"
KINS_ROOT = "motion/kin"
# Tried in order; the first one that answers is remembered per kinematics
KIN_POS_NODES = (
    "motion/kin/{name}/state/values/actual/pos",  # array of double (MCS, up to 16 entries)
    "motion/kin/{name}/state/values/actual",      # KinActualValues flatbuffer
)

# Nodes searched when looking for teach points / safe areas (see discover_nodes)
SAFE_AREA_NAME = re.compile(r"safe.?area", re.I)
POINT_NAME = re.compile(r"^(points?|pnts?|teach.?points?)$", re.I)

SAFE_AREA_TYPES = {0: "SAFE_AREA", 1: "WORK_AREA_EXCL", 2: "WORK_AREA_INCL"}
REFERENCE_SYSTEMS = {0: "UNDEFINED", 1: "CUSTOM", 2: "ACS", 3: "MCS"}


def _pick(obj, *keys, default=None):
    """Return the first present key; tolerates camelCase / snake_case variants."""
    if not isinstance(obj, dict):
        return default
    for key in keys:
        for variant in (key, _snake(key), key.lower()):
            if variant in obj:
                return obj[variant]
    return default


def _snake(name):
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def normalize_safe_areas(data, source):
    """Turn a SysCfgSafeAreaAll (as JSON) into a flat list of areas."""
    areas = _pick(data, "safeAreas", default=None)
    if areas is None:
        areas = data if isinstance(data, list) else [data]
    result = []
    for i, area in enumerate(areas or []):
        if not isinstance(area, dict):
            continue
        area_type = _pick(area, "type", default=0)
        if isinstance(area_type, int):
            area_type = SAFE_AREA_TYPES.get(area_type, str(area_type))
        boxes = []
        for box in _pick(area, "box", default=[]) or []:
            boxes.append({
                "min": float(_pick(box, "min", default=0.0) or 0.0),
                "max": float(_pick(box, "max", default=0.0) or 0.0),
                "unit": _pick(box, "unit", default="") or "",
                "active": bool(_pick(box, "active", default=False)),
            })
        result.append({
            "source": source,
            "name": _pick(area, "name", default=None) or f"area{i + 1}",
            "coordSystem": _pick(area, "coordSystem", default="MCS") or "MCS",
            "type": area_type,
            "box": boxes,
        })
    return result


def normalize_points(data, source):
    """Turn a PointCollection (as JSON) into a flat list of points."""
    points = _pick(data, "points", default=None)
    if points is None:
        points = data if isinstance(data, list) else [data]
    result = []
    for i, point in enumerate(points or []):
        if not isinstance(point, dict):
            continue
        position = _pick(point, "position", default={}) or {}
        entries = _pick(position, "entries", default=None)
        if entries is None and isinstance(position, list):
            entries = position
        ref = _pick(point, "referenceSystem", default="UNDEFINED")
        if isinstance(ref, int):
            ref = REFERENCE_SYSTEMS.get(ref, str(ref))
        result.append({
            "source": source,
            "name": _pick(point, "name", default=None) or f"P{i + 1}",
            "referenceSystem": ref,
            "description": _pick(point, "description", default="") or "",
            "entries": [{
                "meaning": str(_pick(e, "meaning", default="") or ""),
                "value": float(_pick(e, "value", default=0.0) or 0.0),
                "unit": _pick(e, "unit", default="") or "",
            } for e in (entries or []) if isinstance(e, dict)],
        })
    return result


class SimulatedSource:
    """Fake axes plus sample teach points / safe areas for development."""

    kind = "simulation"

    AXES = {
        "X": ("linear", lambda t: 250 * math.sin(t * 0.6)),
        "Y": ("linear", lambda t: 150 * math.sin(t * 0.45 + 1.0)),
        "Z": ("linear", lambda t: -60 + 60 * math.sin(t * 0.9)),
        "C": ("rotary", lambda t: (t * 30) % 360),
    }

    def __init__(self, reason=""):
        self.t0 = time.monotonic()
        self.reason = reason

    def status(self):
        return {"source": self.kind, "connected": True, "message": self.reason or "Simulated axes X, Y, Z, C"}

    def list_axes(self):
        return list(self.AXES)

    def read_axes(self, names):
        t = time.monotonic() - self.t0
        return {n: self.AXES[n][1](t) for n in names if n in self.AXES}

    def list_kins(self):
        return ["Gantry"]

    def read_kins(self, names):
        if "Gantry" not in names:
            return {}
        axes = self.read_axes(["X", "Y", "Z", "C"])
        return {"Gantry": {"pos": [axes["X"], axes["Y"], axes["Z"], axes["C"]],
                           "units": ["mm", "mm", "mm", "deg"]}}

    def use_token(self, token):
        pass

    def discover_nodes(self):
        return {"safeAreas": ["sim/safe-areas"], "points": ["sim/points"]}

    def read_json(self, address):
        if address == "sim/safe-areas":
            box = lambda lo, hi, act=True: {"min": lo, "max": hi, "unit": "mm", "active": act}
            return {"safeAreas": [
                {"name": "WorkEnvelope", "coordSystem": "MCS", "type": "WORK_AREA_INCL",
                 "box": [box(-300, 300), box(-200, 200), box(-130, 10)]},
                {"name": "ToolChanger", "coordSystem": "MCS", "type": "SAFE_AREA",
                 "box": [box(220, 300), box(120, 200), box(-130, -40)]},
                {"name": "Clamp", "coordSystem": "MCS", "type": "WORK_AREA_EXCL",
                 "box": [box(-60, 60), box(-200, -150), box(-130, -60)]},
            ]}
        if address == "sim/points":
            def pt(name, x, y, z, desc=""):
                return {"name": name, "referenceSystem": "MCS", "description": desc,
                        "position": {"entries": [
                            {"meaning": "X", "value": x, "unit": "mm"},
                            {"meaning": "Y", "value": y, "unit": "mm"},
                            {"meaning": "Z", "value": z, "unit": "mm"}]}}
            return {"points": [pt("Home", 0, 0, 0, "Home position"), pt("Pick", -200, 120, -100),
                               pt("Place", 180, -100, -90), pt("Park", 260, 160, 0)]}
        raise KeyError(address)

    def close(self):
        pass


class DataLayerSource:
    """Reads axis positions and MOTION configuration from the ctrlX Data Layer."""

    kind = "datalayer"

    def __init__(self, connection):
        import ctrlxdatalayer  # noqa: F401 - imported here so the simulation works without it
        from ctrlxdatalayer.variant import Result
        self._Result = Result
        self._dl = ctrlxdatalayer
        self.connection = connection
        self.system = ctrlxdatalayer.system.System("")
        self.system.start(False)
        self.client = None
        self.last_error = ""
        self._kin_node = {}
        self._token = ""
        self._connect()

    def _connect(self):
        if self.client is not None:
            try:
                self.client.close()
            except Exception:  # pragma: no cover - best effort
                pass
        self.client = self.system.factory().create_client(self.connection)
        self._last_connect = time.monotonic()
        self._token = ""  # a new client needs the token again

    def _ensure(self):
        if not self.client.is_connected() and time.monotonic() - self._last_connect > 5:
            log.info("Data Layer not connected, reconnecting")
            self._connect()
        return self.client.is_connected()

    def use_token(self, token):
        """Run Data Layer calls with the browser user's permissions."""
        if token and token != self._token and self.client is not None:
            self.client.set_auth_token(token)
            self._token = token

    def status(self):
        connected = self.client is not None and self.client.is_connected()
        return {"source": self.kind, "connected": connected,
                "message": self.last_error if not connected else _redact(self.connection)}

    def list_axes(self):
        if not self._ensure():
            return []
        result, var = self.client.browse_sync(AXES_ROOT)
        with var:
            if result != self._Result.OK:
                self.last_error = f"browse {AXES_ROOT}: {result}"
                return []
            return list(var.get_array_string() or [])

    def read_axes(self, names):
        values = {}
        if not names or not self._ensure():
            return values
        for name in names:
            result, var = self.client.read_sync(AXIS_POS_NODE.format(name=name))
            with var:
                if result == self._Result.OK:
                    value = _variant_number(var)
                    if value is not None:
                        values[name] = value
        return values

    def list_kins(self):
        if not self._ensure():
            return []
        return self._browse(KINS_ROOT)

    def read_kins(self, names):
        values = {}
        if not names or not self._ensure():
            return values
        for name in names:
            sample = self._read_kin(name)
            if sample is not None:
                values[name] = sample
        return values

    def _read_kin(self, name):
        node_index = self._kin_node.get(name)
        candidates = [node_index] if node_index is not None else range(len(KIN_POS_NODES))
        for index in candidates:
            address = KIN_POS_NODES[index].format(name=name)
            try:
                sample = self._read_kin_node(address)
            except Exception as exc:  # unexpected payload shape
                self.last_error = f"{address}: {exc}"
                sample = None
            if sample is not None:
                self._kin_node[name] = index
                return sample
        self._kin_node.pop(name, None)
        return None

    def _read_kin_node(self, address):
        if address.endswith("/pos"):
            result, var = self.client.read_sync(address)
            with var:
                if result != self._Result.OK:
                    return None
                pos = var.get_array_float64()
                return {"pos": list(pos), "units": []} if pos is not None else None
        conv = self.system.json_converter()
        result, text = self.client.read_json_sync(conv, address, 0)
        if result != self._Result.OK:
            return None
        data = json.loads(text)
        if isinstance(data, dict) and "value" in data and "type" in data:
            data = data["value"]
        pos = _pick(data, "actualPos", default=None)
        if pos is None:
            return None
        return {"pos": [float(v) for v in pos], "units": list(_pick(data, "actualPosUnit", default=[]) or [])}

    def _browse(self, address):
        result, var = self.client.browse_sync(address)
        with var:
            if result != self._Result.OK:
                return []
            return list(var.get_array_string() or [])

    def discover_nodes(self, root="motion", max_depth=4, max_nodes=3000):
        """Search the motion tree for nodes that look like teach points or safe areas."""
        found = {"safeAreas": [], "points": []}
        if not self._ensure():
            return found
        visited = 0
        stack = [(root, 0)]
        while stack and visited < max_nodes:
            address, depth = stack.pop()
            visited += 1
            leaf = address.rsplit("/", 1)[-1]
            if SAFE_AREA_NAME.search(leaf):
                found["safeAreas"].append(address)
                continue
            if POINT_NAME.match(leaf):
                found["points"].append(address)
                continue
            if depth >= max_depth:
                continue
            # Axis subtrees are large and contain neither points nor safe areas
            if address.startswith(AXES_ROOT + "/"):
                continue
            for child in self._browse(address):
                stack.append((f"{address}/{child}", depth + 1))
        return found

    def read_json(self, address):
        if not self._ensure():
            raise ConnectionError("Data Layer not connected")
        conv = self.system.json_converter()
        result, text = self.client.read_json_sync(conv, address, 0)
        if result != self._Result.OK:
            raise RuntimeError(f"read {address}: {result}")
        data = json.loads(text)
        # The REST-style envelope is {"type": "...", "value": {...}}
        if isinstance(data, dict) and "value" in data and "type" in data:
            data = data["value"]
        return data

    def close(self):
        try:
            if self.client is not None:
                self.client.close()
            self.system.stop(False)
            self.system.close()
        except Exception:  # pragma: no cover - best effort
            pass


def _variant_number(var):
    from ctrlxdatalayer.variant import VariantType
    t = var.get_type()
    getters = {
        VariantType.FLOAT64: var.get_float64, VariantType.FLOAT32: var.get_float32,
        VariantType.INT64: var.get_int64, VariantType.INT32: var.get_int32,
        VariantType.INT16: var.get_int16, VariantType.UINT64: var.get_uint64,
        VariantType.UINT32: var.get_uint32, VariantType.UINT16: var.get_uint16,
    }
    getter = getters.get(t)
    return float(getter()) if getter else None


def _redact(connection):
    return re.sub(r"//[^@/]*@", "//***@", connection)


def connection_string():
    """ipc:// inside the snap on the controller, tcp:// for development against a remote core."""
    if os.environ.get("SNAP"):
        return "ipc://"
    address = os.environ.get("CTRLX_ADDRESS", "192.168.1.1")
    user = os.environ.get("CTRLX_USER", "boschrexroth")
    password = os.environ.get("CTRLX_PASSWORD", "boschrexroth")
    ssl_port = os.environ.get("CTRLX_SSL_PORT", "443")
    return f"tcp://{user}:{password}@{address}?sslport={ssl_port}"


def create_source():
    mode = os.environ.get("STLM_SOURCE", "auto").lower()
    if mode == "simulation" or (mode == "auto" and not os.environ.get("SNAP") and not os.environ.get("CTRLX_ADDRESS")):
        return SimulatedSource()
    try:
        return DataLayerSource(connection_string())
    except Exception as exc:  # ctrlxdatalayer missing or native library not loadable
        log.exception("Data Layer unavailable, falling back to simulation")
        return SimulatedSource(f"Data Layer unavailable: {exc}")
