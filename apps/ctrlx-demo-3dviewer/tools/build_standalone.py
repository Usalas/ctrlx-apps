"""Build a single-file, browser-only demo of the 3D Viewer.

The page bundles www/ (HTML, CSS, app.js, vendored three.js), the demo STLs and scene, and a
small shim that answers the app's api/* calls and its WebSocket in the browser, with the same
simulated axes, kinematics, teach points and areas as STLM_SOURCE=simulation. No server and no
ctrlX core are needed: open the file in any browser. Scene and settings are kept in the
browser's localStorage, uploaded STLs only until the page is reloaded.

Usage: python tools/build_standalone.py [output.html]     (default: dist/3dviewer-standalone.html)
"""

import base64
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.motion_source import SimulatedSource, normalize_points, normalize_safe_areas  # noqa: E402

WWW = ROOT / "www"
VENDOR = WWW / "vendor"
ADDONS = {
    "three/addons/loaders/STLLoader.js": "addons/loaders/STLLoader.js",
    "three/addons/controls/OrbitControls.js": "addons/controls/OrbitControls.js",
    "three/addons/controls/TransformControls.js": "addons/controls/TransformControls.js",
    "three/addons/renderers/CSS2DRenderer.js": "addons/renderers/CSS2DRenderer.js",
}

SHIM = r"""
(() => {
  'use strict';
  const FIX = __FIXTURES__;
  const KEY = '3dviewer.standalone.';
  const load = (k, fallback) => { try { const v = localStorage.getItem(KEY + k); return v ? JSON.parse(v) : fallback; } catch { return fallback; } };
  const keep = (k, v) => { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch { /* not kept */ } };
  const bytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  const models = new Map(FIX.models.map((m) => [m.name, { data: bytes(m.b64), modified: FIX.built }]));
  let scene = load('scene', FIX.scene);
  let settings = load('settings', FIX.settings);
  const listModels = () => [...models].map(([name, m]) => ({ name, size: m.data.length, modified: m.modified }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Same motion as app/motion_source.py SimulatedSource
  const t0 = performance.now();
  const AXES = {
    X: (t) => 250 * Math.sin(t * 0.6),
    Y: (t) => 150 * Math.sin(t * 0.45 + 1.0),
    Z: (t) => -60 + 60 * Math.sin(t * 0.9),
    C: (t) => (t * 30) % 360,
  };
  function sample(axes, kins) {
    const t = (performance.now() - t0) / 1000;
    const a = {};
    for (const n of axes) if (AXES[n]) a[n] = AXES[n](t);
    const k = {};
    if (kins.includes('Gantry')) k.Gantry = { pos: ['X', 'Y', 'Z', 'C'].map((n) => AXES[n](t)), units: ['mm', 'mm', 'mm', 'deg'] };
    return { t: Date.now() / 1000, axes: a, kins: k };
  }

  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input.url;
    const m = /^api\/([^?]*)(?:\?(.*))?$/.exec(raw);
    if (!m) return realFetch(input, init);
    const route = m[1];
    const query = new URLSearchParams(m[2] || '');
    const method = (init.method || 'GET').toUpperCase();
    const list = (k) => (query.get(k) || '').split(',').filter(Boolean);

    if (route === 'status') return json({ ...FIX.status, rateHz: 20 });
    if (route === 'axes') return json({ axes: Object.keys(AXES), kins: ['Gantry'] });
    if (route === 'values') return json(sample(list('axes'), list('kins')));
    if (route === 'discover') return json(FIX.discovered);
    if (route === 'motion-objects') {
      const auto = settings.autoDiscover !== false;
      return json({ ...(auto ? FIX.motion : { safeAreas: [], points: [], errors: [] }),
        nodes: { safeAreas: [...settings.safeAreaNodes, ...(auto ? FIX.discovered.safeAreas : [])],
                 points: [...settings.pointNodes, ...(auto ? FIX.discovered.points : [])] } });
    }
    if (route === 'scene') {
      if (method === 'PUT') { scene = JSON.parse(init.body); keep('scene', scene); return json(scene); }
      return json(scene);
    }
    if (route === 'settings') {
      if (method === 'PUT') { settings = { ...settings, ...JSON.parse(init.body) }; keep('settings', settings); return json(settings); }
      return json(settings);
    }
    if (route === 'models') {
      if (method === 'POST') {
        const saved = [];
        for (const f of init.body.getAll('file')) {
          models.set(f.name, { data: new Uint8Array(await f.arrayBuffer()), modified: Date.now() / 1000 });
          saved.push(f.name);
        }
        return json({ saved, models: listModels() });
      }
      return json(listModels());
    }
    if (route.startsWith('models/')) {
      const name = decodeURIComponent(route.slice(7));
      if (!models.has(name)) return new Response('model not found', { status: 404 });
      if (method === 'DELETE') { models.delete(name); return json(listModels()); }
      return new Response(models.get(name).data, { headers: { 'Content-Type': 'model/stl' } });
    }
    return new Response('not found', { status: 404 });
  };

  // Live stream: same message format as api/ws, 20 Hz
  class SimSocket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor() {
      this.readyState = 0;
      this.sub = { axes: [], kins: [] };
      setTimeout(() => {
        this.readyState = 1;
        this.onopen?.({});
        this.timer = setInterval(() => {
          if (this.sub.axes.length || this.sub.kins.length) this.onmessage?.({ data: JSON.stringify(sample(this.sub.axes, this.sub.kins)) });
        }, 50);
      }, 0);
    }
    send(data) { this.sub = JSON.parse(data); }
    close() { clearInterval(this.timer); this.readyState = 3; this.onclose?.({}); }
  }
  window.WebSocket = SimSocket;
})();
"""


