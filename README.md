# ctrlx-apps

Apps (snaps) for ctrlX OS 4.x (base `core24`), built by GitHub Actions for
**amd64** (ctrlX COREvirtual, x86 IPCs) and **arm64** (ctrlX CORE X3 and others).

| App | What it does |
|---|---|
| [`ctrlx-demo-dltrend`](apps/ctrlx-demo-dltrend) | Web app in the ctrlX sidebar: browse the Data Layer, watch list, live trend chart, CSV export |
| [`ctrlx-acme-hello`](apps/ctrlx-acme-hello) | Minimal starter: logs the CPU load from the Data Layer every 5 s |

## Getting the snaps
1. Open **Actions → Build ctrlX snaps** and pick the latest green run (or press **Run workflow**, optionally for one app).
2. Download the artifact for your target, e.g. `ctrlx-demo-dltrend-arm64` for a CORE X3, or `-amd64` for COREvirtual.
   The artifact is a zip; the `.snap` is inside.
3. ctrlX web UI → **Settings → Apps** → allow installation from unknown sources → **Install from file**.

## Adding an app
Create `apps/<snap-name>/` with a `snap/snapcraft.yaml` (snap name `ctrlx-<company>-<app>`, `base: core24`,
`confinement: strict`). The workflow picks it up automatically. Web apps behind the ctrlX reverse proxy
need the `network-bind` plug. The build checks for this.

## How the build works
- Each architecture builds natively (`ubuntu-24.04` and `ubuntu-24.04-arm`), so compiled dependencies are fine.
- The `ctrlx-datalayer` package is taken from the ctrlX AUTOMATION SDK release (`SDK_VERSION` in the workflow)
  and registered as a local apt repo for `stage-packages`.
- Each snap is verified (architecture, strict confinement, Python 3.12 for core24, `network-bind` for web apps).
