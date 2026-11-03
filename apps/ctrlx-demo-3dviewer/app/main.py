"""CtrlX 3D Viewer (ctrlX OS 4.x) - web app behind the ctrlX reverse proxy.

Serves the 3D web UI, stores STL files and the scene, and streams axis and
kinematics positions from the ctrlX Data Layer over a WebSocket.

On the device:   HTTP over Unix socket  $SNAP_DATA/package-run/<snap>/web.sock
                 reverse proxy URL      /3dviewer   (see package-manifest.json)
Developing:      HTTP on 127.0.0.1:8081 (STLM_PORT); STLM_SOURCE=simulation fakes axes,
                 kinematics, teach points and safe areas.

Every /api call needs the user's JWT (Authorization: Bearer, or ?token= for the
WebSocket); the ctrlX sidebar link passes it as ?token=${bearertoken}.
"""

import asyncio
import base64
import json
import logging
import os
import signal
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from aiohttp import WSMsgType, web

from app.motion_source import create_source, normalize_points, normalize_safe_areas
from app.storage import APP_NAME, Storage

log = logging.getLogger("3dviewer")

WWW = Path(os.environ["SNAP"]) / "www" if os.environ.get("SNAP") else Path(__file__).resolve().parent.parent / "www"
URL_PREFIX = "/3dviewer"
DEV_MODE = "SNAP" not in os.environ
RATE_HZ = float(os.environ.get("STLM_RATE_HZ", "20"))
MAX_UPLOAD = 200 * 1024 * 1024
VERSION = os.environ.get("SNAP_VERSION", "dev")


def unique(items, key):
    seen = set()
    return [i for i in items if not (key(i) in seen or seen.add(key(i)))]


def check_token(token):
    if not token:
        return (True, "") if DEV_MODE else (False, "missing token - open the 3D Viewer from the ctrlX menu")
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return False, "invalid token"
    if claims.get("exp") and claims["exp"] < time.time():
        return False, "session expired - reopen the 3D Viewer from the ctrlX menu"
    return True, ""  # node permissions are enforced by the Data Layer with this token


