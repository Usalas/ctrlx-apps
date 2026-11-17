import { STANDARD_PALLETS, BOX_COLORS, defaultProject } from './data.js';
import { evaluateLayer, labelStatus, orientLabels, layerBases, layerHeight, aabb, usableRect, normRot, uid } from './geom.js';
import { bestPattern, fillFree, transformLayer, centerBoxes } from './arrange.js';
import { buildCsv, parseCsv, csvToProject } from './csv.js';
import { api } from './api.js';
import { Editor2D } from './editor2d.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const LS_KEY = 'palletizer.project:' + location.pathname; // separate per app (_3 / _4)
const fmt = (v, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString('en-US', { maximumFractionDigits: d });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ------------------------------------------------------------------ state
const app = {
  project: null, types: new Map(), images: new Map(),
  layerIndex: 0, selection: new Set(), evalMap: new Map(), labelMap: new Map(),
  snapOn: true, ghostOn: true, blockInvalid: true, focusLayer: false, upToLayer: false,
  activeTypeId: null, dragTypeId: null, clipboardLayer: null, clipboardBoxes: null,
  history: [], hIndex: -1, view: '2d', view3d: null, editor: null,

  palletLib() { return [...STANDARD_PALLETS, ...this.project.customPallets]; },
  pallet() { return this.palletLib().find((p) => p.id === this.project.palletId) || STANDARD_PALLETS[0]; },
  layer() { return this.project.layers[this.layerIndex]; },

  select(ids, quiet) {
    this.selection = new Set(ids);
    this.editor.draw(); renderSelection();
    if (!quiet) schedule3d();
  },
  cursor(x, y) { $('#statusCursor').textContent = x == null ? 'X — Y —' : `X ${fmt(x)}  Y ${fmt(y)} mm`; },
  liveUpdate() { this.labelMap = labelStatus(this.layer(), this.types, this.pallet()); this.editor.draw(); renderSelection(); schedule3d(true); },
  commit(msg) {
    pushHistory();
    save();
    refresh();
    if (msg) status(msg);
  },
  toast,
  showContext, hideContext,
  rotateSelection(d) { rotateSelection(d); },
};
window.palletizer = app; // handy for debugging from the console

// ------------------------------------------------------------------ persistence & history
function snapshot() { return JSON.stringify({ layers: app.project.layers, palletId: app.project.palletId }); }
function pushHistory() {
  app.history = app.history.slice(0, app.hIndex + 1);
  app.history.push(snapshot());
  if (app.history.length > 200) app.history.shift();
  app.hIndex = app.history.length - 1;
}
function undoRedo(dir) {
  const i = app.hIndex + dir; if (i < 0 || i >= app.history.length) return;
  app.hIndex = i;
  const s = JSON.parse(app.history[i]);
  app.project.layers = s.layers; app.project.palletId = s.palletId;
  app.layerIndex = Math.min(app.layerIndex, app.project.layers.length - 1);
  app.selection.clear(); save(); refresh(); status(dir < 0 ? 'Undo' : 'Redo');
}
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(app.project)); } catch (e) { console.warn('localStorage', e); } }, 200);
}
function loadProject(p) {
  const d = defaultProject();
  p.settings = { ...d.settings, ...(p.settings || {}), csv: { ...d.settings.csv, ...((p.settings || {}).csv || {}) }, margins: { ...d.settings.margins, ...((p.settings || {}).margins || {}) } };
  p.customPallets = p.customPallets || []; p.boxTypes = p.boxTypes || []; p.layers = p.layers && p.layers.length ? p.layers : [{ id: uid(), boxes: [] }];
  app.project = p;
  app.layerIndex = 0; app.selection.clear();
  rebuildTypes();
  if (!app.activeTypeId || !app.types.has(app.activeTypeId)) app.activeTypeId = p.boxTypes[0] ? p.boxTypes[0].id : null;
  app.history = []; app.hIndex = -1; pushHistory();
  $('#projectName').value = p.name || 'pattern_01';
  fillSettingsUI();
}
function rebuildTypes() {
  app.types = new Map(app.project.boxTypes.map((t) => [t.id, t]));
  for (const t of app.project.boxTypes) {
    const cur = app.images.get(t.id);
    if (t.image) { if (!cur || cur.src !== t.image) { const im = new Image(); im.onload = () => { app.editor && app.editor.draw(); renderPalette(); schedule3d(); }; im.src = t.image; app.images.set(t.id, im); } }
    else app.images.delete(t.id);
  }
}

// ------------------------------------------------------------------ refresh
function refresh() {
  rebuildTypes();
  const p = app.pallet(), st = app.project.settings;
  app.layerIndex = Math.max(0, Math.min(app.layerIndex, app.project.layers.length - 1));
  const L = app.layer();
  app.evalMap = evaluateLayer(L, app.types, p, st);
  app.labelMap = labelStatus(L, app.types, p);
  for (const id of [...app.selection]) if (!L.boxes.some((b) => b.id === id)) app.selection.delete(id);
  renderPalletSelect(); renderPalette(); renderLayers(); renderSelection(); renderTotals(); renderSide();
  app.editor.draw();
  schedule3d();
  if ($('#drawer').classList.contains('open')) renderDrawer();
  $('#btnUndo').disabled = app.hIndex <= 0; $('#btnRedo').disabled = app.hIndex >= app.history.length - 1;
}

let t3d = null, last3d = 0;
function schedule3d(throttle) {
  if (app.view === '2d' || !app.view3d) return;
  const now = performance.now();
  if (throttle && now - last3d < 120) { clearTimeout(t3d); t3d = setTimeout(() => schedule3d(), 130); return; }
  clearTimeout(t3d);
  t3d = setTimeout(() => { last3d = performance.now(); const d = app.view3d.update(); renderOverlay3d(d); }, throttle ? 0 : 30);
}

function status(msg) { $('#statusMsg').textContent = msg; }
let toastT;
function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false; t.classList.toggle('error', !!err);
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), 2600);
}

// ------------------------------------------------------------------ header / pallet select
function renderPalletSelect() {
  const sel = $('#palletSelect'); const lib = app.palletLib();
  const html = lib.map((p) => `<option value="${p.id}">${esc(p.name)} — ${p.L}×${p.W}${p.std ? '' : ' (custom)'}</option>`).join('');
  if (sel.dataset.h !== html) { sel.innerHTML = html; sel.dataset.h = html; }
  sel.value = app.project.palletId;
}

