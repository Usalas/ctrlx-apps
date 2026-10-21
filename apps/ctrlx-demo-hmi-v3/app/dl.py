"""Thread-safe ctrlX Data Layer access for the HMI (browse, read, typed write).

Every call carries the browser user's JWT (set_auth_token), so the Data Layer
enforces that user's read/write permissions, not the app's.
"""

import json
import os
import threading

import ctrlxdatalayer
from ctrlxdatalayer.variant import Result, Variant, VariantType

_INT_RANGES = {
    VariantType.INT8: ("set_int8", -2**7, 2**7 - 1), VariantType.UINT8: ("set_uint8", 0, 2**8 - 1),
    VariantType.INT16: ("set_int16", -2**15, 2**15 - 1), VariantType.UINT16: ("set_uint16", 0, 2**16 - 1),
    VariantType.INT32: ("set_int32", -2**31, 2**31 - 1), VariantType.UINT32: ("set_uint32", 0, 2**32 - 1),
    VariantType.INT64: ("set_int64", -2**63, 2**63 - 1), VariantType.UINT64: ("set_uint64", 0, 2**64 - 1),
}
_GETTERS = {
    VariantType.INT8: "get_int8", VariantType.UINT8: "get_uint8",
    VariantType.INT16: "get_int16", VariantType.UINT16: "get_uint16",
    VariantType.INT32: "get_int32", VariantType.UINT32: "get_uint32",
    VariantType.INT64: "get_int64", VariantType.UINT64: "get_uint64",
    VariantType.FLOAT32: "get_float32", VariantType.FLOAT64: "get_float64",
}


class WriteError(ValueError):
    pass


def connection_string():
    if "SNAP" in os.environ:
        return "ipc://"
    ip = os.getenv("DL_IP", "10.0.2.2")
    user = os.getenv("DL_USER", "boschrexroth")
    pw = os.getenv("DL_PASSWORD", "boschrexroth")
    port = os.getenv("DL_SSL_PORT", "8443")
    cs = f"tcp://{user}:{pw}@{ip}"
    return cs if port == "443" else f"{cs}?sslport={port}"


def to_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    s = str(value).strip().lower()
    if s in ("1", "true", "on", "yes"):
        return True
    if s in ("0", "false", "off", "no", ""):
        return False
    raise WriteError(f"'{value}' is not a boolean")


def variant_info(var: Variant):
    """-> (type_name, numeric_or_None, text)"""
    vt = var.get_type()
    name = vt.name.lower()
    if vt in _GETTERS:
        v = getattr(var, _GETTERS[vt])()
        return name, float(v), (f"{v:.6g}" if isinstance(v, float) else str(v))
    if vt == VariantType.BOOL8:
        b = var.get_bool8()
        return name, 1.0 if b else 0.0, "true" if b else "false"
    if vt == VariantType.STRING:
        return name, None, var.get_string()
    if vt == VariantType.TIMESTAMP:
        return name, None, var.get_datetime().isoformat()
    return name, None, f"({name})"


def fill_variant(var: Variant, vtype: VariantType, value):
    """Set `value` on `var` using the node's existing type."""
    try:
        if vtype == VariantType.BOOL8:
            return var.set_bool8(to_bool(value))
        if vtype in _INT_RANGES:
            setter, lo, hi = _INT_RANGES[vtype]
            iv = int(float(value)) if not isinstance(value, bool) else int(value)
            if float(value) != iv:
                raise WriteError(f"'{value}' is not an integer")
            if not lo <= iv <= hi:
                raise WriteError(f"{iv} is outside {vtype.name.lower()} range {lo}..{hi}")
            return getattr(var, setter)(iv)
        if vtype == VariantType.FLOAT32:
            return var.set_float32(float(value))
        if vtype == VariantType.FLOAT64:
            return var.set_float64(float(value))
        if vtype == VariantType.STRING:
            return var.set_string(str(value))
    except (TypeError, ValueError) as exc:
        if isinstance(exc, WriteError):
            raise
        raise WriteError(f"'{value}' does not fit type {vtype.name.lower()}") from None
    raise WriteError(f"writing {vtype.name.lower()} nodes is not supported by the HMI")


class DataLayer:
    def __init__(self):
        self._lock = threading.Lock()
        self._system = ctrlxdatalayer.system.System("")
        self._system.start(False)
        self._client = None

    def _client_for(self, token):
        if self._client is None or not self._client.is_connected():
            if self._client is not None:
                self._client.close()
            self._client = self._system.factory().create_client(connection_string())
        if not self._client.is_connected():
            raise ConnectionError("ctrlX Data Layer not reachable")
        if token:
            self._client.set_auth_token(token)
        return self._client

    def browse(self, path, token):
        with self._lock:
            c = self._client_for(token)
            r, var = c.browse_sync(path)
            with var:
                if r != Result.OK:
                    return {"ok": False, "error": r.name, "children": []}
                return {"ok": True, "children": sorted(var.get_array_string() or [])}

    def read_many(self, paths, token):
        out = []
        with self._lock:
            c = self._client_for(token)
            for p in paths:
                r, var = c.read_sync(p)
                with var:
                    if r != Result.OK:
                        out.append({"path": p, "ok": False, "error": r.name})
                        continue
                    try:
                        t, num, text = variant_info(var)
                        out.append({"path": p, "ok": True, "type": t, "value": num, "text": text})
                    except Exception as exc:
                        out.append({"path": p, "ok": False, "error": str(exc)})
        return out

    def write(self, path, value, token):
        """Write `value` using the node's current type (read first)."""
        with self._lock:
            c = self._client_for(token)
            r, cur = c.read_sync(path)
            with cur:
                if r != Result.OK:
                    return {"ok": False, "error": f"read before write failed: {r.name}"}
                vtype = cur.get_type()
            with Variant() as var:
                try:
                    res = fill_variant(var, vtype, value)
                except WriteError as exc:
                    return {"ok": False, "error": str(exc)}
                if res != Result.OK:
                    return {"ok": False, "error": res.name}
                r, _ = c.write_sync(path, var)
                return {"ok": r == Result.OK, "error": None if r == Result.OK else r.name}

    def close(self):
        with self._lock:
            if self._client is not None:
                self._client.close()
                self._client = None
            self._system.stop(False)