class App:
    def __init__(self):
        self.storage = Storage()
        self.source = create_source()
        # The Data Layer client is not shared between threads: every call goes through this one worker
        self.worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="datalayer")
        self.clients = {}  # websocket -> {"axes": set, "kins": set}
        self.discovered = {"safeAreas": [], "points": []}
        self.token = ""  # latest valid user token, handed to the Data Layer client
        log.info("Data directory: %s, source: %s", self.storage.root, self.source.kind)

    async def call(self, fn, *args):
        def with_token():
            self.source.use_token(self.token)
            return fn(*args)
        return await asyncio.get_running_loop().run_in_executor(self.worker, with_token)

    @web.middleware
    async def auth(self, request, handler):
        if "/api/" in request.path:
            header = request.headers.get("Authorization", "")
            token = header[7:].strip() if header.lower().startswith("bearer ") else request.query.get("token", "")
            ok, reason = check_token(token)
            if not ok:
                raise web.HTTPUnauthorized(text=reason)
            if token:
                self.token = token
        return await handler(request)

    # ---- static UI -----------------------------------------------------------------
    async def index(self, request):
        return web.FileResponse(WWW / "index.html", headers={"Cache-Control": "no-cache"})

    async def redirect_slash(self, request):
        # keep ?token= from the ctrlX menu link
        query = request.query_string
        raise web.HTTPFound(request.path + "/" + ("?" + query if query else ""))

    # ---- models ----------------------------------------------------------------------
    async def list_models(self, request):
        return web.json_response(self.storage.list_models())

    async def get_model(self, request):
        try:
            path = self.storage.model_path(request.match_info["name"])
        except ValueError as exc:
            raise web.HTTPBadRequest(text=str(exc))
        if not path.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(path, headers={"Content-Type": "model/stl"})

    async def upload_models(self, request):
        reader = await request.multipart()
        saved = []
        while (field := await reader.next()) is not None:
            if not field.filename:
                continue
            name = Path(field.filename).name
            try:
                path = self.storage.model_path(name)
            except ValueError as exc:
                raise web.HTTPBadRequest(text=str(exc))
            tmp = path.with_suffix(".upload")
            size = 0
            with open(tmp, "wb") as f:
                while chunk := await field.read_chunk(1 << 20):
                    size += len(chunk)
                    if size > MAX_UPLOAD:
                        f.close()
                        tmp.unlink(missing_ok=True)
                        raise web.HTTPRequestEntityTooLarge(max_size=MAX_UPLOAD, actual_size=size)
                    f.write(chunk)
            os.replace(tmp, path)
            saved.append(name)
        log.info("Uploaded %s", saved)
        return web.json_response({"saved": saved, "models": self.storage.list_models()})

    async def delete_model(self, request):
        try:
            path = self.storage.model_path(request.match_info["name"])
        except ValueError as exc:
            raise web.HTTPBadRequest(text=str(exc))
        path.unlink(missing_ok=True)
        return web.json_response(self.storage.list_models())

    # ---- scene & settings ----------------------------------------------------------
    async def get_scene(self, request):
        return web.json_response(self.storage.load_scene())

    async def put_scene(self, request):
        try:
            self.storage.save_scene(await request.json())
        except (ValueError, json.JSONDecodeError) as exc:
            raise web.HTTPBadRequest(text=str(exc))
        return web.json_response({"ok": True})

    async def get_settings(self, request):
        return web.json_response(self.storage.load_settings())

    async def put_settings(self, request):
        return web.json_response(self.storage.save_settings(await request.json()))

    # ---- motion ----------------------------------------------------------------------
    async def status(self, request):
        st = await self.call(self.source.status)
        return web.json_response({**st, "dataDir": str(self.storage.root), "rateHz": RATE_HZ, "version": VERSION})

    async def list_axes(self, request):
        axes, kins = await self.call(lambda: (self.source.list_axes(), self.source.list_kins()))
        return web.json_response({"axes": axes, "kins": kins})

    async def values(self, request):
        axes = [a for a in request.query.get("axes", "").split(",") if a]
        kins = [k for k in request.query.get("kins", "").split(",") if k]
        sample = await self.call(self._sample, axes, kins)
        return web.json_response(sample)

    def _sample(self, axes, kins):
        return {"t": time.time(), "axes": self.source.read_axes(axes), "kins": self.source.read_kins(kins)}

    async def discover(self, request=None):
        self.discovered = await self.call(self.source.discover_nodes)
        log.info("Discovered motion nodes: %s", self.discovered)
        if request is not None:
            return web.json_response(self.discovered)

    async def motion_objects(self, request):
        """Teach points and safe/work areas of ctrlX MOTION, normalized for the UI."""
        settings = self.storage.load_settings()
        area_nodes = list(dict.fromkeys(settings["safeAreaNodes"] + (self.discovered["safeAreas"] if settings["autoDiscover"] else [])))
        point_nodes = list(dict.fromkeys(settings["pointNodes"] + (self.discovered["points"] if settings["autoDiscover"] else [])))

        def read_items(node, normalize, errors):
            """Read a node holding a whole collection; if it is a folder, read its children one by one."""
            try:
                items = normalize(self.source.read_json(node), node)
                if items:
                    return items
                error = None
            except Exception as exc:
                error = exc
            items = []
            for child in self.source.browse(node):
                address = f"{node}/{child}"
                try:
                    items += normalize(self.source.read_json(address), address, default_name=child)
                except Exception as exc:
                    errors.append(f"{address}: {exc}")
            if not items and error is not None:
                errors.append(f"{node}: {error}")
            return items

        def read_all():
            out = {"safeAreas": [], "points": [], "errors": [], "nodes": {"safeAreas": area_nodes, "points": point_nodes}}
            for node in area_nodes:
                out["safeAreas"] += read_items(node, normalize_safe_areas, out["errors"])
            for node in point_nodes:
                out["points"] += read_items(node, normalize_points, out["errors"])
            # A node listed in Settings and also found by the search, or read both as a
            # collection and per child, must not show its items twice
            out["safeAreas"] = unique(out["safeAreas"], lambda a: (a["coordSystem"], a["name"], json.dumps(a["box"])))
            out["points"] = unique(out["points"], lambda p: (p.get("kin"), p["name"], json.dumps(p["entries"])))
            return out

        return web.json_response(await self.call(read_all))

    async def websocket(self, request):
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(request)
        self.clients[ws] = {"axes": set(), "kins": set()}
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    try:
                        sub = json.loads(msg.data)
                        self.clients[ws] = {"axes": set(sub.get("axes", [])), "kins": set(sub.get("kins", []))}
                    except (ValueError, AttributeError):
                        pass
        finally:
            self.clients.pop(ws, None)
        return ws

    async def broadcast_loop(self):
        period = 1.0 / RATE_HZ
        while True:
            started = time.monotonic()
            if self.clients:
                axes = set().union(*(c["axes"] for c in self.clients.values()))
                kins = set().union(*(c["kins"] for c in self.clients.values()))
                try:
                    sample = await self.call(self._sample, sorted(axes), sorted(kins))
                except Exception:
                    log.exception("Reading motion values failed")
                    sample = None
                if sample:
                    for ws, sub in list(self.clients.items()):
                        msg = {"t": sample["t"],
                               "axes": {k: v for k, v in sample["axes"].items() if k in sub["axes"]},
                               "kins": {k: v for k, v in sample["kins"].items() if k in sub["kins"]}}
                        try:
                            await ws.send_str(json.dumps(msg))
                        except (ConnectionResetError, RuntimeError):
                            self.clients.pop(ws, None)
            await asyncio.sleep(max(0.0, period - (time.monotonic() - started)))

    # ---- wiring ----------------------------------------------------------------------
    def routes(self, app, prefix):
        r = app.router
        if prefix:
            r.add_get(prefix, self.redirect_slash)
        r.add_get(prefix + "/", self.index)
        r.add_get(prefix + "/api/status", self.status)
        r.add_get(prefix + "/api/models", self.list_models)
        r.add_post(prefix + "/api/models", self.upload_models)
        r.add_get(prefix + "/api/models/{name}", self.get_model)
        r.add_delete(prefix + "/api/models/{name}", self.delete_model)
        r.add_get(prefix + "/api/scene", self.get_scene)
        r.add_put(prefix + "/api/scene", self.put_scene)
        r.add_get(prefix + "/api/settings", self.get_settings)
        r.add_put(prefix + "/api/settings", self.put_settings)
        r.add_get(prefix + "/api/axes", self.list_axes)
        r.add_get(prefix + "/api/values", self.values)
        r.add_get(prefix + "/api/motion-objects", self.motion_objects)
        r.add_post(prefix + "/api/discover", self.discover)
        r.add_get(prefix + "/api/ws", self.websocket)
        r.add_static(prefix + "/", WWW, show_index=False)


