// Automatic arrangement of one box type on a rectangle (maximise box count / area).
// 1) Guillotine dynamic programming on raster points (exact for guillotine patterns)
// 2) Pinwheel / 5-block heuristic for non-guillotine patterns
// 3) MaxRects fill for free space around existing boxes
import { aabb, usableRect, uid } from './geom.js';

// raster points: all a*p + b*q <= X (combinations of the two footprint sides)
function rasterPoints(X, p, q) {
  const set = new Set([0]);
  for (let a = 0; a * p <= X + 1e-6; a++)
    for (let b = 0; a * p + b * q <= X + 1e-6; b++) set.add(Math.round((a * p + b * q) * 1000) / 1000);
  return [...set].sort((u, v) => u - v);
}

function floorIdx(arr, v) { // largest index with arr[i] <= v
  let lo = 0, hi = arr.length - 1, r = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m] <= v + 1e-6) { r = m; lo = m + 1; } else hi = m - 1; }
  return r;
}

// Rectangles in "inflated" space: every box takes (l+s) x (w+s), area is (X+s) x (Y+s)
function guillotine(X, Y, l, w) {
  const PX = rasterPoints(X, l, w), PY = rasterPoints(Y, l, w);
  if (PX.length * PY.length * (PX.length + PY.length) > 6e6) return null; // too fine, skip
  const nX = PX.length, nY = PY.length;
  const val = new Int32Array(nX * nY).fill(-1);
  const how = new Array(nX * nY);
  const solve = (i, j) => {
    const k = i * nY + j;
    if (val[k] >= 0) return val[k];
    const x = PX[i], y = PY[j];
    let best = 0, h = null;
    // homogeneous fills
    const a = Math.floor((x + 1e-6) / l) * Math.floor((y + 1e-6) / w);
    const b = Math.floor((x + 1e-6) / w) * Math.floor((y + 1e-6) / l);
    if (a >= best) { best = a; h = { t: 'fill', o: 0 }; }
    if (b > best) { best = b; h = { t: 'fill', o: 1 }; }
    const bound = Math.floor((x * y + 1e-6) / (l * w));
    if (best < bound) {
      for (let ii = 1; ii < nX && PX[ii] <= x / 2 + 1e-6; ii++) {
        const r = floorIdx(PX, x - PX[ii]);
        const v = solve(ii, j) + solve(r, j);
        if (v > best) { best = v; h = { t: 'v', a: ii, b: r }; if (best >= bound) break; }
      }
    }
    if (best < bound) {
      for (let jj = 1; jj < nY && PY[jj] <= y / 2 + 1e-6; jj++) {
        const r = floorIdx(PY, y - PY[jj]);
        const v = solve(i, jj) + solve(i, r);
        if (v > best) { best = v; h = { t: 'h', a: jj, b: r }; if (best >= bound) break; }
      }
    }
    val[k] = best; how[k] = h; return best;
  };
  const iX = nX - 1, iY = nY - 1;
  const count = solve(iX, iY);
  const out = [];
  const build = (i, j, ox, oy) => {
    const h = how[i * nY + j]; if (!h) return;
    const x = PX[i], y = PY[j];
    if (h.t === 'fill') {
      const [fx, fy] = h.o === 0 ? [l, w] : [w, l];
      const nx = Math.floor((x + 1e-6) / fx), ny = Math.floor((y + 1e-6) / fy);
      for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) out.push({ x: ox + a * fx, y: oy + b * fy, rotated: h.o === 1 });
    } else if (h.t === 'v') { build(h.a, j, ox, oy); build(h.b, j, ox + PX[h.a], oy); }
    else { build(i, h.a, ox, oy); build(i, h.b, ox, oy + PY[h.a]); }
  };
  build(iX, iY, 0, 0);
  return { count, cells: out };
}

