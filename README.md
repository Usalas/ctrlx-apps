# ctrlx-apps

Apps (snaps) for ctrlX OS, built by GitHub Actions for **amd64** (ctrlX COREvirtual, x86 IPCs)
and **arm64** (ctrlX CORE X3 and others). The snap `base` picks the ctrlX OS version:
`core24` = ctrlX OS 4.x, `core22` = ctrlX OS 3.x (apps with a `-v3` suffix).

| App | ctrlX OS | What it does |
|---|---|---|
| [`ctrlx-demo-dltrend`](apps/ctrlx-demo-dltrend) | 4.x | Web app in the ctrlX sidebar: browse the Data Layer, watch list, live trend chart, CSV export (`/dltrend`) |
| [`ctrlx-demo-dltrend-v3`](apps/ctrlx-demo-dltrend-v3) | 3.x | Same app for ctrlX OS 3.x (`/dltrend-v3`, sidebar entry "Data Layer Trend V3") |
| [`ctrlx-demo-hmi`](apps/ctrlx-demo-hmi) | 4.x | Drag-and-drop HMI: buttons, lamps, data entry/display, radial and bar gauges bound to Data Layer tags; screens saved in Solutions (`/hmi`) |
| [`ctrlx-demo-hmi-v3`](apps/ctrlx-demo-hmi-v3) | 3.x | Drag-and-drop HMI: buttons, lamps, data entry/display, radial and bar gauges bound to Data Layer tags; screens saved in Solutions (`/hmi-v3`) |
| [`ctrlx-acme-hello`](apps/ctrlx-acme-hello) | 4.x | Minimal starter: logs the CPU load from the Data Layer every 5 s |

## Getting the snaps
1. Open **Actions → Build ctrlX snaps** and pick the latest green run (or press **Run workflow**, optionally for one app).
2. Download the artifact for your target, e.g. `ctrlx-demo-dltrend-arm64` for a CORE X3, or `-amd64` for COREvirtual.
   The artifact is a zip; the `.snap` is inside.
3. ctrlX web UI → **Settings → Apps** → allow installation from unknown sources → **Install from file**.

## Adding an app
Create `apps/<snap-name>/` with a `snap/snapcraft.yaml` (snap name `ctrlx-<company>-<app>`,
`base: core24` for ctrlX OS 4.x or `base: core22` for 3.x, `confinement: strict`).
core22 uses the `architectures:` syntax, core24 uses `platforms:` (compare the dltrend and hmi apps with their `-v3` versions). The workflow picks it up automatically. Web apps behind the ctrlX reverse proxy
need the `network-bind` plug. The build checks for this.

## How the build works
- Each architecture builds natively, so compiled dependencies are fine:
  core24 on `ubuntu-24.04` / `ubuntu-24.04-arm`, core22 on `ubuntu-22.04` / `ubuntu-22.04-arm`.
- The `ctrlx-datalayer` package comes from the matching ctrlX AUTOMATION SDK release
  (4.6.0 for core24, 3.6.0 for core22) and is registered as a local apt repo for `stage-packages`.
- Each snap is verified: architecture, base, strict confinement, Python version (3.12 / 3.10),
  and `network-bind` for web apps.
