# Palletizer_3 (`ctrlx-demo-palletizer-3`)

Pallet pattern editor for **ctrlX OS 3.x** (base `core22`). It opens from the ctrlX sidebar as
**Palletizer_3** (`/palletizer_3`), either embedded in the ctrlX page or in a new tab.
The ctrlX OS 4.x build is [`ctrlx-demo-palletizer-3`](../ctrlx-demo-palletizer-3) (**Palletizer_4**, `/palletizer_3`). Both can be installed side by side.

You drag boxes onto a pallet layer by layer and check the result in 2D and 3D. The app can auto-arrange boxes for the most pallet area, keep box labels facing out, and save a CSV with **Layer, X, Y, Z, Rotation** for the robot.

## Using it
| Area | What it does |
|---|---|
| ☰ Configuration | **Pallets**: standard sizes (EUR 1/2/3/6, quarter, GMA 48×40, 42×42, 48×48, Asia 1100, AUS 1165, ISO 1067) plus your own custom pallets. **Boxes**: L/W/H, weight, colour, label side and an optional **image** used as the box (top face, all faces or label face). **Margins & spacing**: margins on each side (negative = overhang), gap between boxes, slip sheet, grid and snap distance. **CSV export** options. **ctrlX** file list. |
| Drag & drop | Drag a box from the left panel onto the pallet. It **snaps** to margins, the pallet centre, neighbouring boxes (keeping the gap) and the layer below. While dragging, the box is **cyan** when it is on a snap position, **orange** when it is closer to a neighbour than the gap, and **red** over a prohibited area (overlap, outside the pallet, inside a margin). The margin band is shaded red. A box released on red goes back where it was (*Block invalid drops*). |
| Editing | Double-click rotates 90°. Right-click lets you type an angle, or rotate, duplicate, turn the label out or delete. Shift+click or drag a rectangle to select several boxes. Arrow keys nudge (Shift = 10 mm), R / Shift+R rotate, Ctrl+C/V copy and paste, Ctrl+Z/Y undo and redo, mouse wheel zooms, Space+drag pans. |
| Label mark | Each box shows a white label with a barcode and an arrow on its label side. **Green**: faces out. **Red**: a box on the outside of the load whose label faces in. **Grey**: interior box, no requirement. **Labels out** turns outside boxes (180°, or 90° where the box still fits) so their labels face out. |
| Layers | Add, duplicate, **copy / paste** (Shift+Paste inserts a new layer), delete, move up or down, mirror X/Y, rotate 180°, centre, clear. PgUp/PgDn change the selected layer. |
| Auto arrange | Fits as many boxes of the selected type as possible: the best guillotine pattern plus 5-block pinwheel patterns. It can also fill the free space around boxes already placed. Apply it to one layer, all layers or a whole stack (N layers, or as many as fit under the pallet's maximum load height), with alternate layers rotated or mirrored. |
| 2D / Split / 3D | 3D view with total **L × W × H** dimensions. The right panel shows totals (weight and height against the pallet limits, area and volume use) and a front/side view. |
| Files | **Save to ctrlX** writes `<name>.csv` and `<name>.pallet.json` (the full project, including images). **Open** loads a project or **any CSV** from ctrlX or your computer and shows it in 2D and 3D. **CSV ↓** downloads the CSV. |

Files are stored in the active ctrlX configuration:
`appdata/ctrlx-demo-palletizer-3/` (Settings → Solutions → Manage app data). They are saved, loaded and backed up together with the project.
Without the Solutions app they go to the snap's own data folder.

## CSV
```
Layer,Index,BoxType,PosX,PosY,PosZ,Rotation,BoxLength,BoxWidth,BoxHeight,BoxWeight,LabelDir,PalletLength,PalletWidth,PalletHeight
1,1,Carton 400×300,150.0,200.0,250.0,90.0,400.0,300.0,250.0,8.0,+X,1200.0,800.0,144.0
```
* **PosX/PosY** are the box centre. Origin is the front-left pallet corner, or the pallet centre. X runs along the pallet length.
* **PosZ** is the top of the box by default (the place height), or bottom or centre. It is measured from the pallet top by default, or from the floor.
* **Rotation** is degrees counter-clockwise about Z, as 0…360 or ±180. At 0° the box length runs along X.
* **LabelDir** is `+X`, `-X`, `+Y`, `-Y` or `none`.
* Other options: delimiter (`,` `;` tab), decimals, box order within each layer (as placed, rows from the origin, far side first), and whether to include the header row and the dimension columns.
* **Import** accepts common header names (`x`, `posx`, `rot`, `angle`, `layer`, `length`, …), `,` `;` or tab delimiters, and a decimal comma with `;`. Box types and pallets are matched by their dimensions; if there's no match, a new type or a custom pallet is created.

## API (needs the user's token; the page itself does not)
| | |
|---|---|
| `GET /palletizer_3/api/v1/status` | version, storage location |
| `GET /palletizer_3/api/v1/files` | list `.csv` / `.json` / `.txt` |
| `GET` / `PUT` / `DELETE /palletizer_3/api/v1/files/<name>` | read / write (atomic) / delete |

If the app is opened without a token from the menu, it asks for a ctrlX login on the first save (`/identity-manager/api/v2/auth/token`).

## Develop and test without a device
```bash
python3 -m app.main                 # http://127.0.0.1:8093/palletizer_3/  (files in ./data)
tests/run_tests.sh                  # JS unit tests (node >= 22), service tests, browser test
```
The browser test needs `pip install playwright` and Chrome or Chromium (set `CHROME=/path` if needed). If Playwright isn't installed, it is skipped.