// 5-block pinwheel: four homogeneous blocks in the corners + one centre block
function pinwheel(X, Y, l, w) {
  let best = { count: 0, cells: [] };
  const E = 1e-6;
  const maxA = Math.floor((X + E) / l), maxB = Math.floor((Y + E) / w), maxB2 = Math.floor((Y + E) / l);
  if (maxA * maxB * maxB2 * maxA > 3e6) return best;
  const fill = (ox, oy, nx, ny, fx, fy, rot, out) => { for (let a = 0; a < nx; a++) for (let b = 0; b < ny; b++) out.push({ x: ox + a * fx, y: oy + b * fy, rotated: rot }); };
  const ov = (A, B) => A[0] < B[2] - E && A[2] > B[0] + E && A[1] < B[3] - E && A[3] > B[1] + E;
  for (let a1 = 1; a1 <= maxA; a1++) for (let b1 = 1; b1 <= maxB; b1++) {
    const x1 = a1 * l, y1 = b1 * w;
    const a2 = Math.floor((X - x1 + E) / w); if (a2 < 1) continue;
    const x2 = X - a2 * w;
    for (let b2 = 1; b2 <= maxB2; b2++) {
      const y2 = b2 * l;
      const b3 = Math.floor((Y - y2 + E) / w); if (b3 < 1) continue;
      const y3 = Y - b3 * w;
      for (let a3 = 1; a3 <= maxA; a3++) {
        const x3 = X - a3 * l; if (x3 < -E) break;
        const a4 = Math.floor((x3 + E) / w), b4 = Math.floor((Y - y1 + E) / l);
        if (a4 < 1 || b4 < 1) continue;
        const x4 = a4 * w, y4 = Y - b4 * l;
        const R = [[0, 0, x1, y1], [x2, 0, X, y2], [x3, y3, X, Y], [0, y4, x4, Y]];
        let bad = false;
        for (let i = 0; i < 4 && !bad; i++) for (let j = i + 1; j < 4; j++) if (ov(R[i], R[j])) { bad = true; break; }
        if (bad) continue;
        let n = a1 * b1 + a2 * b2 + a3 * b3 + a4 * b4;
        // centre: the rectangle enclosed by the four blocks is always free
        const c = { x0: Math.max(x1, x4), x1: Math.min(x2, x3), y0: Math.max(y1, y2), y1: Math.min(y3, y4) };
        let cBest = 0, cRot = false;
        if (c.x1 > c.x0 && c.y1 > c.y0) {
          const cw = c.x1 - c.x0, ch = c.y1 - c.y0;
          const o1 = Math.floor((cw + E) / l) * Math.floor((ch + E) / w), o2 = Math.floor((cw + E) / w) * Math.floor((ch + E) / l);
          cBest = Math.max(o1, o2); cRot = o2 > o1;
        }
        n += cBest;
        if (n > best.count) {
          const cells = [];
          fill(0, 0, a1, b1, l, w, false, cells);
          fill(x2, 0, a2, b2, w, l, true, cells);
          fill(x3, y3, a3, b3, l, w, false, cells);
          fill(0, y4, a4, b4, w, l, true, cells);
          if (cBest) { const [fx, fy] = cRot ? [w, l] : [l, w]; fill(c.x0, c.y0, Math.floor((c.x1 - c.x0 + E) / fx), Math.floor((c.y1 - c.y0 + E) / fy), fx, fy, cRot, cells); }
          best = { count: n, cells };
        }
      }
    }
  }
  return best;
}

// Best pattern for one box type inside the usable area. Returns placements in pallet coords.
export function bestPattern(type, pallet, settings, { center = true } = {}) {
  const U = usableRect(pallet, settings.margins);
  const s = settings.spacing || 0;
  const X = U.x1 - U.x0 + s, Y = U.y1 - U.y0 + s;
  const l = type.L + s, w = type.W + s;
  if (X < Math.min(l, w) || Y < Math.min(l, w)) return [];
  const candidates = [];
  const g = guillotine(X, Y, l, w); if (g) candidates.push(g);
  // also try with swapped axes for pinwheel
  if (Math.max(X, Y) / Math.min(l, w) < 60) {
    const p = pinwheel(X, Y, l, w); if (p.count) candidates.push(p);
  }
  if (!candidates.length) { // simple grid fallback
    const a = Math.floor(X / l) * Math.floor(Y / w), b = Math.floor(X / w) * Math.floor(Y / l);
    const o = b > a, fx = o ? w : l, fy = o ? l : w, cells = [];
    for (let i = 0; i < Math.floor(X / fx); i++) for (let j = 0; j < Math.floor(Y / fy); j++) cells.push({ x: i * fx, y: j * fy, rotated: o });
    candidates.push({ count: cells.length, cells });
  }
  // validate (no overlaps) and pick max
  candidates.sort((a, b) => b.count - a.count);
  let pick = null;
  for (const c of candidates) { if (validCells(c.cells, l, w)) { pick = c; break; } }
  if (!pick) pick = candidates[candidates.length - 1];
  let boxes = pick.cells.map((c) => {
    const fx = c.rotated ? type.W : type.L, fy = c.rotated ? type.L : type.W;
    return { id: uid(), typeId: type.id, x: U.x0 + c.x + fx / 2, y: U.y0 + c.y + fy / 2, rot: c.rotated ? 90 : 0 };
  });
  if (center && boxes.length) boxes = centerBoxes(boxes, new Map([[type.id, type]]), U);
  return boxes;
}

