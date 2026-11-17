"""ctrlX Palletizer (ctrlX OS 4.x) – web app behind the ctrlX reverse proxy.

On the device:   HTTP over Unix socket  $SNAP_DATA/package-run/<snap>/web.sock
                 reverse proxy URL      /palletizer_4   (see package-manifest.json)
Developing:      HTTP on 127.0.0.1:8093 (PALLETIZER_PORT), files in ./data

API (all need the user's JWT as `Authorization: Bearer` except the page itself):
  GET    /palletizer_4/api/v1/status         version, storage location
  GET    /palletizer_4/api/v1/files          list .csv / .json / .txt files
  GET    /palletizer_4/api/v1/files/<name>   read a file
  PUT    /palletizer_4/api/v1/files/<name>   write a file (atomic)
  DELETE /palletizer_4/api/v1/files/<name>   delete a file
"""

import base64
import json
import mimetypes
import os
import re
import signal
import socketserver
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit

SNAP_NAME = os.getenv("SNAP_INSTANCE_NAME", "ctrlx-demo-palletizer-4")
URL_PREFIX = "/palletizer_4"
VERSION = "1.0.0"
MAX_BODY = 5 * 1024 * 1024
NAME_RE = re.compile(r"^[\w\-. ]{1,120}\.(csv|json|txt)$", re.IGNORECASE)
DEV_MODE = "SNAP" not in os.environ
_lock = threading.Lock()


def www_dir():
    base = os.getenv("SNAP")
    return os.path.realpath(os.path.join(base, "www") if base else os.path.join(os.path.dirname(__file__), "..", "www"))


def location():
    """Folder for CSV/project files: the active ctrlX configuration if Solutions is connected."""
    common = os.getenv("SNAP_COMMON")
    if common:
        active = os.path.join(common, "solutions", "activeConfiguration")
        if os.path.isdir(active):
            return os.path.join(active, SNAP_NAME), "solution"
        return os.path.join(common, "palletizer"), "local"
    return os.getenv("PALLETIZER_DATA") or os.path.join(os.path.dirname(__file__), "..", "data"), "dev"


def storage_dir():
    d, _ = location()
    os.makedirs(d, exist_ok=True)
    return os.path.realpath(d)


def check_token(token):
    if not token:
        return (True, "") if DEV_MODE else (False, "missing token – open the Palletizer from the ctrlX menu or log in")
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return False, "invalid token"
    if claims.get("exp") and claims["exp"] < time.time():
        return False, "session expired – reopen the Palletizer from the ctrlX menu"
    return True, ""


