# Data Layer Trend (`ctrlx-demo-dltrend`)

ctrlX OS app (core24 / ctrlX OS 4.x): browse the Data Layer, keep a watch list of nodes,
see live values and a multi-series trend, export CSV.

## Install on ctrlX COREvirtual
1. Web UI → **Settings → Apps** → enable *Allow installation from unknown source*.
2. **Install from file** → `ctrlx-demo-dltrend_1.0.0_amd64.snap`.
3. Reload the page. The sidebar has a **Data Layer Trend** entry (embedded or new tab).

## Use
- **Browse** panel: click a node to expand it; hover a row and press **+** (or double-click) to add it.
- Or type a path (suggestions appear as you type) and press **Add** / Enter.
- Watch list: click the colour square to hide/show a series, **×** to remove. Up to 20 items.
- Header: sample rate (0.5–5 s), time window (1–60 min), Pause, Clear, CSV.
- **Normalize** scales each series to 0–100 % of its own min/max, which helps compare % and MB values on one chart.
- The watch list is remembered per browser. Trend history lives in the page and resets when the page is reloaded.

Numbers and booleans are trended. Strings, arrays and flatbuffers are shown as text in the table only.

## Security
- Served on a Unix socket behind the ctrlX reverse proxy at `/dltrend`. No TCP port is opened.
- Every Data Layer call uses the logged-in user's token, so that user's Data Layer permissions apply.
  A node that user may not read shows `DL_PERMISSION_DENIED`.
- Tokens expire. If the status shows "session expired", reopen the app from the sidebar.

## Logs
`sudo snap logs -f ctrlx-demo-dltrend` (SSH), or the ctrlX logbook.

## Develop without a device
```bash
pip install "ctrlx-datalayer<=3.6"          # needs libcomm_datalayer.so (ctrlx-datalayer deb) for the real Data Layer
DLTREND_MOCK=1 python3 -m app.main          # fake data → http://127.0.0.1:8090/dltrend
DL_IP=10.0.2.2 DL_SSL_PORT=8443 python3 -m app.main   # real COREvirtual (port forwarding)
```

## Build
Ubuntu 24.04 with snapcraft 8.x and the `ctrlx-datalayer` deb registered as a local apt repo
(see the SDK's `scripts/install-ctrlx-datalayer.sh`). Then run `./build-snap-amd64.sh` (or `-arm64` for CORE X3).
Rename the app: change `ctrlx-demo-dltrend` in `snap/snapcraft.yaml`, the manifest file name and its `id`/`binding`, and `SNAP_NAME` in `app/main.py`.
