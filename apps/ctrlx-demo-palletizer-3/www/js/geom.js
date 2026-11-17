// Geometry helpers. Pallet coordinates in mm: X along pallet length, Y along width,
// origin at the front-left corner of the pallet top, Z up from the pallet top.
// A placed box: { id, typeId, x, y, rot }  (x,y = centre, rot = degrees CCW about Z)

export const EPS = 0.01;

export const normRot = (r) => ((Math.round(r * 1000) / 1000) % 360 + 360) % 360;
export const isAxisRot = (r) => Math.abs(normRot(r) % 90) < 1e-6 || Math.abs((normRot(r) % 90) - 90) < 1e-6;

export function halfExtents(type, rot) {
  const a = (normRot(rot) * Math.PI) / 180;
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  return { hx: (c * type.L + s * type.W) / 2, hy: (s * type.L + c * type.W) / 2 };
}

export function aabb(box, type) {
  const { hx, hy } = halfExtents(type, box.rot);
  return { x0: box.x - hx, x1: box.x + hx, y0: box.y - hy, y1: box.y + hy };
}

export function corners(box, type) {
  const a = (box.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const l = type.L / 2, w = type.W / 2;
  return [[-l, -w], [l, -w], [l, w], [-l, w]].map(([px, py]) => [box.x + px * c - py * s, box.y + px * s + py * c]);
}

function projRange(pts, ax) {
  let mn = Infinity, mx = -Infinity;
  for (const p of pts) { const d = p[0] * ax[0] + p[1] * ax[1]; if (d < mn) mn = d; if (d > mx) mx = d; }
  return [mn, mx];
}

// Separation gap between two (possibly rotated) boxes. Negative = overlap depth.
export function gapBetween(a, ta, b, tb) {
  if (isAxisRot(a.rot) && isAxisRot(b.rot)) {
    const A = aabb(a, ta), B = aabb(b, tb);
    const gx = Math.max(B.x0 - A.x1, A.x0 - B.x1);
    const gy = Math.max(B.y0 - A.y1, A.y0 - B.y1);
    return Math.max(gx, gy);
  }
  const ca = corners(a, ta), cb = corners(b, tb);
  const axes = [];
  for (const r of [a.rot, b.rot]) {
    const t = (r * Math.PI) / 180;
    axes.push([Math.cos(t), Math.sin(t)], [-Math.sin(t), Math.cos(t)]);
  }
  let best = -Infinity;
  for (const ax of axes) {
    const [a0, a1] = projRange(ca, ax), [b0, b1] = projRange(cb, ax);
    best = Math.max(best, Math.max(b0 - a1, a0 - b1));
  }
  return best;
}

// Usable rectangle after margins
export function usableRect(pallet, m) {
  return { x0: m.left, x1: pallet.L - m.right, y0: m.front, y1: pallet.W - m.back };
}

// Evaluate one layer: returns Map id -> {state:'ok'|'warn'|'bad', reasons:[]}
export function evaluateLayer(layer, types, pallet, settings) {
  const res = new Map();
  const U = usableRect(pallet, settings.margins);
  const sp = settings.spacing || 0;
  const boxes = layer.boxes;
  for (const b of boxes) res.set(b.id, { state: 'ok', reasons: [] });
  const bump = (id, st, why) => {
    const r = res.get(id);
    if (st === 'bad' || (st === 'warn' && r.state === 'ok')) r.state = st;
    if (!r.reasons.includes(why)) r.reasons.push(why);
  };
  for (const b of boxes) {
    const t = types.get(b.typeId); if (!t) continue;
    const cs = corners(b, t);
    let outPallet = false, outMargin = false;
    for (const [x, y] of cs) {
      if (x < -EPS - Math.max(0, -settings.margins.left) || x > pallet.L + EPS + Math.max(0, -settings.margins.right) ||
          y < -EPS - Math.max(0, -settings.margins.front) || y > pallet.W + EPS + Math.max(0, -settings.margins.back)) outPallet = true;
      if (x < U.x0 - EPS || x > U.x1 + EPS || y < U.y0 - EPS || y > U.y1 + EPS) outMargin = true;
    }
    if (outPallet) bump(b.id, 'bad', 'outside pallet');
    else if (outMargin) bump(b.id, 'warn', 'inside margin');
  }
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i], ta = types.get(a.typeId); if (!ta) continue;
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j], tb = types.get(b.typeId); if (!tb) continue;
      const g = gapBetween(a, ta, b, tb);
      if (g < -0.5) { bump(a.id, 'bad', 'overlap'); bump(b.id, 'bad', 'overlap'); }
      else if (g < sp - 0.5) { bump(a.id, 'warn', 'spacing'); bump(b.id, 'warn', 'spacing'); }
    }
  }
  return res;
}

