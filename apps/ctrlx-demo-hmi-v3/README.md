# HMI Builder V3 (`ctrlx-demo-hmi-v3`)

Drag-and-drop web HMI for **ctrlX OS 3.x** (base `core22`). Opens from the ctrlX sidebar as
**HMI Builder V3** (`/hmi-v3`).

## Elements
| Element | Bound to a tag | In Run mode |
|---|---|---|
| Button | yes | *momentary* writes `true` while pressed, `false` on release · *toggle* writes the inverse of the current value · *set* writes a fixed value. Lit while the tag is true. |
| Lamp | yes | On when the value is non-zero, or equals a given value; on/off colors |
| Data Entry | yes | Type a value, press Enter or **Set**; it is converted to the node's own type (bool, int, float, string), with range checks |
| Data Display | yes | Value with unit, decimals and font size |
| Gauge | yes | Radial gauge with min/max, unit, warning and alarm thresholds |
| Bar Gauge | yes | Vertical or horizontal bar with min/max and thresholds |
| Text | no | Static title or label |

## Using it
1. **Edit** mode: drag an element from the left onto the screen (or click it to add).
   Select an element to set its label and **Data Layer tag**: type the path or press **Browse…** to pick it from the Data Layer tree.
   Move by dragging, resize with the corner handle, arrow keys nudge, Del deletes, Ctrl+D duplicates.
2. **+ Screen** adds more screens (tabs). With nothing selected, the right panel edits the screen's name and size.
3. **Save** (Ctrl+S). Screens are stored in the active ctrlX configuration:
   `appdata/ctrlx-demo-hmi-v3/screens.json`, so they are saved, loaded and backed up with the project
   (Settings → Solutions). Without the Solutions app they go to the snap's own data folder.
4. **Run** mode operates the HMI. The HMI opens in Run mode when screens exist.

Values refresh every 0.5 s. All reads and writes use the logged-in user's token, so the
Data Layer's permissions apply (a read-only user gets `DL_PERMISSION_DENIED` on writes).

## Develop without a device
```bash
HMI_MOCK=1 python3 -m app.main     # fake, writable Data Layer → http://127.0.0.1:8092/hmi-v3
```
