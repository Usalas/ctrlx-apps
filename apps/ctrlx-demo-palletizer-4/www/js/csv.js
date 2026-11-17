// CSV export / import
import { layerBases, labelDir, uid, normRot } from './geom.js';
import { BOX_COLORS, STANDARD_PALLETS } from './data.js';

export const CSV_COLUMNS = ['Layer', 'Index', 'BoxType', 'PosX', 'PosY', 'PosZ', 'Rotation', 'BoxLength', 'BoxWidth', 'BoxHeight', 'BoxWeight', 'LabelDir', 'PalletLength', 'PalletWidth', 'PalletHeight'];

function orderBoxes(boxes, order) {
  const arr = boxes.slice();
  if (order === 'rows') arr.sort((a, b) => (Math.round(a.y) - Math.round(b.y)) || (a.x - b.x));
  if (order === 'farFirst') arr.sort((a, b) => (b.x - a.x) || (a.y - b.y));
  return arr;
}

export function buildCsv(project, pallet, types) {
  const o = project.settings.csv;
  const d = o.delim === '\\t' ? '\t' : o.delim;
  const fmt = (v) => {
    const s = (Math.round(v * 10 ** o.decimals) / 10 ** o.decimals).toFixed(o.decimals);
    return d === ',' ? s : s; // always '.' decimal separator
  };
  const q = (s) => (String(s).includes(d) || String(s).includes('"') ? '"' + String(s).replace(/"/g, '""') + '"' : String(s));
  const { bases } = layerBases(project.layers, types, project.settings.slip);
  const rows = [];
  const cols = o.dims ? CSV_COLUMNS : ['Layer', 'Index', 'BoxType', 'PosX', 'PosY', 'PosZ', 'Rotation'];
  if (o.header) rows.push(cols.join(d));
  let idx = 0;
  project.layers.forEach((layer, li) => {
    for (const b of orderBoxes(layer.boxes, o.order)) {
      const t = types.get(b.typeId); if (!t) continue;
      idx++;
      let x = b.x, y = b.y;
      if (o.origin === 'center') { x -= pallet.L / 2; y -= pallet.W / 2; }
      let z = bases[li] + (o.zRef === 'top' ? t.H : o.zRef === 'center' ? t.H / 2 : 0);
      if (o.zZero === 'floor') z += pallet.H;
      let r = normRot(b.rot);
      if (o.rotRange === '180' && r > 180) r -= 360;
      const row = [li + 1, idx, q(t.name), fmt(x), fmt(y), fmt(z), fmt(r)];
      if (o.dims) row.push(fmt(t.L), fmt(t.W), fmt(t.H), fmt(t.weight || 0), labelDir(b, t) || 'none', fmt(pallet.L), fmt(pallet.W), fmt(pallet.H));
      rows.push(row.join(d));
    }
  });
  return rows.join('\r\n') + '\r\n';
}

// ---------------- import ----------------
function splitLine(line, d) {
  const out = []; let cur = '', inq = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inq) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inq = false; }
      else cur += ch;
    } else if (ch === '"') inq = true;
    else if (ch === d) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const ALIASES = {
  layer: ['layer', 'lay', 'layerno', 'layernr', 'capa', 'camada', 'lage'],
  index: ['index', 'idx', 'no', 'nr', 'seq'],
  type: ['boxtype', 'type', 'box', 'name', 'boxname', 'product'],
  x: ['posx', 'x', 'positionx', 'xpos', 'px'],
  y: ['posy', 'y', 'positiony', 'ypos', 'py'],
  z: ['posz', 'z', 'positionz', 'zpos', 'pz'],
  rot: ['rotation', 'rot', 'angle', 'rz', 'c', 'a'],
  L: ['boxlength', 'length', 'l', 'boxl', 'lengthx'],
  W: ['boxwidth', 'width', 'w', 'boxw', 'widthy'],
  H: ['boxheight', 'height', 'h', 'boxh'],
  weight: ['boxweight', 'weight', 'kg', 'mass'],
  pL: ['palletlength', 'palletl'],
  pW: ['palletwidth', 'palletw'],
  pH: ['palletheight', 'palleth'],
};

