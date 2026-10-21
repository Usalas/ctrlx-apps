"""Thin, thread-safe wrapper around the ctrlX Data Layer client.

Every call takes the browser user's JWT and sets it on the client before the
request, so the Data Layer enforces *that user's* permissions (not the app's).
"""

import json
import os
import threading

import ctrlxdatalayer
from ctrlxdatalayer.variant import Result, Variant, VariantType

_NUMERIC = {
    VariantType.INT8: "get_int8", VariantType.UINT8: "get_uint8",
    VariantType.INT16: "get_int16", VariantType.UINT16: "get_uint16",
    VariantType.INT32: "get_int32", VariantType.UINT32: "get_uint32",
    VariantType.INT64: "get_int64", VariantType.UINT64: "get_uint64",
    VariantType.FLOAT32: "get_float32", VariantType.FLOAT64: "get_float64",
}
_ARRAYS = {
    VariantType.ARRAY_BOOL8: "get_array_bool8",
    VariantType.ARRAY_INT8: "get_array_int8", VariantType.ARRAY_UINT8: "get_array_uint8",
    VariantType.ARRAY_INT16: "get_array_int16", VariantType.ARRAY_UINT16: "get_array_uint16",
    VariantType.ARRAY_INT32: "get_array_int32", VariantType.ARRAY_UINT32: "get_array_uint32",
    VariantType.ARRAY_INT64: "get_array_int64", VariantType.ARRAY_UINT64: "get_array_uint64",
    VariantType.ARRAY_FLOAT32: "get_array_float32", VariantType.ARRAY_FLOAT64: "get_array_float64",
    VariantType.ARRAY_STRING: "get_array_string",
}


def connection_string():
    """ipc:// inside the snap; tcp:// to a remote ctrlX when developing."""
    if "SNAP" in os.environ:
        return "ipc://"
    ip = os.getenv("DL_IP", "10.0.2.2")            # COREvirtual with port forwarding
    user = os.getenv("DL_USER", "boschrexroth")
    pw = os.getenv("DL_PASSWORD", "boschrexroth")
    port = os.getenv("DL_SSL_PORT", "8443")
    cs = f"tcp://{user}:{pw}@{ip}"
    return cs if port == "443" else f"{cs}?sslport={port}"


def variant_to_json(var: Variant):
    """-> (type_name, numeric_value_or_None, display_text)"""
    vt = var.get_type()
    name = vt.name.lower()
    if vt in _NUMERIC:
        v = getattr(var, _NUMERIC[vt])()
        return name, float(v), f"{v:.4g}" if isinstance(v, float) else str(v)
    if vt == VariantType.BOOL8:
        b = var.get_bool8()
        return name, 1.0 if b else 0.0, "true" if b else "false"
    if vt == VariantType.STRING:
        return name, None, var.get_string()
    if vt == VariantType.TIMESTAMP:
        return name, None, var.get_datetime().isoformat()
    if vt in _ARRAYS:
        arr = getattr(var, _ARRAYS[vt])()
        txt = json.dumps(arr[:20]) + (" …" if len(arr) > 20 else "")
        return name, None, f"[{len(arr)}] {txt}"
    if vt == VariantType.FLATBUFFERS:
        return name, None, "(flatbuffers – see JSON)"
    return name, None, f"({name})"


class DataLayer:
    def __init__(self):
        self._lock = threading.Lock()
        self._system = ctrlxdatalayer.system.System("")
        self._system.start(False)
        self._client = None
        self._conv = self._system.json_converter()

    def _ensure_client(self):
        if self._client is not None and self._client.is_connected():
            return self._client
        if self._client is not None:
            self._client.close()
        self._client = self._system.factory().create_client(connection_string())
        return self._client

    def _with_token(self, token):
        client = self._ensure_client()
        if not client.is_connected():
            raise ConnectionError("ctrlX Data Layer not reachable")
        if token:
            client.set_auth_token(token)
        return client

    def browse(self, path: str, token: str):
        with self._lock:
            client = self._with_token(token)
            result, var = client.browse_sync(path)
            with var:
                if result != Result.OK:
                    return {"ok": False, "error": result.name, "children": []}
                return {"ok": True, "children": sorted(var.get_array_string() or [])}

    def read_many(self, paths, token: str):
        out = []
        with self._lock:
            client = self._with_token(token)
            for p in paths:
                result, var = client.read_sync(p)
                with var:
                    if result != Result.OK:
                        out.append({"path": p, "ok": False, "error": result.name})
                        continue
                    try:
                        tname, num, text = variant_to_json(var)
                        if tname == "flatbuffers":
                            r2, jv = client.read_json_sync(self._conv, p, 0)
                            with jv:
                                if r2 == Result.OK:
                                    text = jv.get_string()[:300]
                        out.append({"path": p, "ok": True, "type": tname, "value": num, "text": text})
                    except Exception as exc:  # unexpected type: never break the whole poll
                        out.append({"path": p, "ok": False, "error": str(exc)})
        return out

    def close(self):
        with self._lock:
            if self._client is not None:
                self._client.close()
                self._client = None
            self._conv = None
            self._system.stop(False)