def b64(data):
    return base64.b64encode(data).decode("ascii")


def data_url(path):
    return "data:text/javascript;base64," + b64(path.read_bytes())


def fixtures():
    src = SimulatedSource()
    discovered = src.discover_nodes()
    motion = {"safeAreas": [], "points": [], "errors": []}
    for node in discovered["safeAreas"]:
        motion["safeAreas"] += normalize_safe_areas(src.read_json(node), node)
    for node in discovered["points"]:
        motion["points"] += normalize_points(src.read_json(node), node)

    version = re.search(r'^version\s*=\s*"([^"]+)"', (ROOT / "pyproject.toml").read_text(), re.M).group(1)
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run([sys.executable, str(ROOT / "tools" / "make_demo_stls.py"), tmp], check=True, capture_output=True)
        models = [{"name": p.name, "b64": b64(p.read_bytes())} for p in sorted(Path(tmp).glob("*.stl"))]

    return {
        "status": {"source": "simulation", "connected": True, "version": f"{version} standalone",
                   "message": "Standalone demo: simulated axes X, Y, Z, C running in this browser"},
        "discovered": discovered,
        "motion": motion,
        "settings": {"safeAreaNodes": [], "pointNodes": [], "autoDiscover": True},
        "scene": json.loads((ROOT / "tools" / "demo-scene.json").read_text()),
        "models": models,
        "built": 0,
    }


def build(out):
    html = (WWW / "index.html").read_text()
    css = (WWW / "style.css").read_text()
    app = (WWW / "app.js").read_text()

    # The page has no server URL to resolve api/ws against (e.g. about:srcdoc); the shim ignores it.
    app = app.replace("new URL('api/ws', location.href)",
                      "new URL('api/ws', /^(https?|file):/.test(location.href) ? location.href : 'http://localhost/')")
    app = app.replace("toast('Scene saved on the core')", "toast('Scene saved in this browser')")
    app = app.replace("from the core?", "from this demo?")
    html = html.replace("Drop STL files to upload to the core", "Drop STL files to load them into this demo")

    imports = {"three": data_url(VENDOR / "three.module.js")}
    imports.update({spec: data_url(VENDOR / rel) for spec, rel in ADDONS.items()})
    shim = SHIM.replace("__FIXTURES__", json.dumps(fixtures(), separators=(",", ":")))

    for text in (app, shim, css):
        if re.search(r"</(script|style)", text, re.I):
            raise SystemExit("inline content contains a closing script/style tag")

    html = html.replace('<link rel="stylesheet" href="style.css">', f"<style>\n{css}\n</style>")
    html = re.sub(r'<script type="importmap">.*?</script>',
                  lambda _: f"<script>{shim}</script>\n  <script type=\"importmap\">{json.dumps({'imports': imports})}</script>",
                  html, flags=re.S)
    html = html.replace('<script type="module" src="app.js"></script>', f'<script type="module">\n{app}\n</script>')
    for marker in ("style.css", 'src="app.js"', "./vendor/"):
        if marker in html:
            raise SystemExit(f"index.html changed: could not inline {marker}")

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html)
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    build(Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist" / "3dviewer-standalone.html")
