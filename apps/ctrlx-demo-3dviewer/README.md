# CtrlX 3D Viewer (`ctrlx-demo-3dviewer`)

3D machine viewer for **ctrlX OS 4.x** (base `core24`). Opens from the ctrlX sidebar as
**CtrlX 3D Viewer** (`/3dviewer`), embedded in the ctrlX page or in a new tab.
Upload STL files to the core, assemble them, attach each part to a motion axis or a kinematics,
and watch the machine move live, with the ctrlX MOTION **kinematics TCP and path trail**,
**teach points** and **safe / work areas** drawn on top.

The app only **reads** from the Data Layer. It never commands motion.

## Features
| | |
|---|---|
| **STL library on the core** | Upload with the button or drag-and-drop onto the 3D view (max 200 MB per file). Files go to the active configuration, `appdata/ctrlx-demo-3dviewer/models/`, so they are saved and restored with the project (Settings → Solutions). |
| **Assembly** | Add parts and place them with the gizmo (W move, E rotate, Q local/world, snap 5 mm/15°) or by typing numbers. Attach parts to other parts so they ride along (X carriage on a Y bridge, …). Re-attaching keeps the world position. |
| **Rotation point** | Each part rotates about its own rotation point. Set it in STL coordinates, or click **Model centre**, **Bottom centre** or **STL origin**. The part stays in place while the point moves, and the gizmo sits on it. |
| **Axis binding** | A part can be driven by a **linear** or **rotary** axis (`motion/axs/<name>/state/values/actual/pos`) along or about its local X/Y/Z, with scale, offset and invert, or by one coordinate of a kinematics. |
| **Kinematics** | Every kinematics under `motion/kin` gets a live TCP marker with an X/Y/Z readout and a path trail in its frame. A part set to *Kinematics TCP* follows the TCP, for example a gripper. |
| **Teach points** | Read from `motion/kin/<kin>/cfg/points` (`PointCollection`). MCS points are drawn as labelled dots in their kinematics' frame (Kinematics tab → Frame); click one for its details. ACS points are listed only. The Points tab groups points by kinematics: tick points or whole groups to show them, filter by name, and choose labels for all, selected only or none. Overlapping labels are hidden. |
| **Safe / work areas** | Read from `SysCfgSafeAreaAll`. Red = SAFE_AREA, orange = WORK_AREA_EXCL, green = WORK_AREA_INCL. A TCP inside a safe area or outside an inclusive work area turns red, and the area is highlighted. |
| **Coordinate frames** | Place `MCS` in the scene at machine zero (attach it to the machine base). Add `WCS`, `PCS`, … frames for areas defined in other systems. |
| **Edit / Run mode** | *Edit* arranges the scene. *Run* hides the editing tools and lists every axis position and every kinematics position live on the right. ◧ and ◨ in the top bar open and close the side panels; each mode remembers its own choice. |
| **Live / Manual** | *Live* streams at 20 Hz over a WebSocket and falls back to HTTP polling. *Manual* shows sliders for checking bindings without moving the machine. |

All API calls use the logged-in user's token (passed by the sidebar link as `?token=${bearertoken}`),
so the Data Layer's permissions apply. Opened without a token, the page shows *Not logged in*.

## Teach point and safe area nodes
On ctrlX OS 4.x safe areas are in `motion/cfg/safe-areas` (`SysCfgSafeAreaAll`) and teach points in
`motion/kin/<kin>/cfg/points` (`PointCollection`). At start-up the app searches `motion/` for nodes
named `safe-areas` and `points`, skipping `cmd` and `state` subtrees. A node that is a folder is read
child by child. **Settings** shows what it found and lets you enter
addresses by hand. Values are read as JSON through the Data Layer converter.
The kinematics position is read from `motion/kin/<k>/state/values/actual/pos`, with
`motion/kin/<k>/state/values/actual` (`KinActualValues`) as a fallback.

## Develop without a device
```bash
pip install "aiohttp>=3.9,<4"
```

```bash
python tools/make_demo_stls.py data/models
```

```bash
cp tools/demo-scene.json data/scene.json
```

```bash
STLM_SOURCE=simulation python -m app.main
```

Open http://127.0.0.1:8080/. The simulation provides axes X, Y, Z, C, a kinematics `Gantry`,
four teach points and three areas, plus a demo gantry scene.
To work against a real core or ctrlX COREvirtual, install `ctrlx-datalayer` and set
`CTRLX_ADDRESS`, `CTRLX_USER`, `CTRLX_PASSWORD` (and `CTRLX_SSL_PORT`).

three.js 0.160.0 (MIT) is vendored in `www/vendor` so the app works on controllers without
internet access. `python tools/fetch_vendor.py` downloads it again.

## API (under `/3dviewer`)
| Method | Path | |
|---|---|---|
| GET | `api/status` | source (`datalayer`/`simulation`), connection state |
| GET/POST | `api/models` | list / upload STL (multipart, field `file`) |
| GET/DELETE | `api/models/{name}` | download / delete STL |
| GET/PUT | `api/scene` | scene document (parts, frames, overlay settings) |
| GET/PUT | `api/settings` | Data Layer node addresses for points / areas |
| GET | `api/axes` | `{axes: [...], kins: [...]}` |
| GET | `api/values?axes=X,Y&kins=Robot` | one sample |
| GET | `api/motion-objects` | normalized teach points + safe areas |
| POST | `api/discover` | search `motion/` for point / area nodes again |
| WS | `api/ws?token=…` | send `{"axes":[…],"kins":[…]}`, receive samples at `STLM_RATE_HZ` (default 20) |