async def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    state = App()
    app = web.Application(client_max_size=MAX_UPLOAD, middlewares=[state.auth])
    # The ctrlX reverse proxy may or may not strip the URL prefix, so serve both.
    # Prefixed routes first: the unprefixed static route would otherwise swallow them.
    state.routes(app, URL_PREFIX)
    state.routes(app, "")

    runner = web.AppRunner(app)
    await runner.setup()
    snap_data = os.environ.get("SNAP_DATA")
    if snap_data:
        sock_dir = Path(snap_data) / "package-run" / APP_NAME
        sock_dir.mkdir(parents=True, exist_ok=True)
        sock = sock_dir / "web.sock"
        sock.unlink(missing_ok=True)
        site = web.UnixSite(runner, str(sock))
        await site.start()
        os.chmod(sock, 0o777)
        log.info("Listening on unix:%s", sock)
    else:
        port = int(os.environ.get("STLM_PORT", "8081"))
        site = web.TCPSite(runner, os.environ.get("STLM_HOST", "127.0.0.1"), port)
        await site.start()
        log.info("Listening on http://127.0.0.1:%d/", port)

    asyncio.create_task(state.discover())
    broadcaster = asyncio.create_task(state.broadcast_loop())

    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            asyncio.get_running_loop().add_signal_handler(sig, stop.set)
        except NotImplementedError:  # Windows development
            pass
    try:
        await stop.wait()
    finally:
        broadcaster.cancel()
        await runner.cleanup()
        state.source.close()


def run():
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    run()