class Handler(BaseHTTPRequestHandler):
    server_version = "palletizer/" + VERSION
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    # ---------- helpers ----------
    def _send(self, code, body=b"", ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _err(self, code, msg):
        self._send(code, {"error": msg})

    def _route(self):
        """Returns the path below URL_PREFIX ('' if the prefix itself was requested)."""
        url = urlsplit(self.path)
        path = unquote(url.path)
        if path == URL_PREFIX:
            return "", url.query
        if path.startswith(URL_PREFIX + "/"):
            return path[len(URL_PREFIX):], url.query
        return path, url.query  # proxy may strip the prefix

    def _auth(self):
        auth = self.headers.get("Authorization", "")
        token = auth[7:].strip() if auth.lower().startswith("bearer ") else ""
        ok, reason = check_token(token)
        if not ok:
            self._err(401, reason)
            return False
        return True

    def _file(self, name):
        if not NAME_RE.match(name) or "/" in name or "\\" in name or name.startswith("."):
            return None
        root = storage_dir()
        p = os.path.realpath(os.path.join(root, name))
        return p if os.path.dirname(p) == root else None

    def _guard(self, fn):
        try:
            fn()
        except Exception as exc:  # keep the service alive
            print("ERROR", self.path, repr(exc), flush=True)
            try:
                self._err(500, str(exc))
            except Exception:
                pass

    # ---------- verbs ----------
    def do_GET(self):
        path, query = self._route()
        if path == "":
            return self._send(301, b"", "text/plain", {"Location": URL_PREFIX + "/" + ("?" + query if query else "")})
        if path.startswith("/api/"):
            if not self._auth():
                return
            return self._guard(lambda: self._api_get(path[len("/api/v1/"):] if path.startswith("/api/v1/") else ""))
        return self._guard(lambda: self._static(path))

    do_HEAD = do_GET

    def do_PUT(self):
        path, _ = self._route()
        if not path.startswith("/api/v1/files/"):
            return self._err(404, "not found")
        if not self._auth():
            return
        self._guard(lambda: self._put(path[len("/api/v1/files/"):]))

    do_POST = do_PUT

    def do_DELETE(self):
        path, _ = self._route()
        if not path.startswith("/api/v1/files/"):
            return self._err(404, "not found")
        if not self._auth():
            return
        fp = self._file(path[len("/api/v1/files/"):])
        if not fp or not os.path.isfile(fp):
            return self._err(404, "no such file")
        with _lock:
            os.remove(fp)
        self._send(200, {"deleted": os.path.basename(fp)})

    # ---------- api ----------
    def _put(self, name):
        fp = self._file(name)
        if not fp:
            return self._err(400, "invalid file name (letters, digits, - _ . space; .csv, .json or .txt)")
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self._err(413, "file too large (max 5 MB)")
        data = self.rfile.read(n)
        if fp.lower().endswith(".json"):
            json.loads(data)  # refuse broken project files
        d = os.path.dirname(fp)
        with _lock:
            fd, tmp = tempfile.mkstemp(dir=d, prefix=".up.", suffix=".tmp")
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
                os.chmod(tmp, 0o664)
                os.replace(tmp, fp)  # atomic
            except BaseException:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass
                raise
        self._send(200, {"saved": os.path.basename(fp), "path": fp, "size": len(data)})

    def _api_get(self, sub):
        if sub == "status":
            d, kind = location()
            return self._send(200, {"app": SNAP_NAME, "version": VERSION, "storage": os.path.realpath(d),
                                    "location": kind, "solutionConnected": kind == "solution", "time": time.time()})
        if sub == "files":
            root = storage_dir()
            out = []
            for n in os.listdir(root):
                p = os.path.join(root, n)
                if os.path.isfile(p) and NAME_RE.match(n):
                    st = os.stat(p)
                    out.append({"name": n, "size": st.st_size, "mtime": st.st_mtime})
            out.sort(key=lambda f: -f["mtime"])
            return self._send(200, out)
        if sub.startswith("files/"):
            fp = self._file(sub[len("files/"):])
            if not fp or not os.path.isfile(fp):
                return self._err(404, "no such file")
            with open(fp, "rb") as f:
                data = f.read()
            low = fp.lower()
            ctype = "text/csv; charset=utf-8" if low.endswith(".csv") else "application/json" if low.endswith(".json") else "text/plain; charset=utf-8"
            return self._send(200, data, ctype)
        return self._err(404, "unknown endpoint")

    # ---------- static ----------
    def _static(self, path):
        root = www_dir()
        rel = path.lstrip("/") or "index.html"
        fp = os.path.realpath(os.path.join(root, rel))
        if not fp.startswith(root + os.sep) or not os.path.isfile(fp):
            return self._err(404, "not found")
        ctype = "text/javascript" if fp.endswith(".js") else (mimetypes.guess_type(fp)[0] or "application/octet-stream")
        with open(fp, "rb") as f:
            self._send(200, f.read(), ctype)


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
        print("INFO listening on", sock, "| files:", storage_dir(), flush=True)
        return srv
    port = int(os.getenv("PALLETIZER_PORT", "8093"))
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    print(f"INFO dev mode: http://127.0.0.1:{port}{URL_PREFIX}/ | files: {storage_dir()}", flush=True)
    return srv


def main():
    srv = make_server()
    stop = threading.Event()
    for s in (signal.SIGINT, signal.SIGTERM):
        signal.signal(s, lambda *_: stop.set())
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    stop.wait()
    print("INFO stopping", flush=True)
    srv.shutdown()
    srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
