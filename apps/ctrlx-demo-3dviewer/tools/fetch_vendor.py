"""Download the three.js modules used by the web UI into www/vendor.

The controller usually has no internet access, so the files are shipped inside the snap.
Usage: python tools/fetch_vendor.py [target_dir]
"""

import sys
import urllib.request
from pathlib import Path

VERSION = "0.160.0"
BASE = f"https://cdn.jsdelivr.net/npm/three@{VERSION}/"
FILES = {
    "three.module.js": "build/three.module.js",
    "addons/loaders/STLLoader.js": "examples/jsm/loaders/STLLoader.js",
    "addons/controls/OrbitControls.js": "examples/jsm/controls/OrbitControls.js",
    "addons/controls/TransformControls.js": "examples/jsm/controls/TransformControls.js",
    "addons/renderers/CSS2DRenderer.js": "examples/jsm/renderers/CSS2DRenderer.js",
}


def main():
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "www" / "vendor"
    for local, remote in FILES.items():
        dest = target / local
        if dest.exists():
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"fetch {remote}")
        with urllib.request.urlopen(BASE + remote, timeout=60) as resp:
            dest.write_bytes(resp.read())
    print(f"three.js {VERSION} in {target}")


if __name__ == "__main__":
    main()