export function parseCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() && !/^\s*[#\/]/.test(l));
  if (!lines.length) throw new Error('CSV is empty');
  const first = lines[0];
  const cnt = (c) => first.split(c).length - 1;
  const d = cnt('\t') > 0 ? '\t' : cnt(';') > cnt(',') ? ';' : ',';
  let rows = lines.map((l) => splitLine(l, d));
  // with ; or tab delimiters a decimal comma is allowed (e.g. 12,5)
  const num = (s) => { if (s == null || String(s).trim() === '') return NaN; s = String(s).trim(); return Number(d !== ',' ? s.replace(',', '.') : s); };
  const hasHeader = rows[0].some((c) => isNaN(num(c)) && /[a-z]/i.test(c) && Object.values(ALIASES).some((al) => al.includes(c.toLowerCase().replace(/[^a-z]/g, ''))));
  let map = {};
  if (hasHeader) {
    const hdr = rows[0].map((c) => c.toLowerCase().replace(/[^a-z]/g, ''));
    for (const [k, al] of Object.entries(ALIASES)) { const i = hdr.findIndex((h) => al.includes(h)); if (i >= 0) map[k] = i; }
    rows = rows.slice(1);
  } else {
    const n = rows[0].length;
    if (n >= 15) map = { layer: 0, index: 1, type: 2, x: 3, y: 4, z: 5, rot: 6, L: 7, W: 8, H: 9, weight: 10, pL: 12, pW: 13, pH: 14 };
    else if (n >= 7) map = { layer: 0, index: 1, type: 2, x: 3, y: 4, z: 5, rot: 6 };
    else if (n >= 5) map = { layer: 0, x: 1, y: 2, z: 3, rot: 4 };
    else throw new Error('Unrecognised CSV layout (no header, ' + n + ' columns)');
  }
  if (map.x == null || map.y == null) throw new Error('CSV needs X and Y columns');
  const get = (r, k) => (map[k] == null ? undefined : r[map[k]]);
  const recs = rows.map((r) => ({
    layer: num(get(r, 'layer')), type: get(r, 'type'), x: num(get(r, 'x')), y: num(get(r, 'y')), z: num(get(r, 'z')),
    rot: num(get(r, 'rot')) || 0, L: num(get(r, 'L')), W: num(get(r, 'W')), H: num(get(r, 'H')), weight: num(get(r, 'weight')),
    pL: num(get(r, 'pL')), pW: num(get(r, 'pW')), pH: num(get(r, 'pH')),
  })).filter((r) => !isNaN(r.x) && !isNaN(r.y));
  if (!recs.length) throw new Error('No box rows found in CSV');
  return { recs, delim: d, hasHeader };
}

// Turn parsed records into project changes. `opts` = current csv settings to invert the transform.
export function csvToProject(parsed, project, palletLib, fallbackType) {
  const o = project.settings.csv;
  const { recs } = parsed;
  // pallet
  let pallet = palletLib.find((p) => p.id === project.palletId);
  const r0 = recs.find((r) => !isNaN(r.pL) && !isNaN(r.pW));
  let newPallet = null;
  if (r0) {
    const match = palletLib.find((p) => Math.abs(p.L - r0.pL) < 0.6 && Math.abs(p.W - r0.pW) < 0.6 && (isNaN(r0.pH) || Math.abs(p.H - r0.pH) < 0.6));
    if (match) pallet = match;
    else {
      newPallet = { id: 'cp_' + uid(), name: `Imported ${r0.pL}×${r0.pW}`, L: r0.pL, W: r0.pW, H: isNaN(r0.pH) ? 144 : r0.pH, weight: 25, maxH: 1800, maxKg: 1000 };
      pallet = newPallet;
    }
  }
  // box types
  const types = project.boxTypes.slice();
  const newTypes = [];
  const findType = (r) => {
    if (isNaN(r.L) || isNaN(r.W) || isNaN(r.H)) {
      if (r.type) { const byName = types.find((t) => t.name === r.type); if (byName) return byName; }
      return fallbackType;
    }
    let t = types.find((t) => Math.abs(t.L - r.L) < 0.6 && Math.abs(t.W - r.W) < 0.6 && Math.abs(t.H - r.H) < 0.6 && (!r.type || t.name === r.type))
      || types.find((t) => Math.abs(t.L - r.L) < 0.6 && Math.abs(t.W - r.W) < 0.6 && Math.abs(t.H - r.H) < 0.6);
    if (!t) {
      t = { id: 'bx_' + uid(), name: r.type || `Box ${r.L}×${r.W}×${r.H}`, L: r.L, W: r.W, H: r.H, weight: isNaN(r.weight) ? 0 : r.weight,
        color: BOX_COLORS[(types.length) % BOX_COLORS.length], labelSide: 'front', image: null, imageMode: 'top' };
      types.push(t); newTypes.push(t);
    }
    return t;
  };
  // layers: by Layer column, else by Z
  const hasLayer = recs.every((r) => !isNaN(r.layer));
  let keyOf;
  if (hasLayer) keyOf = (r) => r.layer;
  else {
    const zs = [...new Set(recs.map((r) => Math.round((r.z || 0))))].sort((a, b) => a - b);
    keyOf = (r) => zs.indexOf(Math.round(r.z || 0)) + 1;
  }
  const groups = new Map();
  for (const r of recs) {
    const k = keyOf(r); if (!groups.has(k)) groups.set(k, []);
    const t = findType(r);
    let x = r.x, y = r.y;
    if (o.origin === 'center') { x += pallet.L / 2; y += pallet.W / 2; }
    groups.get(k).push({ id: uid(), typeId: t.id, x, y, rot: normRot(r.rot) });
  }
  const layers = [...groups.keys()].sort((a, b) => a - b).map((k) => ({ id: uid(), boxes: groups.get(k) }));
  return { layers, pallet, newPallet, newTypes, count: recs.length };
}

export const STD = STANDARD_PALLETS;
