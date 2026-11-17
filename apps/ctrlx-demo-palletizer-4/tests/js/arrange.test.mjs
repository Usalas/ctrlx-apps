// Unit tests for auto arrange, geometry and label logic:  node --test tests/js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestPattern, fillFree, transformLayer } from '../../www/js/arrange.js';
import { evaluateLayer, labelStatus, orientLabels, layerBases, gapBetween } from '../../www/js/geom.js';

const S = (m = 0, sp = 0) => ({ margins: { left: m, right: m, front: m, back: m }, spacing: sp, slip: 0 });
const EUR = { L: 1200, W: 800, H: 144 };
const box = (L, W, H = 200, labelSide = 'front') => ({ id: 't', L, W, H, labelSide });
const types = (t) => new Map([[t.id, t]]);

function assertValid(boxes, t, pallet, st) {
  const ev = evaluateLayer({ boxes }, types(t), pallet, st);
  for (const [id, r] of ev) assert.equal(r.state, 'ok', `box ${id}: ${r.reasons.join(',')}`);
}

test('known optimum: 400x300 on EUR 1200x800 = 8 per layer', () => {
  const t = box(400, 300); const st = S();
  const b = bestPattern(t, EUR, st); assert.equal(b.length, 8); assertValid(b, t, EUR, st);
});

test('600x400 on EUR = 4, 300x200 on EUR = 16', () => {
  assert.equal(bestPattern(box(600, 400), EUR, S()).length, 4);
  assert.equal(bestPattern(box(300, 200), EUR, S()).length, 16);
});

test('1200x1000 with 400x300 gets at least 9 (plain grid gives 9)', () => {
  const t = box(400, 300); const P = { L: 1200, W: 1000, H: 144 };
  const b = bestPattern(t, P, S()); assert.ok(b.length >= 9, `got ${b.length}`); assertValid(b, t, P, S());
});

test('margins and spacing are respected', () => {
  const t = box(330, 220); const st = S(20, 5); const P = { L: 1200, W: 1000, H: 144 };
  const b = bestPattern(t, P, st); assert.ok(b.length >= 12); assertValid(b, t, P, st);
  for (let i = 0; i < b.length; i++) for (let j = i + 1; j < b.length; j++) assert.ok(gapBetween(b[i], t, b[j], t) >= 5 - 1e-6);
});

test('fine boxes stay fast and near the area bound', () => {
  const t = box(52, 41); const t0 = Date.now();
  const n = bestPattern(t, EUR, S()).length;
  assert.ok(Date.now() - t0 < 3000); assert.ok(n >= 440, `got ${n}`);
});

test('fill free space keeps existing boxes and does not overlap them', () => {
  const t = box(400, 300); const st = S();
  const layer = { boxes: [{ id: 'a', typeId: 't', x: 600, y: 400, rot: 0 }] };
  const add = fillFree(t, layer, types(t), EUR, st);
  assert.ok(add.length >= 4); assertValid([...layer.boxes, ...add], t, EUR, st);
});

test('mirror / rotate transforms stay on the pallet', () => {
  const t = box(400, 300); const b = bestPattern(t, EUR, S());
  for (const m of ['mirrorX', 'mirrorY', 'rot180']) assertValid(transformLayer(b, EUR, m), t, EUR, S());
});

test('overlap, margin and outside-pallet detection', () => {
  const t = box(400, 300); const st = S(20);
  const ev = evaluateLayer({ boxes: [
    { id: 'a', typeId: 't', x: 300, y: 300, rot: 0 }, { id: 'b', typeId: 't', x: 400, y: 300, rot: 0 },
    { id: 'c', typeId: 't', x: 210, y: 650, rot: 0 }, { id: 'd', typeId: 't', x: 1150, y: 650, rot: 0 }] }, types(t), EUR, st);
  assert.equal(ev.get('a').state, 'bad'); assert.equal(ev.get('b').state, 'bad');
  assert.equal(ev.get('c').state, 'warn'); assert.equal(ev.get('d').state, 'bad');
});

test('labels: perimeter boxes are turned to face out, interior boxes ignored', () => {
  const t = box(300, 200, 200, 'front');            // 4 x 4 grid on EUR, label on the long side
  const st = S(); const layer = { boxes: bestPattern(t, EUR, st) };
  for (const b of layer.boxes) b.rot = (b.rot + 180) % 360; // start with everything wrong
  orientLabels(layer, types(t), EUR, st);
  const ls = labelStatus(layer, types(t), EUR);
  const counts = { out: 0, in: 0, interior: 0 };
  for (const v of ls.values()) counts[v]++;
  // front/back rows (8) can face out with a 180° turn; the 4 middle boxes of the left/right
  // columns would need 90° (footprint swap -> collision) so they stay flagged; 4 are interior
  assert.deepEqual(counts, { out: 8, in: 4, interior: 4 });
  for (const b of layer.boxes) if (ls.get(b.id) === 'in') assert.ok(b.x < 300 || b.x > 900);
  // label on the short side: every perimeter box can face out
  const t2 = box(300, 200, 200, 'right'); const l2 = { boxes: bestPattern(t2, EUR, st) };
  orientLabels(l2, types(t2), EUR, st);
  const c2 = [...labelStatus(l2, types(t2), EUR).values()];
  assert.equal(c2.filter((v) => v === 'in').length, 4); // middle boxes of front/back rows now need 90°
  assertValid(layer.boxes, t, EUR, st);
});

test('layer Z bases include slip sheets', () => {
  const t = box(400, 300, 250); const L = { boxes: [{ id: 'a', typeId: 't', x: 200, y: 150, rot: 0 }] };
  const { bases, top } = layerBases([L, L, L], types(t), 2);
  assert.deepEqual(bases, [0, 252, 504]); assert.equal(top, 754);
});