function validCells(cells, l, w) {
  for (let i = 0; i < cells.length; i++) {
    const a = cells[i], ax1 = a.x + (a.rotated ? w : l), ay1 = a.y + (a.rotated ? l : w);
    for (let j = i + 1; j < cells.length; j++) {
      const b = cells[j], bx1 = b.x + (b.rotated ? w : l), by1 = b.y + (b.rotated ? l : w);
      if (a.x < bx1 - 1e-6 && ax1 > b.x + 1e-6 && a.y < by1 - 1e-6 && ay1 > b.y + 1e-6) return false;
    }
  }
  return true;
}

export function centerBoxes(boxes, types, U) {
  if (!boxes.length) return boxes;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const b of boxes) { const A = aabb(b, types.get(b.typeId)); x0 = Math.min(x0, A.x0); x1 = Math.max(x1, A.x1); y0 = Math.min(y0, A.y0); y1 = Math.max(y1, A.y1); }
  const dx = (U.x0 + U.x1) / 2 - (x0 + x1) / 2, dy = (U.y0 + U.y1) / 2 - (y0 + y1) / 2;
  return boxes.map((b) => ({ ...b, x: round1(b.x + dx), y: round1(b.y + dy) }));
}
const round1 = (v) => Math.round(v * 10) / 10;

// MaxRects free-space fill around existing boxes
export function fillFree(type, layer, types, pallet, settings, maxCount = Infinity) {
  const U = usableRect(pallet, settings.margins);
  const s = settings.spacing || 0;
  let free = [{ x0: U.x0, y0: U.y0, x1: U.x1 + s, y1: U.y1 + s }];
  const split = (R) => {
    const next = [];
    for (const F of free) {
      if (R.x0 >= F.x1 || R.x1 <= F.x0 || R.y0 >= F.y1 || R.y1 <= F.y0) { next.push(F); continue; }
      if (R.x0 > F.x0) next.push({ ...F, x1: R.x0 });
      if (R.x1 < F.x1) next.push({ ...F, x0: R.x1 });
      if (R.y0 > F.y0) next.push({ ...F, y1: R.y0 });
      if (R.y1 < F.y1) next.push({ ...F, y0: R.y1 });
    }
    // prune contained
    free = next.filter((a, i) => !next.some((b, j) => j !== i && a.x0 >= b.x0 && a.y0 >= b.y0 && a.x1 <= b.x1 && a.y1 <= b.y1 && (j < i || a.x0 !== b.x0 || a.y0 !== b.y0 || a.x1 !== b.x1 || a.y1 !== b.y1)));
  };
  for (const b of layer.boxes) { const A = aabb(b, types.get(b.typeId)); split({ x0: A.x0, y0: A.y0, x1: A.x1 + s, y1: A.y1 + s }); }
  const added = [];
  while (added.length < maxCount) {
    let best = null;
    for (const F of free) {
      for (const rot of [0, 90]) {
        const fx = (rot ? type.W : type.L) + s, fy = (rot ? type.L : type.W) + s;
        const fw = F.x1 - F.x0, fh = F.y1 - F.y0;
        if (fx > fw + 1e-6 || fy > fh + 1e-6) continue;
        const score = Math.min(fw - fx, fh - fy); // best short side fit
        const key = score * 1e6 + F.y0 * 1e3 + F.x0;
        if (!best || key < best.key) best = { key, x: F.x0, y: F.y0, fx, fy, rot };
      }
    }
    if (!best) break;
    const nb = { id: uid(), typeId: type.id, x: round1(best.x + (best.fx - s) / 2), y: round1(best.y + (best.fy - s) / 2), rot: best.rot };
    added.push(nb);
    split({ x0: best.x, y0: best.y, x1: best.x + best.fx, y1: best.y + best.fy });
  }
  return added;
}

export function transformLayer(boxes, pallet, mode) {
  return boxes.map((b) => {
    if (mode === 'mirrorX') return { ...b, id: uid(), x: pallet.L - b.x, rot: (540 - b.rot) % 360 };
    if (mode === 'mirrorY') return { ...b, id: uid(), y: pallet.W - b.y, rot: (360 - b.rot) % 360 };
    if (mode === 'rot180') return { ...b, id: uid(), x: pallet.L - b.x, y: pallet.W - b.y, rot: (b.rot + 180) % 360 };
    return { ...b, id: uid() };
  });
}
