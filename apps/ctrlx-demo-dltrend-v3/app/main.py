"""ctrlX Data Layer Trend – web app served behind the ctrlX reverse proxy.

On the device:   HTTP over Unix socket  $SNAP_DATA/package-run/<snap>/web.sock
                 reverse proxy URL      /dltrend-v3   (see package-manifest.json)
Developing:      HTTP on 127.0.0.1:8090 (DLTREND_PORT), Data Layer over tcp:// (DL_IP ...)
                 DLTREND_MOCK=1 uses a fake Data Layer.
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

SNAP_NAME = os.getenv("SNAP_INSTANCE_NAME", "ctrlx-demo-dltrend-v3")
URL_PREFIX = "/dltrend-v3"
MAX_PATHS = 20
DEV_MODE = "SNAP" not in os.environ

dl = None  # set in main()


def www_dir():
    base = os.getenv("SNAP")
    return os.path.join(base, "www") if base else os.path.join(os.path.dirname(__file__), "..", "www")


def jwt_claims(token):
    """Decode JWT payload without verifying (the reverse proxy issued it; the Data Layer
    verifies it again when we pass it via set_auth_token)."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return None


def check_token(token):
    """-> (ok, reason)"""
    if not token:
        return (True, "") if DEV_MODE else (False, "missing token – open the app from the ctrlX menu")
    claims = jwt_claims(token)
    if claims is None:
        return False, "invalid token"
    if claims.get("exp") and claims["exp"] < time.time():
        return False, "session expired – reopen the app from the ctrlX menu"
    # Per-node read permission is enforced by the Data Layer itself using this token.
    return True, ""


class Handler(BaseHTTPRequestHandler):
    server_version = "dltrend/1.0"

    def log_message(self, fmt, *args):  # keep journal quiet except errors
        pass

    # --- helpers -------------------------------------------------------------
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

    def _token(self, query):
        auth = self.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            return auth[7:].strip()
        return (query.get("token") or [""])[0]

    # --- routes --------------------------------------------------------------
    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        if not path.startswith(URL_PREFIX):
            return self._send(404, b"not found", "text/plain")
        sub = path[len(URL_PREFIX):] or "/"
        query = parse_qs(url.query)

        if sub in ("/", "/index.html"):
            with open(os.path.join(www_dir(), "index.html"), "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")

        if sub.startswith("/api/"):
            token = self._token(query)
            ok, reason = check_token(token)
            if not ok:
                return self._json(401, {"error": reason})
            try:
                if sub == "/api/browse":
                    p = (query.get("path") or [""])[0].strip("/")
                    return self._json(200, dl.browse(p, token))
                if sub == "/api/read":
                    paths = [p.strip("/") for p in (query.get("paths") or [""])[0].split(",") if p.strip()]
                    return self._json(200, {"t": time.time(), "items": dl.read_many(paths[:MAX_PATHS], token)})
            except ConnectionError as exc:
                return self._json(503, {"error": str(exc)})
            except Exception as exc:
                print("ERROR", sub, exc, flush=True)
                return self._json(500, {"error": "internal error"})
        return self._send(404, b"not found", "text/plain")


class UnixHTTPServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def get_request(self):
        request, _ = super().get_request()
        return request, ["local", 0]  # BaseHTTPRequestHandler expects (host, port)


def make_server():
    if not DEV_MODE:
        sock_dir = os.path.join(os.environ["SNAP_DATA"], "package-run", SNAP_NAME)
        os.makedirs(sock_dir, exist_ok=True)
        sock = os.path.join(sock_dir, "web.sock")
        if os.path.exists(sock):
            os.unlink(sock)
        srv = UnixHTTPServer(sock, Handler)
        os.chmod(sock, 0o660)
        print("INFO listening on", sock, flush=True)
        return srv
    port = int(os.getenv("DLTREND_PORT", "8090"))
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"INFO dev mode: http://127.0.0.1:{port}{URL_PREFIX}", flush=True)
    return srv


def main():
    global dl
    if os.getenv("DLTREND_MOCK") == "1":
        from app.mock import MockDataLayer
        dl = MockDataLayer()
    else:
        from app.dl import DataLayer
        dl = DataLayer()

    srv = make_server()
    stop = threading.Event()

    def _handler(signum, frame):
        stop.set()
    for s in (signal.SIGINT, signal.SIGTERM):
        signal.signal(s, _handler)

    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    stop.wait()
    print("INFO stopping", flush=True)
    srv.shutdown()
    srv.server_close()
    dl.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
