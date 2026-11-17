// 2D top-view layer editor (canvas). Y axis points up (towards the back of the pallet).
import { aabb, corners, gapBetween, usableRect, isAxisRot, normRot, labelDir, uid, EPS } from './geom.js';

const COL = {
  bg: '#0e1318', grid: '#1a222b', wood: '#a07c4f', woodDark: '#4a3824', woodEdge: '#2b2014',
  margin: '#2fb4c8', ghost: 'rgba(170,185,200,.35)', ok: '#3fb67a', warn: '#e8a33c', bad: '#e5484d',
  snap: '#22d3ee', sel: '#ffffff', dim: '#9fb0c0', dimLoad: '#2fb4c8', text: '#0b0f13',
};

export class Editor2D {
  constructor(canvas, app) {
    this.c = canvas; this.g = canvas.getContext('2d'); this.app = app;
    this.scale = 0.5; this.ox = 50; this.oy = 400; this.dpr = 1;
    this.drag = null; this.preview = null; this.guides = []; this.band = null; this.space = false;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.bind();
  }

  resize() {
    const r = this.c.getBoundingClientRect(); if (!r.width) return;
    this.dpr = window.devicePixelRatio || 1;
    this.c.width = Math.round(r.width * this.dpr); this.c.height = Math.round(r.height * this.dpr);
    this.w = r.width; this.h = r.height;
    if (!this.fitted) { this.fit(); this.fitted = true; } else this.draw();
  }

  fit() {
    const p = this.app.pallet(); if (!this.w) return;
    const pad = 70;
    this.scale = Math.min((this.w - pad * 2) / p.L, (this.h - pad * 2) / p.W);
    this.ox = (this.w - p.L * this.scale) / 2; this.oy = (this.h + p.W * this.scale) / 2;
    this.draw();
  }

  toScreen(x, y) { return [this.ox + x * this.scale, this.oy - y * this.scale]; }
  toWorld(sx, sy) { return [(sx - this.ox) / this.scale, (this.oy - sy) / this.scale]; }
  evtWorld(e) { const r = this.c.getBoundingClientRect(); return this.toWorld(e.clientX - r.left, e.clientY - r.top); }

  layer() { return this.app.project.layers[this.app.layerIndex]; }

