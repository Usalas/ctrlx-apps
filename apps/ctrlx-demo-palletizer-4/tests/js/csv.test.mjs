import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCsv, parseCsv, csvToProject, CSV_COLUMNS } from '../../www/js/csv.js';
import { defaultProject, STANDARD_PALLETS } from '../../www/js/data.js';

function project() {
  const p = defaultProject();
  p.layers = [
    { id: 'l1', boxes: [{ id: 'a', typeId: 'bx1', x: 200, y: 150, rot: 0 }, { id: 'b', typeId: 'bx1', x: 600, y: 150, rot: 270 }] },
    { id: 'l2', boxes: [{ id: 'c', typeId: 'bx2', x: 300, y: 200, rot: 90 }] },
  ];
  return p;
}
const typesOf = (p) => new Map(p.boxTypes.map((t) => [t.id, t]));
const EUR = STANDARD_PALLETS[0];

test('CSV has the required columns and correct Z (top of box from pallet top)', () => {
  const p = project(); const csv = buildCsv(p, EUR, typesOf(p)).trim().split('\r\n');
  assert.equal(csv[0], CSV_COLUMNS.join(','));
  assert.equal(csv.length, 4);
  const r1 = csv[1].split(','), r3 = csv[3].split(',');
  assert.deepEqual(r1.slice(0, 7), ['1', '1', 'Carton 400×300', '200.0', '150.0', '250.0', '0.0']);
  assert.equal(r3[0], '2'); assert.equal(r3[5], '550.0'); // 250 (layer 1) + 300 (box height)
  assert.equal(r1.at(-3), '1200.0'); assert.equal(r1.at(-2), '800.0'); assert.equal(r1.at(-1), '144.0');
});

test('options: semicolon, centre origin, floor Z, bottom ref, ±180', () => {
  const p = project(); Object.assign(p.settings.csv, { delim: ';', origin: 'center', zZero: 'floor', zRef: 'bottom', rotRange: '180' });
  const r = buildCsv(p, EUR, typesOf(p)).trim().split('\r\n')[2].split(';');
  assert.deepEqual(r.slice(3, 7), ['0.0', '-250.0', '144.0', '-90.0']);
});

test('round trip: export -> import gives the same layers', () => {
  const p = project(); const csv = buildCsv(p, EUR, typesOf(p));
  const r = csvToProject(parseCsv(csv), p, STANDARD_PALLETS, p.boxTypes[0]);
  assert.equal(r.pallet.id, 'eur1'); assert.equal(r.newTypes.length, 0); assert.equal(r.layers.length, 2);
  const flat = (ls) => ls.map((l) => l.boxes.map((b) => [b.typeId, b.x, b.y, b.rot]));
  assert.deepEqual(flat(r.layers), flat(p.layers));
});

test('import of a foreign CSV: header aliases, decimal comma, unknown box and pallet', () => {
  const txt = 'layer;x;y;z;angle;length;width;height;palletlength;palletwidth\n1;100,5;150;200;90;250;250;200;1000;1000\n2;100;150;400;0;250;250;200;1000;1000\n';
  const p = defaultProject();
  const r = csvToProject(parseCsv(txt), p, STANDARD_PALLETS, p.boxTypes[0]);
  assert.equal(r.layers.length, 2); assert.equal(r.layers[0].boxes[0].x, 100.5); assert.equal(r.layers[0].boxes[0].rot, 90);
  assert.equal(r.newTypes.length, 1); assert.ok(r.newPallet); assert.equal(r.newPallet.L, 1000);
});

test('import without header and without layer column groups by Z', () => {
  const p = defaultProject();
  const r = csvToProject(parseCsv('0,100,150,250,0\n0,500,150,250,0\n0,100,150,500,0\n'), p, STANDARD_PALLETS, p.boxTypes[0]);
  // first column is taken as layer -> all 0 -> one layer; still 3 boxes
  assert.equal(r.count, 3);
});

test('rejects CSV without X/Y', () => {
  assert.throws(() => parseCsv('a;b\n1;2\n'));
});
