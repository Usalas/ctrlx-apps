"""Browser test (optional, needs `pip install playwright` and Chrome/Chromium).
Runs the UI against the dev server: drag & drop with snapping, prohibited areas, rotation,
auto arrange, layer copy/paste, 3D view, save to the service and CSV re-import.
    python3 tests/test_e2e.py   (CHROME=/path/to/chrome to choose the browser)
"""
import asyncio
import json
import os
import shutil
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_server import ServerTest, PREFIX  # noqa: E402

try:
    from playwright.async_api import async_playwright
except ImportError:  # pragma: no cover
    async_playwright = None

CHROME = os.getenv("CHROME") or shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser")


@unittest.skipIf(async_playwright is None, "playwright not installed")
class E2E(ServerTest):
    def test_ui(self):
        asyncio.run(self.run_ui())

    async def run_ui(self):
        url = f"http://127.0.0.1:{self.port}{PREFIX}/"
        async with async_playwright() as p:
            kw = {"args": ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"]}
            if CHROME: kw["executable_path"] = CHROME
            b = await p.chromium.launch(**kw)
            pg = await b.new_page(viewport={"width": 1600, "height": 900})
            errors = []
            pg.on("pageerror", lambda e: errors.append(str(e)))
            pg.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
            await pg.goto(url); await pg.evaluate("localStorage.clear()"); await pg.reload(); await pg.wait_for_timeout(500)
            ev = pg.evaluate
            self.assertEqual(await pg.text_content("#connBadge"), "ctrlX")

            # drag from palette onto the pallet -> snaps into the front-left corner
            drop = """([x,y]) => { const item=document.querySelector('.pal-item'); const c=document.getElementById('canvas2d');
              const r=c.getBoundingClientRect(); const dt=new DataTransfer();
              item.dispatchEvent(new DragEvent('dragstart',{dataTransfer:dt,bubbles:true}));
              const [sx,sy]=window.palletizer.editor.toScreen(x,y);
              for (const t of ['dragover','drop']) c.dispatchEvent(new DragEvent(t,{dataTransfer:dt,bubbles:true,cancelable:true,clientX:r.left+sx,clientY:r.top+sy}));
              item.dispatchEvent(new DragEvent('dragend',{dataTransfer:dt,bubbles:true})); }"""
            await ev(drop, [205, 154])
            self.assertEqual(await ev("window.palletizer.layer().boxes.map(b=>[b.x,b.y])"), [[200, 150]])
            # dropping on top of it is prohibited (red) -> rejected
            await ev(drop, [260, 180])
            self.assertEqual(await ev("window.palletizer.layer().boxes.length"), 1)
            # drop next to it snaps against its edge
            await ev(drop, [607, 160])
            self.assertEqual(await ev("window.palletizer.layer().boxes[1].x"), 600)

            # drag the 2nd box: preview state while dragging + revert when released on a prohibited spot
            ts = lambda x, y: ev(f"(()=>{{const r=document.getElementById('canvas2d').getBoundingClientRect();const [a,b]=window.palletizer.editor.toScreen({x},{y});return [r.left+a,r.top+b]}})()")
            sx, sy = await ts(600, 150); await pg.mouse.move(sx, sy); await pg.mouse.down()
            tx, ty = await ts(300, 150); await pg.mouse.move(tx, ty, steps=4)
            self.assertEqual(await ev("window.palletizer.editor.drag.state"), "bad")
            tx, ty = await ts(806, 152); await pg.mouse.move(tx, ty, steps=4)
            self.assertTrue(await ev("window.palletizer.editor.drag.snapped"))
            tx, ty = await ts(300, 150); await pg.mouse.move(tx, ty, steps=4); await pg.mouse.up()
            self.assertEqual(await ev("window.palletizer.layer().boxes[1].x"), 600)

            # double-click rotates 90, right-click sets an angle
            await pg.mouse.dblclick(sx, sy)
            self.assertEqual(await ev("window.palletizer.layer().boxes[1].rot"), 90)
            await pg.mouse.click(sx, sy, button="right"); await pg.fill("#ctxAngle", "180"); await pg.press("#ctxAngle", "Enter")
            self.assertEqual(await ev("window.palletizer.layer().boxes[1].rot"), 180)

            # auto arrange a 5-layer stack, alternate layers mirrored
            await pg.click("#btnArrange"); await pg.select_option("#arTarget", "stack"); await pg.fill("#arLayers", "5")
            await pg.select_option("#arAlt", "mirrorX"); await pg.click("#arOk"); await pg.wait_for_timeout(200)
            self.assertEqual(await ev("window.palletizer.project.layers.map(l=>l.boxes.length)"), [8] * 5)

            # copy layer 1, add an empty layer, paste
            await pg.click("#btnLayerCopy"); await pg.click("#btnLayerAdd"); await pg.click("#btnLayerPaste")
            self.assertEqual(await ev("window.palletizer.project.layers.length"), 6)
            self.assertEqual(await ev("window.palletizer.layer().boxes.length"), 8)

            # 3D view renders
            await pg.click('button[data-view="3d"]'); await pg.wait_for_timeout(1500)
            self.assertIn("1,200 × 800", await pg.inner_text("#overlay3d"))

            # save to the service, then re-import the CSV
            await pg.fill("#projectName", "e2e_stack"); await pg.dispatch_event("#projectName", "change")
            await pg.click("#btnSave"); await pg.wait_for_timeout(500)
            path = os.path.join(self.data, "e2e_stack.csv")
            self.assertTrue(os.path.isfile(path))
            with open(path) as f: rows = f.read().strip().splitlines()
            self.assertEqual(len(rows), 1 + 48)
            self.assertTrue(rows[0].startswith("Layer,Index,BoxType,PosX,PosY,PosZ,Rotation"))
            before = await ev("JSON.stringify(window.palletizer.project.layers.map(l=>l.boxes.map(b=>[b.x,b.y,b.rot])))")
            await ev("window.palletizer.project.layers=[{id:'x',boxes:[]}]")
            await pg.click("#btnOpen"); await pg.wait_for_selector('.file-row[data-n="e2e_stack.csv"] [data-a=open]')
            await pg.click('.file-row[data-n="e2e_stack.csv"] [data-a=open]'); await pg.wait_for_timeout(300)
            after = await ev("JSON.stringify(window.palletizer.project.layers.map(l=>l.boxes.map(b=>[b.x,b.y,b.rot])))")
            self.assertEqual(json.loads(before), json.loads(after))
            self.assertEqual(errors, [])
            await b.close()


if __name__ == "__main__":
    unittest.main()