// ------------------------------------------------------------------ palette
function thumb(t, size = 46) {
  const c = document.createElement('canvas'); const dpr = window.devicePixelRatio || 1;
  c.width = size * dpr; c.height = size * dpr; c.style.width = c.style.height = size + 'px';
  const g = c.getContext('2d'); g.scale(dpr, dpr);
  const k = (size - 6) / Math.max(t.L, t.W); const w = t.L * k, h = t.W * k;
  const x = (size - w) / 2, y = (size - h) / 2;
  const img = app.images.get(t.id);
  if (img && img.complete && img.naturalWidth && t.imageMode !== 'label') g.drawImage(img, x, y, w, h);
  else { g.fillStyle = t.color; g.fillRect(x, y, w, h); }
  g.strokeStyle = 'rgba(0,0,0,.6)'; g.strokeRect(x + .5, y + .5, w - 1, h - 1);
  if (t.labelSide !== 'none') {
    g.save(); g.translate(size / 2, size / 2);
    let fw = w, fd = h;
    if (t.labelSide === 'back') g.rotate(Math.PI);
    if (t.labelSide === 'right') { g.rotate(-Math.PI / 2); fw = h; fd = w; }
    if (t.labelSide === 'left') { g.rotate(Math.PI / 2); fw = h; fd = w; }
    g.fillStyle = '#fff'; g.fillRect(-fw * 0.28, fd / 2 - fd * 0.28, fw * 0.56, fd * 0.24);
    g.fillStyle = '#111'; for (let i = 0; i < 7; i++) g.fillRect(-fw * 0.22 + i * fw * 0.065, fd / 2 - fd * 0.24, 1, fd * 0.14);
    g.restore();
  }
  return c;
}
function renderPalette() {
  const el = $('#boxPalette'); el.innerHTML = '';
  for (const t of app.project.boxTypes) {
    const d = document.createElement('div'); d.className = 'pal-item' + (t.id === app.activeTypeId ? ' active' : ''); d.draggable = true;
    d.title = 'Drag onto the pallet. Double-click: place in next free spot.';
    d.appendChild(thumb(t));
    const m = document.createElement('div'); m.className = 'meta';
    m.innerHTML = `<b>${esc(t.name)}</b><span>${t.L} × ${t.W} × ${t.H} mm · ${fmt(t.weight || 0, 2)} kg</span>`;
    d.appendChild(m);
    d.addEventListener('click', () => { app.activeTypeId = t.id; renderPalette(); });
    d.addEventListener('dblclick', () => {
      const add = fillFree(t, app.layer(), app.types, app.pallet(), app.project.settings, 1);
      if (!add.length) return toast('No free space for this box in the layer', true);
      app.layer().boxes.push(...add); app.select(add.map((b) => b.id), true); app.commit('Box added');
    });
    d.addEventListener('dragstart', (e) => {
      app.dragTypeId = t.id; app.activeTypeId = t.id;
      e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'copy';
      const ghost = thumb(t, 40); ghost.style.position = 'absolute'; ghost.style.left = '-200px'; document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 20, 20); setTimeout(() => ghost.remove(), 0);
    });
    d.addEventListener('dragend', () => { app.dragTypeId = null; app.editor.preview = null; app.editor.guides = []; app.editor.draw(); });
    el.appendChild(d);
  }
}

// ------------------------------------------------------------------ layers
function renderLayers() {
  const el = $('#layerList'); const types = app.types; const p = app.pallet(), st = app.project.settings;
  const { bases } = layerBases(app.project.layers, types, st.slip);
  el.innerHTML = '';
  app.project.layers.forEach((L, i) => {
    const ev = i === app.layerIndex ? app.evalMap : evaluateLayer(L, types, p, st);
    let bad = 0, warn = 0; for (const v of ev.values()) { if (v.state === 'bad') bad++; else if (v.state === 'warn') warn++; }
    const lab = i === app.layerIndex ? app.labelMap : labelStatus(L, types, p);
    let lin = 0; for (const v of lab.values()) if (v === 'in') lin++;
    const li = document.createElement('li'); li.className = i === app.layerIndex ? 'active' : '';
    li.innerHTML = `<span class="num">${i + 1}</span><span class="info"><b>${L.boxes.length} boxes</b> · h ${fmt(layerHeight(L, types))} · z ${fmt(bases[i])}</span>
      <span class="flag ${bad ? 'bad' : warn || lin ? 'warn' : ''}" title="${bad} overlaps/outside, ${warn} spacing/margin, ${lin} labels facing in">${bad ? '⛔' + bad : ''}${warn ? ' ⚠' + warn : ''}${lin ? ' 🏷' + lin : ''}</span>`;
    li.addEventListener('click', () => { app.layerIndex = i; app.selection.clear(); refresh(); });
    el.appendChild(li);
  });
}
function layerOp(op, e) {
  const P = app.project; const i = app.layerIndex; const p = app.pallet();
  switch (op) {
    case 'add': P.layers.splice(i + 1, 0, { id: uid(), boxes: [] }); app.layerIndex = i + 1; break;
    case 'dup': P.layers.splice(i + 1, 0, { id: uid(), boxes: P.layers[i].boxes.map((b) => ({ ...b, id: uid() })) }); app.layerIndex = i + 1; break;
    case 'copy': app.clipboardLayer = JSON.parse(JSON.stringify(P.layers[i].boxes)); toast(`Layer ${i + 1} copied (${app.clipboardLayer.length} boxes)`); return;
    case 'paste': {
      if (!app.clipboardLayer) return toast('Copy a layer first', true);
      const boxes = app.clipboardLayer.map((b) => ({ ...b, id: uid() }));
      if (e && e.shiftKey) { P.layers.splice(i + 1, 0, { id: uid(), boxes }); app.layerIndex = i + 1; }
      else P.layers[i].boxes = boxes;
      break;
    }
    case 'del':
      if (P.layers.length === 1) P.layers[0].boxes = [];
      else { P.layers.splice(i, 1); app.layerIndex = Math.max(0, i - 1); }
      break;
    case 'up': if (i < P.layers.length - 1) { [P.layers[i], P.layers[i + 1]] = [P.layers[i + 1], P.layers[i]]; app.layerIndex++; } break;
    case 'down': if (i > 0) { [P.layers[i], P.layers[i - 1]] = [P.layers[i - 1], P.layers[i]]; app.layerIndex--; } break;
    case 'mirX': P.layers[i].boxes = transformLayer(P.layers[i].boxes, p, 'mirrorX'); break;
    case 'mirY': P.layers[i].boxes = transformLayer(P.layers[i].boxes, p, 'mirrorY'); break;
    case 'rot': P.layers[i].boxes = transformLayer(P.layers[i].boxes, p, 'rot180'); break;
    case 'center': P.layers[i].boxes = centerBoxes(P.layers[i].boxes, app.types, usableRect(p, P.settings.margins)); break;
    case 'clear': P.layers[i].boxes = []; break;
  }
  app.selection.clear(); app.commit('Layer ' + op);
}