// ---------- Labels ----------
const LOCAL_NORMALS = { front: [0, -1], back: [0, 1], right: [1, 0], left: [-1, 0] };

// Returns world direction of the label: '+X','-X','+Y','-Y' or null
export function labelDir(box, type) {
  const n = LOCAL_NORMALS[type.labelSide];
  if (!n) return null;
  const a = (box.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const wx = n[0] * c - n[1] * s, wy = n[0] * s + n[1] * c;
  if (Math.abs(wx) >= Math.abs(wy)) return wx > 0 ? '+X' : '-X';
  return wy > 0 ? '+Y' : '-Y';
}

// Sides of a box that are visible from outside the load (nothing between it and the pallet edge)
export function exposedSides(box, type, layer, types, pallet) {
  const A = aabb(box, type);
  const others = layer.boxes.filter((o) => o.id !== box.id).map((o) => aabb(o, types.get(o.typeId)));
  const inset = 1;
  const free = (sx0, sx1, sy0, sy1) => !others.some((B) => B.x0 < sx1 - EPS && B.x1 > sx0 + EPS && B.y0 < sy1 - EPS && B.y1 > sy0 + EPS);
  const out = [];
  const L = Math.max(pallet.L, A.x1) + 1, W = Math.max(pallet.W, A.y1) + 1;
  if (free(A.x1, L, A.y0 + inset, A.y1 - inset)) out.push('+X');
  if (free(Math.min(0, A.x0) - 1, A.x0, A.y0 + inset, A.y1 - inset)) out.push('-X');
  if (free(A.x0 + inset, A.x1 - inset, A.y1, W)) out.push('+Y');
  if (free(A.x0 + inset, A.x1 - inset, Math.min(0, A.y0) - 1, A.y0)) out.push('-Y');
  return out;
}

// Per layer: list of { id, status: 'out'|'in'|'interior'|'none' }
export function labelStatus(layer, types, pallet) {
  const m = new Map();
  for (const b of layer.boxes) {
    const t = types.get(b.typeId); if (!t) continue;
    const d = labelDir(b, t);
    if (!d) { m.set(b.id, 'none'); continue; }
    const ex = exposedSides(b, t, layer, types, pallet);
    if (!ex.length) m.set(b.id, 'interior');
    else m.set(b.id, ex.includes(d) ? 'out' : 'in');
  }
  return m;
}

// Rotate boxes so labels face outward when possible. Mutates layer. Returns {fixed, failed}
export function orientLabels(layer, types, pallet, settings) {
  let fixed = 0, failed = 0;
  const U = usableRect(pallet, settings.margins);
  const sp = settings.spacing || 0;
  for (let pass = 0; pass < 2; pass++) {
    for (const b of layer.boxes) {
      const t = types.get(b.typeId); if (!t) continue;
      const d = labelDir(b, t); if (!d) continue;
      const ex = exposedSides(b, t, layer, types, pallet);
      if (!ex.length || ex.includes(d)) continue;
      const orig = b.rot;
      let ok = false;
      for (const delta of [180, 90, -90]) {
        b.rot = normRot(orig + delta);
        if (delta !== 180) {
          const A = aabb(b, t);
          const fitsU = A.x0 >= U.x0 - EPS && A.x1 <= U.x1 + EPS && A.y0 >= U.y0 - EPS && A.y1 <= U.y1 + EPS;
          const clash = layer.boxes.some((o) => o.id !== b.id && gapBetween(b, t, o, types.get(o.typeId)) < sp - 0.5);
          if (!fitsU || clash) continue;
        }
        const ex2 = exposedSides(b, t, layer, types, pallet);
        if (ex2.includes(labelDir(b, t))) { ok = true; break; }
      }
      if (ok) { if (pass === 0) fixed++; } else { b.rot = orig; if (pass === 1) failed++; }
    }
  }
  return { fixed, failed };
}

export function layerHeight(layer, types) {
  let h = 0;
  for (const b of layer.boxes) { const t = types.get(b.typeId); if (t && t.H > h) h = t.H; }
  return h;
}

// Z base for each layer (bottom of layer, from pallet top)
export function layerBases(layers, types, slip) {
  const out = []; let z = 0;
  layers.forEach((l, i) => {
    if (i > 0 && slip) z += slip;
    out.push(z);
    z += layerHeight(l, types);
  });
  return { bases: out, top: z };
}

export function uid() { return Math.random().toString(36).slice(2, 10); }
