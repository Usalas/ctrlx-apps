"""ctrlX HMI Builder (ctrlX OS 4.x) – web app behind the ctrlX reverse proxy.

On the device:   HTTP over Unix socket  $SNAP_DATA/package-run/<snap>/web.sock
                 reverse proxy URL      /hmi   (see package-manifest.json)
Developing:      HTTP on 127.0.0.1:8092 (HMI_PORT); HMI_MOCK=1 uses a writable fake Data Layer.

API (all need the user's JWT as `Authorization: Bearer` except the page itself):
  GET  /hmi/api/browse?path=a/b       children of a Data Layer node
  GET  /hmi/api/read?paths=a,b,c       values (max 100 per call)
  POST /hmi/api/write  {"path","value"} typed write (node's own type)
  GET  /hmi/api/screens                saved HMI document
  PUT  /hmi/api/screens                save HMI document
"""

import base64
import json
import os
import signal
import socketserver
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from app import store

SNAP_NAME = os.getenv("SNAP_INSTANCE_NAME", "ctrlx-demo-hmi")
URL_PREFIX = "/hmi"
MAX_PATHS = 100
MAX_BODY = store.MAX_BYTES + 1024
DEV_MODE = "SNAP" not in os.environ

dl = None


def www_dir():
    base = os.getenv("SNAP")
    return os.path.join(base, "www") if base else os.path.join(os.path.dirname(__file__), "..", "www")


def check_token(token):
    if not token:
        return (True, "") if DEV_MODE else (False, "missing token – open the HMI from the ctrlX menu")
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return False, "invalid token"
    if claims.get("exp") and claims["exp"] < time.time():
        return False, "session expired – reopen the HMI from the ctrlX menu"
    return True, ""  # node permissions are enforced by the Data Layer with this token


class Handler(BaseHTTPRequestHandler):
    server_version = "hmi/1.0"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, body: bytes, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code, obj):
        self._send(code, json.dumps(obj).encode(), "application/json")

    def _route(self):
        url = urlparse(self.path)
        if not url.path.startswith(URL_PREFIX):
            return None, None
        return url.path[len(URL_PREFIX):] or "/", parse_qs(url.query)

    def _auth(self, query):
        auth = self.headers.get("Authorization", "")
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else (query.get("token") or [""])[0]
        ok, reason = check_token(token)
        if not ok:
            self._json(401, {"error": reason})
            return None
        return token

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("request too large")
        return self.rfile.read(n) if n else b""

    def _guard(self, fn):
        try:
            return fn()
        except ConnectionError as exc:
            return self._json(503, {"error": str(exc)})
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        except Exception as exc:
            print("ERROR", self.path, repr(exc), flush=True)
            return self._json(500, {"error": "internal error"})

    def do_GET(self):
        sub, q = self._route()
        if sub is None:
            return self._send(404, b"not found", "text/plain")
        if sub in ("/", "/index.html"):
            with open(os.path.join(www_dir(), "index.html"), "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        if not sub.startswith("/api/"):
            return self._send(404, b"not found", "text/plain")
        token = self._auth(q)
        if token is None:
            return
        if sub == "/api/browse":
            p = (q.get("path") or [""])[0].strip("/")
            return self._guard(lambda: self._json(200, dl.browse(p, token)))
        if sub == "/api/read":
            paths = [p.strip("/") for p in (q.get("paths") or [""])[0].split(",") if p.strip()]
            return self._guard(lambda: self._json(200, {"t": time.time(), "items": dl.read_many(paths[:MAX_PATHS], token)}))
        if sub == "/api/screens":
            return self._guard(lambda: self._json(200, store.load()))
        return self._send(404, b"not found", "text/plain")

    def do_POST(self):
        sub, q = self._route()
        if sub != "/api/write":
            return self._send(404, b"not found", "text/plain")
        token = self._auth(q)
        if token is None:
            return

        def go():
            req = json.loads(self._body() or b"{}")
            path = str(req.get("path", "")).strip("/")
            if not path or "value" not in req:
                raise ValueError("need 'path' and 'value'")
            res = dl.write(path, req["value"], token)
            return self._json(200 if res.get("ok") else 422, res)
        return self._guard(go)

    def do_PUT(self):
        sub, q = self._route()
        if sub != "/api/screens":
            return self._send(404, b"not found", "text/plain")
        token = self._auth(q)
        if token is None:
            return
        return self._guard(lambda: self._json(200, store.save(self._body())))


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def get_request(self):
        request, _ = super().get_request()
        return request, ["local", 0]


def make_server():
    if not DEV_MODE:
        sock_dir = os.path.join(os.environ["SNAP_DATA"], "package-run", SNAP_NAME)
        os.makedirs(sock_dir, exist_ok=True)
        sock = os.path.join(sock_dir, "web.sock")
        if os.path.exists(sock):
            os.unlink(sock)
        srv = UnixHTTPServer(sock, Handler)
        os.chmod(sock, 0o660)
        print("INFO listening on", sock, "| screens:", store.location()[1], flush=True)
        return srv
    port = int(os.getenv("HMI_PORT", "8092"))
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"INFO dev mode: http://127.0.0.1:{port}{URL_PREFIX}", flush=True)
    return srv


def main():
    global dl
    if os.getenv("HMI_MOCK") == "1":
        from app.mock import MockDataLayer
        dl = MockDataLayer()
    else:
        from app.dl import DataLayer
        dl = DataLayer()
    srv = make_server()
    stop = threading.Event()
    for s in (signal.SIGINT, signal.SIGTERM):
        signal.signal(s, lambda *_: stop.set())
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    stop.wait()
    print("INFO stopping", flush=True)
    srv.shutdown()
    srv.server_close()
    dl.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