// ------------------------------------------------------------------ selection panel
function selectedBoxes() { return app.layer().boxes.filter((b) => app.selection.has(b.id)); }
function renderSelection() {
  const el = $('#selPanel'); const sel = selectedBoxes();
  if (document.activeElement && el.contains(document.activeElement) && sel.length === 1 && el.dataset.id === sel[0].id) {
    // keep editing field, update the others
    for (const k of ['x', 'y', 'rot']) { const inp = el.querySelector(`[data-k="${k}"]`); if (inp && inp !== document.activeElement) inp.value = fmt(sel[0][k]); }
    return;
  }
  el.dataset.id = sel.length === 1 ? sel[0].id : '';
  if (!sel.length) { el.innerHTML = '<p class="hint">Click a box to select. Shift+click or drag a rectangle for multiple. Double-click rotates 90°, right-click for angle. Arrow keys nudge (Shift = 10 mm), Del removes.</p>'; return; }
  if (sel.length > 1) {
    el.innerHTML = `<p><b>${sel.length}</b> boxes selected</p><div class="btn-row">
      <button class="mini" data-a="r90">↻ 90°</button><button class="mini" data-a="r-90">↺ 90°</button><button class="mini" data-a="lbl">Labels out</button><button class="mini danger" data-a="del">Delete</button></div>`;
  } else {
    const b = sel[0]; const t = app.types.get(b.typeId);
    const ev = app.evalMap.get(b.id) || { state: 'ok', reasons: [] }; const lab = app.labelMap.get(b.id);
    const labTxt = { out: '✔ facing out', in: '✖ facing in (perimeter box)', interior: 'interior box – ignored', none: 'no label' }[lab] || '';
    el.innerHTML = `
      <div class="row"><span>Box</span><select data-k="typeId">${app.project.boxTypes.map((x) => `<option value="${x.id}" ${x.id === b.typeId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div class="row"><span>X (mm)</span><input data-k="x" type="number" step="1" value="${fmt(b.x)}"></div>
      <div class="row"><span>Y (mm)</span><input data-k="y" type="number" step="1" value="${fmt(b.y)}"></div>
      <div class="row"><span>Rot (°)</span><input data-k="rot" type="number" step="1" value="${fmt(b.rot)}"></div>
      <div class="row"><span>Size</span><b>${t.L} × ${t.W} × ${t.H}</b></div>
      <div class="row"><span>Label</span><span style="color:${lab === 'in' ? 'var(--bad)' : lab === 'out' ? 'var(--ok)' : 'var(--muted)'}">${labTxt}</span></div>
      <div class="row"><span>Check</span><span style="color:${ev.state === 'bad' ? 'var(--bad)' : ev.state === 'warn' ? 'var(--warn)' : 'var(--ok)'}">${ev.reasons.join(', ') || 'OK'}</span></div>
      <div class="btn-row"><button class="mini" data-a="r90">↻ 90°</button><button class="mini" data-a="r-90">↺ 90°</button><button class="mini" data-a="r180">180°</button><button class="mini" data-a="lbl">Label out</button><button class="mini danger" data-a="del">Delete</button></div>`;
  }
}
function selPanelEvents() {
  const el = $('#selPanel');
  el.addEventListener('change', (e) => {
    const k = e.target.dataset.k; if (!k) return; const b = selectedBoxes()[0]; if (!b) return;
    if (k === 'typeId') b.typeId = e.target.value;
    else { const v = parseFloat(e.target.value); if (isNaN(v)) return; b[k] = k === 'rot' ? normRot(v) : v; }
    app.commit('Edit box');
  });
  el.addEventListener('click', (e) => { const a = e.target.dataset.a; if (a) ctxAction(a); });
}

// ------------------------------------------------------------------ box actions
function rotateSelection(d) {
  const sel = selectedBoxes(); if (!sel.length) return;
  for (const b of sel) b.rot = normRot(b.rot + d);
  app.commit(`Rotate ${d}°`);
}
function deleteSelection() {
  const L = app.layer(); const n = app.selection.size; if (!n) return;
  L.boxes = L.boxes.filter((b) => !app.selection.has(b.id)); app.selection.clear(); app.commit(`Deleted ${n}`);
}
function labelsOut(onlySel) {
  const L = app.layer();
  if (onlySel) {
    const keep = L.boxes; const sub = { boxes: keep };
    const before = new Map(keep.map((b) => [b.id, b.rot]));
    const r = orientLabels(sub, app.types, app.pallet(), app.project.settings);
    for (const b of keep) if (!app.selection.has(b.id)) b.rot = before.get(b.id);
    app.commit(`Labels: ${r.fixed} turned`);
    return;
  }
  let fixed = 0, failed = 0;
  for (const layer of app.project.layers) { const r = orientLabels(layer, app.types, app.pallet(), app.project.settings); fixed += r.fixed; failed += r.failed; }
  app.commit(`Labels: ${fixed} boxes turned`);
  toast(failed ? `${fixed} boxes turned, ${failed} could not face out without collision` : `${fixed} boxes turned – all perimeter labels face out`, failed > 0);
}
function ctxAction(a) {
  hideContext();
  if (a === 'r90') rotateSelection(90);
  else if (a === 'r-90') rotateSelection(-90);
  else if (a === 'r180') rotateSelection(180);
  else if (a === 'del') deleteSelection();
  else if (a === 'lbl' || a === 'labelOut') labelsOut(true);
  else if (a === 'dup') {
    const add = [];
    for (const b of selectedBoxes()) {
      const t = app.types.get(b.typeId);
      const free = fillFree(t, { boxes: [...app.layer().boxes, ...add] }, app.types, app.pallet(), app.project.settings, 1);
      if (free.length) { free[0].rot = free[0].rot; add.push(free[0]); }
    }
    if (!add.length) return toast('No free space to duplicate into', true);
    app.layer().boxes.push(...add); app.selection = new Set(add.map((b) => b.id)); app.commit('Duplicated');
  }
}

// ------------------------------------------------------------------ context menu
function showContext(x, y) {
  const m = $('#ctxMenu'); m.hidden = false;
  const sel = selectedBoxes(); $('#ctxAngle').value = sel.length ? fmt(sel[0].rot) : 0;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px'; m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  setTimeout(() => { $('#ctxAngle').focus(); $('#ctxAngle').select(); }, 0);
}
function hideContext() { $('#ctxMenu').hidden = true; }
function ctxEvents() {
  const m = $('#ctxMenu');
  m.addEventListener('click', (e) => { const a = e.target.dataset.act; if (a) ctxAction(a); });
  const setAngle = () => { const v = parseFloat($('#ctxAngle').value); if (isNaN(v)) return; for (const b of selectedBoxes()) b.rot = normRot(v); hideContext(); app.commit(`Rotation ${v}°`); };
  $('#ctxAngleOk').addEventListener('click', setAngle);
  $('#ctxAngle').addEventListener('keydown', (e) => { if (e.key === 'Enter') setAngle(); if (e.key === 'Escape') hideContext(); e.stopPropagation(); });
  document.addEventListener('pointerdown', (e) => { if (!m.hidden && !m.contains(e.target)) hideContext(); });
}

// ------------------------------------------------------------------ totals & side view
function computeTotals() {
  const p = app.pallet(), types = app.types, P = app.project;
  const { top } = layerBases(P.layers, types, P.settings.slip);
  let n = 0, kg = 0, x0 = 0, x1 = p.L, y0 = 0, y1 = p.W, vol = 0;
  for (const L of P.layers) for (const b of L.boxes) {
    const t = types.get(b.typeId); if (!t) continue; n++; kg += t.weight || 0; vol += t.L * t.W * t.H;
    const A = aabb(b, t); x0 = Math.min(x0, A.x0); x1 = Math.max(x1, A.x1); y0 = Math.min(y0, A.y0); y1 = Math.max(y1, A.y1);
  }
  const L = app.layer(); let area = 0; for (const b of L.boxes) { const t = types.get(b.typeId); if (t) area += t.L * t.W; }
  return { n, kg, totKg: kg + (p.weight || 0), totL: x1 - x0, totW: y1 - y0, loadH: top, totH: top + p.H, areaPct: (100 * area) / (p.L * p.W), volPct: p.maxH ? (100 * vol) / (p.L * p.W * p.maxH) : 0 };
}
function renderTotals() {
  const p = app.pallet(); const T = computeTotals();
  let warnBoxes = 0, labIn = 0;
  for (const L of app.project.layers) {
    for (const v of evaluateLayer(L, app.types, p, app.project.settings).values()) if (v.state !== 'ok') warnBoxes++;
    for (const v of labelStatus(L, app.types, p).values()) if (v === 'in') labIn++;
  }
  const hOver = p.maxH && T.loadH > p.maxH, kgOver = p.maxKg && T.kg > p.maxKg;
  $('#totals').innerHTML = `
    <span>Pallet</span><span>${esc(p.name)}</span>
    <span>Pallet size</span><span>${p.L} × ${p.W} × ${p.H}</span>
    <span>Total L × W</span><span class="big">${fmt(T.totL)} × ${fmt(T.totW)}</span>
    <span>Total height</span><span class="big">${fmt(T.totH)} mm</span>
    <span>Load height</span><span class="${hOver ? 'over' : ''}">${fmt(T.loadH)}${p.maxH ? ' / ' + p.maxH : ''}</span>
    <span>Layers / boxes</span><span>${app.project.layers.length} / ${T.n}</span>
    <span>Load weight</span><span class="${kgOver ? 'over' : ''}">${fmt(T.kg, 1)} kg${p.maxKg ? ' / ' + p.maxKg : ''}</span>
    <span>Gross weight</span><span>${fmt(T.totKg, 1)} kg</span>
    <span>Layer area use</span><span>${fmt(T.areaPct)} %</span>
    <span>Volume use</span><span>${fmt(T.volPct)} %</span>`;
  const msgs = [];
  if (warnBoxes) msgs.push(`⚠ ${warnBoxes} box issues`);
  if (labIn) msgs.push(`🏷 ${labIn} labels facing in`);
  if (hOver) msgs.push('height over limit'); if (kgOver) msgs.push('weight over limit');
  $('#statusWarn').textContent = msgs.join(' · ');
  return T;
}
let sideAxis = 'x';
function renderSide() {
  const c = $('#sideCanvas'); const r = c.getBoundingClientRect(); if (!r.width) return;
  const dpr = window.devicePixelRatio || 1; c.width = r.width * dpr; c.height = r.height * dpr;
  const g = c.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, r.width, r.height);
  const p = app.pallet(), types = app.types, P = app.project;
  const { bases, top } = layerBases(P.layers, types, P.settings.slip);
  const span = sideAxis === 'x' ? p.L : p.W;
  const totH = p.H + Math.max(top, p.maxH || 0) * 1.02;
  const k = Math.min((r.width - 60) / (span * 1.1), (r.height - 30) / totH);
  const ox = 40 + (r.width - 40 - span * k) / 2 - 10, oy = r.height - 14;
  // pallet
  g.fillStyle = '#7d5e38'; g.fillRect(ox, oy - p.H * k, span * k, p.H * k * 0.18);
  g.fillRect(ox, oy - p.H * k * 0.18, span * k, p.H * k * 0.18);
  for (const f of [0, 0.5, 1]) g.fillRect(ox + f * (span - Math.min(145, span * 0.13)) * k, oy - p.H * k, Math.min(145, span * 0.13) * k, p.H * k);
  if (p.maxH) { g.strokeStyle = 'rgba(229,72,77,.6)'; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(ox - 6, oy - (p.H + p.maxH) * k); g.lineTo(ox + span * k + 6, oy - (p.H + p.maxH) * k); g.stroke(); g.setLineDash([]); }
  P.layers.forEach((L, li) => {
    for (const b of L.boxes) {
      const t = types.get(b.typeId); if (!t) continue; const A = aabb(b, t);
      const a0 = sideAxis === 'x' ? A.x0 : A.y0, a1 = sideAxis === 'x' ? A.x1 : A.y1;
      const z0 = p.H + bases[li];
      g.fillStyle = li === app.layerIndex ? 'rgba(47,180,200,.35)' : hexA(t.color, 0.25);
      g.strokeStyle = li === app.layerIndex ? '#2fb4c8' : 'rgba(255,255,255,.35)';
      g.fillRect(ox + a0 * k, oy - (z0 + t.H) * k, (a1 - a0) * k, t.H * k);
      g.strokeRect(ox + a0 * k + .5, oy - (z0 + t.H) * k + .5, (a1 - a0) * k - 1, t.H * k - 1);
    }
  });
  // height dim
  const H = p.H + top; g.strokeStyle = '#9fb0c0'; g.fillStyle = '#9fb0c0'; g.beginPath();
  g.moveTo(ox - 18, oy); g.lineTo(ox - 18, oy - H * k); g.moveTo(ox - 22, oy); g.lineTo(ox - 14, oy); g.moveTo(ox - 22, oy - H * k); g.lineTo(ox - 14, oy - H * k); g.stroke();
  g.save(); g.translate(ox - 24, oy - H * k / 2); g.rotate(-Math.PI / 2); g.font = '11px system-ui'; g.textAlign = 'center'; g.fillText(`${fmt(H)} mm`, 0, 0); g.restore();
  g.font = '10px system-ui'; g.textAlign = 'center'; g.fillText(`${sideAxis === 'x' ? 'X' : 'Y'} ${span} mm`, ox + span * k / 2, oy + 11);
}
function hexA(hex, a) { const n = parseInt((hex || '#888888').slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
function renderOverlay3d(d) {
  const T = computeTotals(); const p = app.pallet();
  $('#overlay3d').innerHTML = `<b>${esc(p.name)}</b><br>Total: <b>${fmt(d ? d.totL : T.totL)} × ${fmt(d ? d.totW : T.totW)} × ${fmt(T.totH)} mm</b><br>${app.project.layers.length} layers · ${T.n} boxes · ${fmt(T.totKg)} kg gross<br><span style="color:var(--muted)">Layer ${app.layerIndex + 1} highlighted</span>`;
}

// ------------------------------------------------------------------ views
async function setView(v) {
  app.view = v; $('#views').dataset.mode = v;
  $$('.view-tabs .seg button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $('.tools3d').style.display = v === '2d' ? 'none' : ''; $('.tools2d').style.display = v === '3d' ? 'none' : '';
  if (v !== '2d' && !app.view3d) {
    try {
      const { View3D } = await import('./view3d.js');
      app.view3d = new View3D($('#three'), app);
    } catch (e) { console.error(e); toast('3D view could not start: ' + e.message, true); return; }
  }
  requestAnimationFrame(() => { app.editor.resize(); app.editor.fit(); if (app.view3d) { app.view3d.resize(); schedule3d(); } });
}

// ------------------------------------------------------------------ drawer / configuration
let editingPallet = null, editingBox = null, pendingImage;
function openDrawer(tab) {
  $('#drawer').classList.add('open'); $('#drawerScrim').hidden = false; $('#drawer').setAttribute('aria-hidden', 'false');
  if (tab) setTab(tab);
  renderDrawer();
}
function closeDrawer() { $('#drawer').classList.remove('open'); $('#drawerScrim').hidden = true; $('#drawer').setAttribute('aria-hidden', 'true'); }
function setTab(tab) {
  $$('.drawer-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.drawer-body .tab').forEach((t) => (t.hidden = t.dataset.tab !== tab));
  renderDrawer();
}
function curTab() { return ($('.drawer-tabs button.active') || {}).dataset?.tab; }
function renderDrawer() {
  const tab = curTab();
  if (tab === 'pallets') renderPalletTab();
  if (tab === 'boxes') renderBoxTab();
  if (tab === 'csv') $('#csvPreview').textContent = previewCsv();
  if (tab === 'ctrlx') renderCtrlxTab();
}
function renderPalletTab() {
  const tb = $('#palletTable tbody');
  tb.innerHTML = app.palletLib().map((p) => `<tr data-id="${p.id}" class="${editingPallet === p.id ? 'editing' : ''}">
    <td><input type="radio" name="actPal" ${p.id === app.project.palletId ? 'checked' : ''} title="Use this pallet"></td>
    <td>${esc(p.name)}${p.std ? '<span class="tag">standard</span>' : ''}</td><td>${p.L}</td><td>${p.W}</td><td>${p.H}</td>
    <td class="act">${p.std ? '<button class="mini" data-a="copy">Copy</button>' : '<button class="mini danger" data-a="del">✕</button>'}</td></tr>`).join('');
  if (!editingPallet) editingPallet = app.project.palletId;
  fillPalletForm(app.palletLib().find((p) => p.id === editingPallet));
}
function fillPalletForm(p) {
  const f = $('#palletForm'); if (!p) return;
  for (const k of ['name', 'L', 'W', 'H', 'weight', 'maxH', 'maxKg']) f.elements[k].value = p[k] ?? '';
  const ro = !!p.std; for (const el of f.elements) if (el.tagName === 'INPUT') el.readOnly = ro;
  $('#palletSaveBtn').disabled = ro;
  $('#palletFormTitle').textContent = ro ? `Pallet: ${p.name} (standard – use Copy to customise)` : `Custom pallet: ${p.name}`;
}
function palletEvents() {
  $('#palletTable').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return; const id = tr.dataset.id; const a = e.target.dataset.a;
    if (e.target.name === 'actPal') { app.project.palletId = id; editingPallet = id; app.commit('Pallet changed'); app.editor.fit(); app.view3d && app.view3d.resetView(); return; }
    if (a === 'copy') {
      const src = app.palletLib().find((p) => p.id === id);
      const np = { ...src, id: 'cp_' + uid(), name: src.name + ' (custom)', std: false }; delete np.std;
      app.project.customPallets.push(np); editingPallet = np.id; save(); refresh(); renderPalletTab(); return;
    }
    if (a === 'del') {
      app.project.customPallets = app.project.customPallets.filter((p) => p.id !== id);
      if (app.project.palletId === id) app.project.palletId = 'eur1';
      editingPallet = app.project.palletId; app.commit('Pallet deleted'); return;
    }
    editingPallet = id; renderPalletTab();
  });
  $('#palletNew').addEventListener('click', () => {
    const np = { id: 'cp_' + uid(), name: 'Custom pallet', L: 1200, W: 800, H: 150, weight: 25, maxH: 1800, maxKg: 1000 };
    app.project.customPallets.push(np); editingPallet = np.id; save(); refresh(); renderPalletTab();
  });
  $('#palletForm').addEventListener('submit', (e) => {
    e.preventDefault(); const f = e.target;
    const p = app.project.customPallets.find((x) => x.id === editingPallet); if (!p) return;
    p.name = f.elements.name.value.trim() || 'Custom';
    for (const k of ['L', 'W', 'H', 'weight', 'maxH', 'maxKg']) p[k] = parseFloat(f.elements[k].value) || 0;
    app.commit('Pallet saved'); app.editor.fit(); toast('Pallet saved');
  });
}
function renderBoxTab() {
  const tb = $('#boxTable tbody');
  tb.innerHTML = app.project.boxTypes.map((t) => `<tr data-id="${t.id}" class="${editingBox === t.id ? 'editing' : ''}">
    <td><span class="sw" style="background:${t.color}"></span></td><td>${esc(t.name)}${t.image ? '<span class="tag">image</span>' : ''}</td>
    <td>${t.L}</td><td>${t.W}</td><td>${t.H}</td><td>${t.weight ?? ''}</td>
    <td class="act"><button class="mini" data-a="copy">Copy</button> <button class="mini danger" data-a="del">✕</button></td></tr>`).join('');
  if (!editingBox || !app.types.has(editingBox)) editingBox = app.project.boxTypes[0]?.id || null;
  fillBoxForm(app.types.get(editingBox));
}
function fillBoxForm(t) {
  const f = $('#boxForm');
  t = t || { name: 'New box', L: 400, W: 300, H: 200, weight: 5, color: BOX_COLORS[app.project.boxTypes.length % BOX_COLORS.length], labelSide: 'front', imageMode: 'top', image: null };
  for (const k of ['name', 'L', 'W', 'H', 'weight', 'color', 'labelSide', 'imageMode']) f.elements[k].value = t[k] ?? '';
  pendingImage = t.image || null; showImgPreview();
  $('#boxFormTitle').textContent = editingBox ? `Box: ${t.name}` : 'New box';
}
function showImgPreview() {
  const pv = $('#boxImgPreview');
  pv.style.backgroundImage = pendingImage ? `url(${pendingImage})` : ''; pv.textContent = pendingImage ? '' : 'no image';
}
function boxEvents() {
  $('#boxTable').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return; const id = tr.dataset.id; const a = e.target.dataset.a;
    if (a === 'copy') { const s = app.types.get(id); const n = { ...s, id: 'bx_' + uid(), name: s.name + ' copy' }; app.project.boxTypes.push(n); editingBox = n.id; save(); refresh(); renderBoxTab(); return; }
    if (a === 'del') {
      const used = app.project.layers.some((L) => L.boxes.some((b) => b.typeId === id));
      if (used && !confirm('This box is used in the pallet. Delete it and remove those boxes?')) return;
      app.project.boxTypes = app.project.boxTypes.filter((t) => t.id !== id);
      for (const L of app.project.layers) L.boxes = L.boxes.filter((b) => b.typeId !== id);
      editingBox = null; app.commit('Box type deleted'); renderBoxTab(); return;
    }
    editingBox = id; renderBoxTab();
  });
  $('#boxNew').addEventListener('click', () => { editingBox = null; fillBoxForm(null); $$('#boxTable tr').forEach((r) => r.classList.remove('editing')); });
  $('#boxImgInput').addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    pendingImage = await downscale(file, 512); showImgPreview();
    const f = $('#boxForm'); if (!editingBox && (!f.elements.name.value || f.elements.name.value === 'New box')) f.elements.name.value = file.name.replace(/\.[^.]+$/, '');
    e.target.value = '';
  });
  $('#boxImgClear').addEventListener('click', () => { pendingImage = null; showImgPreview(); });
  $('#boxForm').addEventListener('submit', (e) => {
    e.preventDefault(); const f = e.target;
    const v = { name: f.elements.name.value.trim() || 'Box', L: parseFloat(f.elements.L.value), W: parseFloat(f.elements.W.value), H: parseFloat(f.elements.H.value),
      weight: parseFloat(f.elements.weight.value) || 0, color: f.elements.color.value, labelSide: f.elements.labelSide.value, imageMode: f.elements.imageMode.value, image: pendingImage };
    if (!(v.L > 0 && v.W > 0 && v.H > 0)) return toast('Dimensions must be > 0', true);
    if (editingBox && app.types.has(editingBox)) Object.assign(app.types.get(editingBox), v);
    else { const n = { id: 'bx_' + uid(), ...v }; app.project.boxTypes.push(n); editingBox = n.id; app.activeTypeId = n.id; }
    app.commit('Box saved'); renderBoxTab(); toast('Box saved');
  });
}
function downscale(file, max) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => {
      const im = new Image();
      im.onload = () => {
        const k = Math.min(1, max / Math.max(im.width, im.height));
        const c = document.createElement('canvas'); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        res(c.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85));
      };
      im.onerror = rej; im.src = fr.result;
    };
    fr.onerror = rej; fr.readAsDataURL(file);
  });
}
function fillSettingsUI() {
  const s = app.project.settings;
  $('#mLeft').value = s.margins.left; $('#mRight').value = s.margins.right; $('#mFront').value = s.margins.front; $('#mBack').value = s.margins.back;
  $('#marginLink').checked = s.marginLink !== false;
  $('#setSpacing').value = s.spacing; $('#setSlip').value = s.slip; $('#setGrid').value = s.grid; $('#setSnapPx').value = s.snapPx;
  const c = s.csv;
  $('#csvDelim').value = c.delim === '\t' ? '\\t' : c.delim; $('#csvDec').value = c.decimals; $('#csvOrigin').value = c.origin; $('#csvZZero').value = c.zZero;
  $('#csvZRef').value = c.zRef; $('#csvRotRange').value = c.rotRange; $('#csvOrder').value = c.order; $('#csvHeader').checked = c.header; $('#csvDims').checked = c.dims;
}
function settingsEvents() {
  const s = () => app.project.settings;
  const mIds = { mLeft: 'left', mRight: 'right', mFront: 'front', mBack: 'back' };
  for (const [id, k] of Object.entries(mIds)) $('#' + id).addEventListener('input', (e) => {
    const v = parseFloat(e.target.value); if (isNaN(v)) return;
    if ($('#marginLink').checked) { for (const [i2, k2] of Object.entries(mIds)) { s().margins[k2] = v; if (i2 !== id) $('#' + i2).value = v; } }
    else s().margins[k] = v;
    save(); refresh();
  });
  $('#marginLink').addEventListener('change', (e) => { s().marginLink = e.target.checked; save(); });
  for (const [id, k] of [['setSpacing', 'spacing'], ['setSlip', 'slip'], ['setGrid', 'grid'], ['setSnapPx', 'snapPx']])
    $('#' + id).addEventListener('input', (e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0) { s()[k] = v; save(); refresh(); } });
  const csvMap = { csvDelim: 'delim', csvDec: 'decimals', csvOrigin: 'origin', csvZZero: 'zZero', csvZRef: 'zRef', csvRotRange: 'rotRange', csvOrder: 'order', csvHeader: 'header', csvDims: 'dims' };
  for (const [id, k] of Object.entries(csvMap)) $('#' + id).addEventListener('change', (e) => {
    const el = e.target; let v = el.type === 'checkbox' ? el.checked : el.value;
    if (k === 'decimals') v = Math.max(0, Math.min(4, parseInt(v) || 0));
    if (k === 'delim' && v === '\\t') v = '\t';
    s().csv[k] = v; save(); $('#csvPreview').textContent = previewCsv(); app.editor.draw();
  });
}
function previewCsv() { const t = buildCsv(app.project, app.pallet(), app.types).split('\r\n'); return t.slice(0, 40).join('\n') + (t.length > 41 ? `\n… (${t.length - 2} rows)` : ''); }

// ------------------------------------------------------------------ ctrlX connection & files
function fileBase() { return ($('#projectName').value || 'pattern').trim().replace(/[^\w\-. ]+/g, '_').replace(/\s+/g, '_') || 'pattern'; }
async function checkConnection() {
  await api.status();
  const b = $('#connBadge');
  b.textContent = api.online ? (api.info && api.info.needsLogin ? 'ctrlX · login' : 'ctrlX') : 'offline';
  b.classList.toggle('on', api.online);
  b.title = api.online ? 'Connected to the Palletizer service on ctrlX' : 'No ctrlX backend – Save downloads files instead';
  $('#btnSave').textContent = api.online ? 'Save to ctrlX' : 'Save (download)';
}
async function withAuth(fn) {
  try { return await fn(); }
  catch (e) {
    if (!e.auth) throw e;
    const ok = await askLogin(); if (!ok) throw new Error('Login cancelled');
    return fn();
  }
}
function askLogin() {
  return new Promise((resolve) => {
    const d = $('#dlgLogin'); $('#loginErr').textContent = ''; d.showModal();
    const f = $('#loginForm');
    const done = (v) => { f.onsubmit = null; $('#loginCancel').onclick = null; d.close(); resolve(v); };
    $('#loginCancel').onclick = () => done(false);
    f.onsubmit = async (e) => {
      e.preventDefault();
      try { await api.login(f.elements.user.value, f.elements.password.value); f.elements.password.value = ''; await checkConnection(); done(true); }
      catch (err) { $('#loginErr').textContent = err.message; }
    };
  });
}
function download(name, text, type) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
async function saveAll() {
  app.project.name = fileBase();
  const csv = buildCsv(app.project, app.pallet(), app.types);
  const proj = JSON.stringify({ ...app.project, savedAt: new Date().toISOString() }, null, 1);
  if (!api.online) {
    download(fileBase() + '.csv', csv, 'text/csv'); download(fileBase() + '.pallet.json', proj, 'application/json');
    toast('Downloaded CSV + project (no ctrlX backend)'); return;
  }
  try {
    await withAuth(() => api.write(fileBase() + '.csv', csv, 'text/csv'));
    await withAuth(() => api.write(fileBase() + '.pallet.json', proj, 'application/json'));
    toast(`Saved ${fileBase()}.csv to ctrlX`); status(`Saved to ${api.info?.storage || 'ctrlX'}`);
  } catch (e) { toast(e.message, true); }
}
async function renderCtrlxTab() {
  const el = $('#ctrlxInfo');
  if (!api.online) {
    el.innerHTML = `<p>Not connected to the Palletizer service. When the app runs on a ctrlX CORE the files are written to
      <code>/var/snap/rexroth-solutions/common/solutions/activeConfiguration/palletizer/</code>
      and appear under <b>Settings → Manage app data</b>. In this browser preview, “Save” downloads the CSV and project files instead.</p>`;
    $('#fileList').innerHTML = ''; return;
  }
  const i = api.info || {};
  el.innerHTML = `<p>Service: <b>${esc(i.app || 'palletizer')}</b> ${esc(i.version || '')}<br>Storage: <code>${esc(i.storage || '?')}</code><br>
    Active configuration: ${i.solutionConnected ? '<span style="color:var(--ok)">connected</span>' : '<span style="color:var(--warn)">not connected – using app data folder</span>'}<br>
    Login: ${api.token ? 'token present' : 'none (you will be asked on first save)'}</p>`;
  await renderFileList($('#fileList'), false);
}
async function renderFileList(el, forOpen) {
  if (!api.online) { el.innerHTML = '<p class="hint">Offline – use “From computer…”.</p>'; return; }
  el.innerHTML = '<p class="hint">Loading…</p>';
  try {
    const files = await withAuth(() => api.list());
    const show = files.filter((f) => /\.(csv|json)$/i.test(f.name));
    if (!show.length) { el.innerHTML = '<p class="hint">No files yet.</p>'; return; }
    el.innerHTML = show.map((f) => `<div class="file-row" data-n="${esc(f.name)}"><span>${esc(f.name)}<br><small>${new Date(f.mtime * 1000).toLocaleString()} · ${fmt(f.size / 1024)} kB</small></span>
      <button type="button" class="mini primary" data-a="open">Open</button>${forOpen ? '<span></span>' : '<button type="button" class="mini danger" data-a="del">✕</button>'}</div>`).join('');
    el.onclick = async (e) => {
      const row = e.target.closest('.file-row'); const a = e.target.dataset.a; if (!row || !a) return;
      const n = row.dataset.n;
      try {
        if (a === 'open') { const txt = await withAuth(() => api.read(n)); importText(n, txt); $('#dlgOpen').close(); closeDrawer(); }
        if (a === 'del' && confirm('Delete ' + n + ' from ctrlX?')) { await withAuth(() => api.remove(n)); renderFileList(el, forOpen); }
      } catch (err) { toast(err.message, true); }
    };
  } catch (e) { el.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
function importText(name, text) {
  const base = name.replace(/(\.pallet)?\.(json|csv)$/i, '');
  if (/\.json$/i.test(name)) {
    const p = JSON.parse(text); if (!p.layers) throw new Error('Not a palletizer project');
    p.name = base; loadProject(p); save(); refresh(); app.editor.fit(); app.view3d && app.view3d.resetView();
    toast(`Opened ${name}`); return;
  }
  const parsed = parseCsv(text);
  const fallback = app.types.get(app.activeTypeId) || app.project.boxTypes[0];
  const r = csvToProject(parsed, app.project, app.palletLib(), fallback);
  if (r.newPallet) app.project.customPallets.push(r.newPallet);
  app.project.palletId = r.pallet.id;
  app.project.boxTypes.push(...r.newTypes);
  app.project.layers = r.layers; app.layerIndex = 0; app.selection.clear();
  app.project.name = base; $('#projectName').value = base;
  app.commit(`Imported ${r.count} boxes`);
  app.editor.fit(); app.view3d && app.view3d.resetView();
  toast(`CSV loaded: ${r.layers.length} layers, ${r.count} boxes${r.newTypes.length ? `, ${r.newTypes.length} new box types` : ''}${r.newPallet ? ', custom pallet created' : ''}`);
}

// ------------------------------------------------------------------ auto arrange dialog
function openArrange() {
  const d = $('#dlgArrange');
  $('#arBox').innerHTML = app.project.boxTypes.map((t) => `<option value="${t.id}" ${t.id === app.activeTypeId ? 'selected' : ''}>${esc(t.name)} (${t.L}×${t.W}×${t.H})</option>`).join('');
  d.returnValue = ''; updateArrangePreview(); d.showModal();
}
function stackCount(t) {
  const p = app.pallet(), slip = app.project.settings.slip || 0, n = parseInt($('#arLayers').value) || 0;
  if (n > 0) return n;
  return Math.max(1, Math.floor(((p.maxH || 1800) + slip) / (t.H + slip)));
}
function updateArrangePreview() {
  const t = app.types.get($('#arBox').value); if (!t) return;
  const p = app.pallet();
  const pat = bestPattern(t, p, app.project.settings, { center: true });
  const pct = (100 * pat.length * t.L * t.W) / (p.L * p.W);
  const n = stackCount(t);
  const tgt = $('#arTarget').value;
  $('#arPreview').innerHTML = `Best pattern: <b>${pat.length}</b> boxes per layer (${fmt(pct)} % of pallet area).` +
    (tgt === 'stack' ? ` Stack: <b>${n}</b> layers → ${pat.length * n} boxes, load height ${fmt(n * t.H + (n - 1) * (app.project.settings.slip || 0))} mm.` : '');
}
function doArrange() {
  const t = app.types.get($('#arBox').value); if (!t) return;
  const P = app.project, p = app.pallet(), st = P.settings;
  const mode = $('#arMode').value, tgt = $('#arTarget').value, alt = $('#arAlt').value, center = $('#arCenter').checked, labels = $('#arLabels').checked;
  const base = mode === 'best' ? bestPattern(t, p, st, { center }) : null;
  const make = (layer, k) => {
    if (mode === 'best') return (k % 2 === 1 && alt !== 'none') ? transformLayer(base, p, alt) : base.map((b) => ({ ...b, id: uid() }));
    let add = fillFree(t, layer, app.types, p, st);
    if (center && !layer.boxes.length) add = centerBoxes(add, app.types, usableRect(p, st.margins));
    return [...layer.boxes, ...add];
  };
  let targets;
  if (tgt === 'current') targets = [app.layerIndex];
  else if (tgt === 'all') targets = P.layers.map((_, i) => i);
  else { const n = stackCount(t); P.layers = Array.from({ length: n }, () => ({ id: uid(), boxes: [] })); targets = P.layers.map((_, i) => i); app.layerIndex = 0; }
  let total = 0;
  for (const i of targets) {
    P.layers[i].boxes = make(P.layers[i], i);
    if (labels) orientLabels(P.layers[i], app.types, p, st);
    total += P.layers[i].boxes.length;
  }
  app.activeTypeId = t.id; app.selection.clear();
  app.commit(`Auto arrange: ${total} boxes`);
  toast(`Arranged ${total} boxes in ${targets.length} layer(s)`);
}

// ------------------------------------------------------------------ keyboard
function keyboard() {
  window.addEventListener('keydown', (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (/INPUT|SELECT|TEXTAREA/.test(tag) || document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); undoRedo(e.shiftKey ? 1 : -1); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); undoRedo(1); return; }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); app.select(app.layer().boxes.map((b) => b.id)); return; }
    if (mod && e.key.toLowerCase() === 'c') { if (app.selection.size) { app.clipboardBoxes = JSON.parse(JSON.stringify(selectedBoxes())); toast(`${app.clipboardBoxes.length} box(es) copied`); } return; }
    if (mod && e.key.toLowerCase() === 'v') {
      if (!app.clipboardBoxes) return;
      const add = app.clipboardBoxes.map((b) => ({ ...b, id: uid() }));
      const same = app.layer().boxes.some((o) => add.some((a) => Math.abs(a.x - o.x) < 1 && Math.abs(a.y - o.y) < 1));
      if (same) for (const a of add) { a.x += 50; a.y += 50; }
      app.layer().boxes.push(...add); app.selection = new Set(add.map((b) => b.id)); app.commit('Pasted'); return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
    if (e.key === 'Escape') { hideContext(); app.select([]); return; }
    if (e.key.toLowerCase() === 'r' && !mod) { rotateSelection(e.shiftKey ? -90 : 90); return; }
    if (e.key === 'PageUp') { app.layerIndex = Math.min(app.project.layers.length - 1, app.layerIndex + 1); app.selection.clear(); refresh(); return; }
    if (e.key === 'PageDown') { app.layerIndex = Math.max(0, app.layerIndex - 1); app.selection.clear(); refresh(); return; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (arrows[e.key] && app.selection.size) {
      e.preventDefault(); const k = e.shiftKey ? 10 : 1;
      for (const b of selectedBoxes()) { b.x += arrows[e.key][0] * k; b.y += arrows[e.key][1] * k; }
      app.commit('Nudge');
    }
  });
}

// ------------------------------------------------------------------ wiring
function wire() {
  $('#btnMenu').addEventListener('click', () => openDrawer());
  $('#btnDrawerClose').addEventListener('click', closeDrawer);
  $('#drawerScrim').addEventListener('click', closeDrawer);
  $$('.drawer-tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#btnNewBox').addEventListener('click', () => { editingBox = null; openDrawer('boxes'); fillBoxForm(null); });
  $('#palletSelect').addEventListener('change', (e) => { app.project.palletId = e.target.value; app.commit('Pallet changed'); app.editor.fit(); app.view3d && app.view3d.resetView(); });
  $('#projectName').addEventListener('change', (e) => { app.project.name = fileBase(); e.target.value = app.project.name; save(); });
  $('#btnUndo').addEventListener('click', () => undoRedo(-1));
  $('#btnRedo').addEventListener('click', () => undoRedo(1));
  $('#btnArrange').addEventListener('click', openArrange);
  $('#btnOrient').addEventListener('click', () => labelsOut(false));
  $('#btnDownload').addEventListener('click', () => { download(fileBase() + '.csv', buildCsv(app.project, app.pallet(), app.types), 'text/csv'); toast('CSV downloaded'); });
  $('#btnSave').addEventListener('click', saveAll);
  $('#btnOpen').addEventListener('click', () => { $('#dlgOpen').showModal(); renderFileList($('#openList'), true); });
  $('#openFileInput').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return; e.target.value = '';
    try { importText(f.name, await f.text()); $('#dlgOpen').close(); } catch (err) { toast(err.message, true); }
  });
  $('#openFileInput').setAttribute('accept', '.json,.csv,.txt');
  $('#btnRefreshFiles').addEventListener('click', renderCtrlxTab);
  $('#btnLogout').addEventListener('click', () => { api.logout(); toast('Login forgotten'); renderCtrlxTab(); });

  const L = { btnLayerAdd: 'add', btnLayerDup: 'dup', btnLayerCopy: 'copy', btnLayerPaste: 'paste', btnLayerDel: 'del', btnLayerUp: 'up', btnLayerDown: 'down', btnLayerMirX: 'mirX', btnLayerMirY: 'mirY', btnLayerRot: 'rot', btnCenterLayer: 'center', btnClearLayer: 'clear' };
  for (const [id, op] of Object.entries(L)) $('#' + id).addEventListener('click', (e) => layerOp(op, e));

  $$('.view-tabs .seg button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#optGhost').addEventListener('change', (e) => { app.ghostOn = e.target.checked; app.editor.draw(); });
  $('#optSnap').addEventListener('change', (e) => { app.snapOn = e.target.checked; });
  $('#btnFit').addEventListener('click', () => app.editor.fit());
  $('#opt3dFocus').addEventListener('change', (e) => { app.focusLayer = e.target.checked; schedule3d(); });
  $('#opt3dUpTo').addEventListener('change', (e) => { app.upToLayer = e.target.checked; schedule3d(); });
  $('#btn3dReset').addEventListener('click', () => app.view3d && app.view3d.resetView());
  $$('#sideAxis button').forEach((b) => b.addEventListener('click', () => { sideAxis = b.dataset.axis; $$('#sideAxis button').forEach((x) => x.classList.toggle('active', x === b)); renderSide(); }));
  new ResizeObserver(() => renderSide()).observe($('#sideCanvas'));

  // block-invalid toggle lives in the 2D toolbar
  const blk = document.createElement('label'); blk.className = 'chk'; blk.title = 'Reject drops in prohibited areas (overlap, outside pallet, inside margin)';
  blk.innerHTML = '<input type="checkbox" id="optBlock" checked> Block invalid drops';
  $('.tools2d').insertBefore(blk, $('#btnCenterLayer'));
  $('#optBlock').addEventListener('change', (e) => { app.blockInvalid = e.target.checked; });

  for (const id of ['arBox', 'arTarget', 'arLayers', 'arMode']) $('#' + id).addEventListener('input', updateArrangePreview);
  $('#dlgArrange').addEventListener('close', () => { if ($('#dlgArrange').returnValue === 'ok') doArrange(); });

  selPanelEvents(); ctxEvents(); palletEvents(); boxEvents(); settingsEvents(); keyboard();
}

// ------------------------------------------------------------------ boot
async function boot() {
  api.init();
  let p = null;
  try { p = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { p = null; }
  loadProject(p || defaultProject());
  app.editor = new Editor2D($('#canvas2d'), app);
  wire();
  setView('2d');
  refresh();
  checkConnection().then(() => { if (curTab() === 'ctrlx') renderCtrlxTab(); });
  status('Ready – drag boxes from the left onto the pallet');
}
boot();
