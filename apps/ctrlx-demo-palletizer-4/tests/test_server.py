"""Service tests: python3 -m unittest discover -s tests -p 'test_*.py'"""
import base64
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)
sys.path.insert(0, APP_DIR)
from app import main as appmain  # noqa: E402

PREFIX = appmain.URL_PREFIX


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def jwt(exp):
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
    return enc({"alg": "none"}) + "." + enc({"exp": exp, "name": "test"}) + ".sig"


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = tempfile.mkdtemp()
        cls.port = free_port()
        env = dict(os.environ, PALLETIZER_PORT=str(cls.port), PALLETIZER_DATA=cls.data)
        env.pop("SNAP", None)
        cls.proc = subprocess.Popen([sys.executable, "-m", "app.main"], cwd=APP_DIR, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(50):
            try:
                socket.create_connection(("127.0.0.1", cls.port), 0.2).close(); break
            except OSError:
                time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate(); cls.proc.wait(5)

    def req(self, method, path, body=None, headers=None, follow=True):
        url = f"http://127.0.0.1:{self.port}{path}"
        r = urllib.request.Request(url, data=body, method=method, headers=headers or {})
        opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect())
        try:
            with opener.open(r, timeout=5) as resp:
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def test_page_and_assets(self):
        st, h, b = self.req("GET", PREFIX + "/")
        self.assertEqual(st, 200); self.assertIn(b"<canvas id=\"canvas2d\"", b)
        for a in ("/js/app.js", "/js/editor2d.js", "/vendor/three.module.min.js", "/styles.css"):
            st, h, _ = self.req("GET", PREFIX + a); self.assertEqual(st, 200, a)
        self.assertEqual(self.req("GET", PREFIX + "/js/app.js")[1]["Content-Type"], "text/javascript")

    def test_redirect_keeps_token(self):
        st, h, _ = self.req("GET", PREFIX + "?token=abc", follow=False)
        self.assertEqual(st, 301); self.assertEqual(h["Location"], PREFIX + "/?token=abc")

    def test_file_crud(self):
        csv = b"Layer,Index,BoxType,PosX,PosY,PosZ,Rotation\r\n1,1,A,200,150,250,0\r\n"
        st, _, b = self.req("PUT", PREFIX + "/api/v1/files/test_1.csv", csv); self.assertEqual(st, 200, b)
        self.assertTrue(os.path.isfile(os.path.join(self.data, "test_1.csv")))
        st, h, b = self.req("GET", PREFIX + "/api/v1/files/test_1.csv"); self.assertEqual((st, b), (200, csv))
        st, _, b = self.req("GET", PREFIX + "/api/v1/files"); self.assertIn("test_1.csv", [f["name"] for f in json.loads(b)])
        st, _, _ = self.req("DELETE", PREFIX + "/api/v1/files/test_1.csv"); self.assertEqual(st, 200)
        self.assertEqual(self.req("GET", PREFIX + "/api/v1/files/test_1.csv")[0], 404)

    def test_rejects_bad_names_and_json(self):
        for n in ("..%2Fx.csv", "x.sh", ".hidden.csv", "a%2Fb.csv"):
            self.assertEqual(self.req("PUT", PREFIX + "/api/v1/files/" + n, b"x")[0], 400, n)
        self.assertEqual(self.req("PUT", PREFIX + "/api/v1/files/p.pallet.json", b"{broken")[0], 500)
        self.assertFalse(os.path.exists(os.path.join(self.data, "p.pallet.json")))

    def test_status(self):
        st, _, b = self.req("GET", PREFIX + "/api/v1/status")
        j = json.loads(b); self.assertEqual(st, 200); self.assertEqual(j["location"], "dev")


class TokenTest(unittest.TestCase):
    """Device mode: API needs a valid, unexpired JWT."""
    def setUp(self):
        self._dev = appmain.DEV_MODE; appmain.DEV_MODE = False

    def tearDown(self):
        appmain.DEV_MODE = self._dev

    def test_tokens(self):
        self.assertFalse(appmain.check_token("")[0])
        self.assertFalse(appmain.check_token("garbage")[0])
        self.assertFalse(appmain.check_token(jwt(time.time() - 10))[0])
        self.assertTrue(appmain.check_token(jwt(time.time() + 600))[0])


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


if __name__ == "__main__":
    unittest.main()