  hit(x, y) {
    const L = this.layer(); const types = this.app.types;
    for (let i = L.boxes.length - 1; i >= 0; i--) {
      const b = L.boxes[i], t = types.get(b.typeId); if (!t) continue;
      const a = (-b.rot * Math.PI) / 180, dx = x - b.x, dy = y - b.y;
      const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(lx) <= t.L / 2 && Math.abs(ly) <= t.W / 2) return b;
    }
    return null;
  }

  // ---------- snapping & validation ----------
  snapPosition(box, type, x, y, others) {
    const app = this.app, p = app.pallet(), st = app.project.settings;
    const U = usableRect(p, st.margins), sp = st.spacing || 0;
    const guides = [];
    let snappedX = false, snappedY = false;
    if (app.snapOn && isAxisRot(box.rot)) {
      const tmp = { ...box, x, y }; const A = aabb(tmp, type);
      const hx = (A.x1 - A.x0) / 2, hy = (A.y1 - A.y0) / 2;
      const thr = (st.snapPx || 10) / this.scale;
      const cx = [[U.x0 + hx, U.x0], [U.x1 - hx, U.x1], [p.L / 2, p.L / 2]];
      const cy = [[U.y0 + hy, U.y0], [U.y1 - hy, U.y1], [p.W / 2, p.W / 2]];
      for (const o of others) {
        const B = aabb(o, app.types.get(o.typeId));
        const nearY = B.y0 < A.y1 + thr * 4 && B.y1 > A.y0 - thr * 4;
        const nearX = B.x0 < A.x1 + thr * 4 && B.x1 > A.x0 - thr * 4;
        if (nearY) { cx.push([B.x1 + sp + hx, B.x1 + sp / 2], [B.x0 - sp - hx, B.x0 - sp / 2]); }
        cx.push([B.x0 + hx, B.x0], [B.x1 - hx, B.x1]);
        if (nearX) { cy.push([B.y1 + sp + hy, B.y1 + sp / 2], [B.y0 - sp - hy, B.y0 - sp / 2]); }
        cy.push([B.y0 + hy, B.y0], [B.y1 - hy, B.y1]);
      }
      // align with the edges of the layer below (stacking)
      const li = app.layerIndex;
      if (li > 0) for (const o of app.project.layers[li - 1].boxes) {
        const B = aabb(o, app.types.get(o.typeId));
        cx.push([B.x0 + hx, B.x0], [B.x1 - hx, B.x1]);
        cy.push([B.y0 + hy, B.y0], [B.y1 - hy, B.y1]);
      }
      let bx = null, by = null;
      for (const c of cx) { const d = Math.abs(c[0] - x); if (d <= thr && (!bx || d < bx.d)) bx = { v: c[0], g: c[1], d }; }
      for (const c of cy) { const d = Math.abs(c[0] - y); if (d <= thr && (!by || d < by.d)) by = { v: c[0], g: c[1], d }; }
      if (bx) { x = bx.v; snappedX = true; guides.push({ axis: 'x', v: bx.g }); }
      if (by) { y = by.v; snappedY = true; guides.push({ axis: 'y', v: by.g }); }
      const g = st.grid || 0;
      if (!snappedX && g > 0) x = Math.round((x - hx) / g) * g + hx;
      if (!snappedY && g > 0) y = Math.round((y - hy) / g) * g + hy;
    }
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, snapped: snappedX || snappedY, guides };
  }

  // 'bad' = prohibited (overlap / outside pallet / inside margin), 'warn' = gap smaller than spacing, 'ok'
  placementState(box, type, others) {
    const app = this.app, p = app.pallet(), st = app.project.settings;
    const U = usableRect(p, st.margins), sp = st.spacing || 0;
    for (const [x, y] of corners(box, type)) if (x < U.x0 - EPS || x > U.x1 + EPS || y < U.y0 - EPS || y > U.y1 + EPS) return 'bad';
    let s = 'ok';
    for (const o of others) {
      const g = gapBetween(box, type, o, app.types.get(o.typeId));
      if (g < -0.5) return 'bad';
      if (g < sp - 0.5) s = 'warn';
    }
    return s;
  }

  // ---------- events ----------
  bind() {
    const c = this.c;
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const [x, y] = this.evtWorld(e); const b = this.hit(x, y);
      if (b) { if (!this.app.selection.has(b.id)) this.app.select([b.id]); this.app.showContext(e.clientX, e.clientY); }
    });
    c.addEventListener('dblclick', (e) => {
      const [x, y] = this.evtWorld(e); const b = this.hit(x, y);
      if (b) { this.app.select([b.id]); this.app.rotateSelection(90); }
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = c.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
      const [wx, wy] = this.toWorld(sx, sy);
      const f = Math.exp(-e.deltaY * 0.0015);
      this.scale = Math.min(20, Math.max(0.05, this.scale * f));
      this.ox = sx - wx * this.scale; this.oy = sy + wy * this.scale;
      this.draw();
    }, { passive: false });
    window.addEventListener('keydown', (e) => { if (e.code === 'Space' && document.activeElement === c) { this.space = true; e.preventDefault(); } });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this.space = false; });

    c.addEventListener('pointerdown', (e) => {
      c.focus(); this.app.hideContext();
      const [x, y] = this.evtWorld(e);
      if (e.button === 1 || (e.button === 0 && this.space)) { this.drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: this.ox, oy: this.oy }; c.setPointerCapture(e.pointerId); return; }
      if (e.button !== 0) return;
      const b = this.hit(x, y);
      if (b) {
        if (e.shiftKey || e.ctrlKey || e.metaKey) {
          const s = new Set(this.app.selection); s.has(b.id) ? s.delete(b.id) : s.add(b.id); this.app.select([...s]);
          return;
        }
        if (!this.app.selection.has(b.id)) this.app.select([b.id]);
        const L = this.layer();
        const sel = L.boxes.filter((o) => this.app.selection.has(o.id));
        this.drag = { mode: 'move', prim: b, gx: x - b.x, gy: y - b.y, start: sel.map((o) => ({ o, x: o.x, y: o.y })), moved: false, others: L.boxes.filter((o) => !this.app.selection.has(o.id)) };
        c.setPointerCapture(e.pointerId);
      } else {
        if (!e.shiftKey) this.app.select([]);
        this.band = { x0: x, y0: y, x1: x, y1: y, add: e.shiftKey ? new Set(this.app.selection) : new Set() };
        this.drag = { mode: 'band' };
        c.setPointerCapture(e.pointerId);
      }
    });

    c.addEventListener('pointermove', (e) => {
      const [x, y] = this.evtWorld(e);
      this.app.cursor(x, y);
      const d = this.drag; if (!d) return;
      if (d.mode === 'pan') { this.ox = d.ox + e.clientX - d.sx; this.oy = d.oy + e.clientY - d.sy; this.draw(); return; }
      if (d.mode === 'band') {
        Object.assign(this.band, { x1: x, y1: y });
        const bx0 = Math.min(this.band.x0, x), bx1 = Math.max(this.band.x0, x), by0 = Math.min(this.band.y0, y), by1 = Math.max(this.band.y0, y);
        const ids = new Set(this.band.add);
        for (const b of this.layer().boxes) { const A = aabb(b, this.app.types.get(b.typeId)); if (A.x0 < bx1 && A.x1 > bx0 && A.y0 < by1 && A.y1 > by0) ids.add(b.id); }
        this.app.select([...ids], true);
        return;
      }
      if (d.mode === 'move') {
        const t = this.app.types.get(d.prim.typeId);
        const ps = d.start.find((s) => s.o === d.prim);
        const snap = this.snapPosition(d.prim, t, x - d.gx, y - d.gy, d.others);
        const dx = snap.x - ps.x, dy = snap.y - ps.y;
        if (Math.abs(dx) + Math.abs(dy) > 0.01) d.moved = true;
        for (const s of d.start) { s.o.x = Math.round((s.x + dx) * 10) / 10; s.o.y = Math.round((s.y + dy) * 10) / 10; }
        let state = 'ok';
        for (const s of d.start) {
          const st = this.placementState(s.o, this.app.types.get(s.o.typeId), d.others);
          if (st === 'bad') { state = 'bad'; break; } if (st === 'warn') state = 'warn';
        }
        d.state = state; d.snapped = snap.snapped; this.guides = snap.guides;
        this.app.liveUpdate();
      }
    });

    const end = (e) => {
      const d = this.drag; this.drag = null; this.guides = [];
      if (!d) return;
      if (d.mode === 'band') { this.band = null; this.draw(); this.app.select([...this.app.selection]); return; }
      if (d.mode === 'move') {
        if (d.moved && d.state === 'bad' && this.app.blockInvalid) {
          for (const s of d.start) { s.o.x = s.x; s.o.y = s.y; }
          this.app.toast('Prohibited position – box returned', true);
          this.app.liveUpdate();
        } else if (d.moved) this.app.commit('Move');
        else this.draw();
      } else this.draw();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => this.app.cursor(null));

    // drag & drop from the palette
    c.addEventListener('dragover', (e) => {
      const typeId = this.app.dragTypeId; if (!typeId) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
      const t = this.app.types.get(typeId); const [x, y] = this.evtWorld(e);
      const others = this.layer().boxes;
      const pb = { id: '_p', typeId, x, y, rot: this.app.dropRot || 0 };
      const s = this.snapPosition(pb, t, x, y, others);
      pb.x = s.x; pb.y = s.y;
      this.preview = { box: pb, state: this.placementState(pb, t, others), snapped: s.snapped };
      this.guides = s.guides;
      this.app.cursor(x, y);
      this.draw();
    });
    c.addEventListener('dragleave', () => { this.preview = null; this.guides = []; this.draw(); });
    c.addEventListener('drop', (e) => {
      e.preventDefault();
      const pv = this.preview; this.preview = null; this.guides = [];
      if (!pv) return;
      if (pv.state === 'bad' && this.app.blockInvalid) { this.app.toast('Prohibited area – box not placed', true); this.draw(); return; }
      const nb = { ...pv.box, id: uid() };
      this.layer().boxes.push(nb);
      this.app.select([nb.id], true);
      this.app.commit('Add box');
    });
  }

  // ---------- drawing ----------
  draw() {
    const g = this.g, app = this.app; if (!this.w) return;
    const p = app.pallet(), st = app.project.settings, types = app.types;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = COL.bg; g.fillRect(0, 0, this.w, this.h);
    const s = this.scale;
    // grid (100 mm)
    g.strokeStyle = COL.grid; g.lineWidth = 1; g.beginPath();
    const [wx0, wy1] = this.toWorld(0, 0), [wx1, wy0] = this.toWorld(this.w, this.h);
    const step = s * 100 < 12 ? 500 : 100;
    for (let x = Math.floor(wx0 / step) * step; x <= wx1; x += step) { const [sx] = this.toScreen(x, 0); g.moveTo(sx + .5, 0); g.lineTo(sx + .5, this.h); }
    for (let y = Math.floor(wy0 / step) * step; y <= wy1; y += step) { const [, sy] = this.toScreen(0, y); g.moveTo(0, sy + .5); g.lineTo(this.w, sy + .5); }
    g.stroke();

    // pallet deck
    const [px0, py0] = this.toScreen(0, p.W);
    g.fillStyle = COL.woodDark; g.fillRect(px0, py0, p.L * s, p.W * s);
    const nb = p.W > 900 ? 7 : 5; const bw = p.W / (nb * 1.45);
    const gap = (p.W - nb * bw) / (nb - 1);
    for (let i = 0; i < nb; i++) {
      const y = i * (bw + gap); const [bx, by] = this.toScreen(0, y + bw);
      g.fillStyle = COL.wood; g.fillRect(bx, by, p.L * s, bw * s);
      g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(bx, by + bw * s - 2, p.L * s, 2);
    }
    g.strokeStyle = COL.woodEdge; g.lineWidth = 2; g.strokeRect(px0, py0, p.L * s, p.W * s);

    // margins (prohibited band) – tint red while dragging
    const U = usableRect(p, st.margins);
    const dragging = !!(this.drag && this.drag.mode === 'move') || !!this.preview;
    if (dragging) {
      g.fillStyle = 'rgba(229,72,77,.18)';
      g.beginPath();
      g.rect(px0, py0, p.L * s, p.W * s);
      const [ux, uy] = this.toScreen(U.x0, U.y1);
      g.rect(ux + (U.x1 - U.x0) * s, uy, -(U.x1 - U.x0) * s, (U.y1 - U.y0) * s);
      g.fill('evenodd');
    }
    {
      const [ux, uy] = this.toScreen(U.x0, U.y1);
      g.setLineDash([6, 4]); g.strokeStyle = COL.margin; g.lineWidth = 1.5;
      g.strokeRect(ux, uy, (U.x1 - U.x0) * s, (U.y1 - U.y0) * s); g.setLineDash([]);
    }

    // layer below (ghost)
    const li = app.layerIndex;
    if (app.ghostOn && li > 0) {
      g.setLineDash([4, 3]); g.strokeStyle = COL.ghost; g.lineWidth = 1.2;
      for (const b of app.project.layers[li - 1].boxes) { const t = types.get(b.typeId); if (t) this.pathBox(b, t), g.stroke(); }
      g.setLineDash([]);
    }

    // boxes
    const layer = this.layer(); const ev = app.evalMap; const lab = app.labelMap;
    const d = this.drag && this.drag.mode === 'move' ? this.drag : null;
    layer.boxes.forEach((b, i) => {
      const t = types.get(b.typeId); if (!t) return;
      let state = (ev.get(b.id) || {}).state || 'ok';
      let live = null;
      if (d && app.selection.has(b.id)) live = d.state === 'bad' ? 'bad' : d.state === 'warn' ? 'warn' : d.snapped ? 'snap' : 'drag';
      this.drawBox(b, t, i + 1, { state, live, selected: app.selection.has(b.id), label: lab.get(b.id) });
    });

    if (this.preview) {
      const { box, state, snapped } = this.preview;
      g.globalAlpha = 0.85;
      this.drawBox(box, types.get(box.typeId), '+', { state: 'ok', live: state === 'bad' ? 'bad' : state === 'warn' ? 'warn' : snapped ? 'snap' : 'drag', selected: false, label: null });
      g.globalAlpha = 1;
    }

    // snap guides
    if (this.guides.length) {
      g.strokeStyle = COL.snap; g.lineWidth = 1; g.setLineDash([3, 3]);
      for (const gd of this.guides) {
        g.beginPath();
        if (gd.axis === 'x') { const [sx] = this.toScreen(gd.v, 0); g.moveTo(sx, 0); g.lineTo(sx, this.h); }
        else { const [, sy] = this.toScreen(0, gd.v); g.moveTo(0, sy); g.lineTo(this.w, sy); }
        g.stroke();
      }
      g.setLineDash([]);
    }

    // rubber band
    if (this.band) {
      const [a, b2] = this.toScreen(this.band.x0, this.band.y0), [c, d2] = this.toScreen(this.band.x1, this.band.y1);
      g.fillStyle = 'rgba(47,180,200,.12)'; g.strokeStyle = COL.margin; g.lineWidth = 1;
      g.fillRect(Math.min(a, c), Math.min(b2, d2), Math.abs(c - a), Math.abs(d2 - b2));
      g.strokeRect(Math.min(a, c), Math.min(b2, d2), Math.abs(c - a), Math.abs(d2 - b2));
    }

    this.drawDims(p, layer);
    this.drawOrigin(p);
  }

  pathBox(b, t) {
    const g = this.g; const cs = corners(b, t).map(([x, y]) => this.toScreen(x, y));
    g.beginPath(); g.moveTo(cs[0][0], cs[0][1]); for (let i = 1; i < 4; i++) g.lineTo(cs[i][0], cs[i][1]); g.closePath();
  }

  drawBox(b, t, num, o) {
    const g = this.g, s = this.scale;
    const [cx, cy] = this.toScreen(b.x, b.y);
    g.save();
    g.translate(cx, cy); g.rotate((-b.rot * Math.PI) / 180);
    const w = t.L * s, h = t.W * s;
    // body
    const img = this.app.images.get(t.id);
    if (img && img.complete && img.naturalWidth && t.imageMode !== 'label') {
      g.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      g.fillStyle = t.color || '#c8a26b'; g.fillRect(-w / 2, -h / 2, w, h);
      // carton flap line
      g.strokeStyle = 'rgba(0,0,0,.18)'; g.lineWidth = 1; g.beginPath(); g.moveTo(-w / 2 + 3, 0); g.lineTo(w / 2 - 3, 0); g.stroke();
    }
    // state tint
    const st = o.live || o.state;
    const tint = { bad: 'rgba(229,72,77,.55)', warn: 'rgba(232,163,60,.45)', snap: 'rgba(34,211,238,.38)', drag: 'rgba(255,255,255,.12)' }[st];
    if (tint) { g.fillStyle = tint; g.fillRect(-w / 2, -h / 2, w, h); }

    // label mark
    this.drawLabel(t, w, h, o.label);

    // outline
    g.lineWidth = o.selected ? 2.5 : 1.2;
    g.strokeStyle = st === 'bad' ? COL.bad : st === 'warn' ? COL.warn : st === 'snap' ? COL.snap : o.selected ? COL.sel : 'rgba(0,0,0,.65)';
    g.strokeRect(-w / 2, -h / 2, w, h);
    if (o.selected) { g.setLineDash([4, 3]); g.strokeStyle = '#ffffff'; g.lineWidth = 1; g.strokeRect(-w / 2 - 4, -h / 2 - 4, w + 8, h + 8); g.setLineDash([]); }
    // number (kept upright)
    g.rotate((b.rot * Math.PI) / 180);
    const fs = Math.max(9, Math.min(16, Math.min(w, h) * 0.22));
    g.font = `600 ${fs}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(255,255,255,.85)'; g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 3;
    g.strokeText(String(num), 0, 0); g.fillText(String(num), 0, 0);
    g.restore();
  }

  // White label patch with barcode and an outward arrow on the label face
  drawLabel(t, w, h, status) {
    if (!t.labelSide || t.labelSide === 'none') return;
    const g = this.g;
    g.save();
    // rotate so the label face is the local "front" (canvas +y = world -Y)
    let fw = w, fd = h; // face width and box depth perpendicular to face
    if (t.labelSide === 'back') g.rotate(Math.PI);
    if (t.labelSide === 'right') { g.rotate(-Math.PI / 2); fw = h; fd = w; }
    if (t.labelSide === 'left') { g.rotate(Math.PI / 2); fw = h; fd = w; }
    const lw = fw * 0.56, ld = Math.min(fd * 0.26, Math.max(10, fd * 0.2));
    const y1 = fd / 2 - 2, y0 = y1 - ld;
    const col = status === 'in' ? COL.bad : status === 'out' ? COL.ok : '#6b7a89';
    g.fillStyle = '#ffffff'; g.fillRect(-lw / 2, y0, lw, ld);
    // barcode
    g.fillStyle = '#111';
    const bx0 = -lw / 2 + lw * 0.08, bw = lw * 0.84, bh = ld * 0.52;
    let x = bx0; let k = 0;
    while (x < bx0 + bw) { const sw = (k % 3 === 0 ? 2 : 1) * Math.max(0.6, bw / 70); if (k % 2 === 0) g.fillRect(x, y0 + ld * 0.14, sw, bh); x += sw + Math.max(0.6, bw / 90) * ((k * 7) % 3 + 1); k++; }
    // coloured strip along the face edge + arrow pointing out
    g.fillStyle = col; g.fillRect(-lw / 2, y1 - Math.max(2, ld * 0.18), lw, Math.max(2, ld * 0.18));
    const ah = Math.min(ld * 0.5, 10);
    g.beginPath(); g.moveTo(-ah, y1 + 2); g.lineTo(ah, y1 + 2); g.lineTo(0, y1 + 2 + ah); g.closePath(); g.fill();
    g.strokeStyle = col; g.lineWidth = 1.5; g.strokeRect(-lw / 2, y0, lw, ld);
    g.restore();
  }

  drawDims(p, layer) {
    const g = this.g, s = this.scale;
    const line = (x0, y0, x1, y1, txt, col, off, vertical) => {
      const [a, b] = this.toScreen(x0, y0), [c, d] = this.toScreen(x1, y1);
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1;
      let A = [a, b], B = [c, d];
      if (vertical) { A = [a - off, b]; B = [c - off, d]; } else { A = [a, b + off]; B = [c, d + off]; }
      g.beginPath(); g.moveTo(...A); g.lineTo(...B); g.stroke();
      // ticks
      g.beginPath();
      if (vertical) { g.moveTo(A[0] - 4, A[1]); g.lineTo(A[0] + 4, A[1]); g.moveTo(B[0] - 4, B[1]); g.lineTo(B[0] + 4, B[1]); }
      else { g.moveTo(A[0], A[1] - 4); g.lineTo(A[0], A[1] + 4); g.moveTo(B[0], B[1] - 4); g.lineTo(B[0], B[1] + 4); }
      g.stroke();
      g.font = '11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
      g.save(); g.translate(mx, my); if (vertical) g.rotate(-Math.PI / 2);
      const tw = g.measureText(txt).width + 8;
      g.fillStyle = COL.bg; g.fillRect(-tw / 2, -8, tw, 16); g.fillStyle = col; g.fillText(txt, 0, 0); g.restore();
    };
    line(0, 0, p.L, 0, `${fmt(p.L)} mm`, COL.dim, 22, false);
    line(0, 0, 0, p.W, `${fmt(p.W)} mm`, COL.dim, 22, true);
    if (layer.boxes.length) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const b of layer.boxes) { const A = aabb(b, this.app.types.get(b.typeId)); x0 = Math.min(x0, A.x0); x1 = Math.max(x1, A.x1); y0 = Math.min(y0, A.y0); y1 = Math.max(y1, A.y1); }
      line(x0, Math.max(p.W, y1), x1, Math.max(p.W, y1), `layer ${fmt(x1 - x0)}`, COL.dimLoad, -22, false);
      const [, sy] = this.toScreen(0, 0); void sy;
      const xr = Math.max(p.L, x1);
      line(xr, y0, xr, y1, `layer ${fmt(y1 - y0)}`, COL.dimLoad, -22, true);
    }
    void s;
  }

  drawOrigin(p) {
    const g = this.g; const o = this.app.project.settings.csv.origin === 'center' ? [p.L / 2, p.W / 2] : [0, 0];
    const [x, y] = this.toScreen(o[0], o[1]);
    g.lineWidth = 2;
    g.strokeStyle = '#ff5d5d'; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 34, y); g.stroke();
    g.strokeStyle = '#5dff8a'; g.beginPath(); g.moveTo(x, y); g.lineTo(x, y - 34); g.stroke();
    g.fillStyle = '#ff5d5d'; g.font = '600 11px system-ui'; g.textAlign = 'left'; g.fillText('X', x + 37, y + 4);
    g.fillStyle = '#5dff8a'; g.fillText('Y', x - 4, y - 40);
    g.fillStyle = '#fff'; g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill();
  }
}

const fmt = (v) => (Math.round(v * 10) / 10).toString();
export { normRot, labelDir };
