import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// Machine convention: Z up, millimetres, degrees.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const DEG = Math.PI / 180;
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 2) => (v === undefined || v === null || Number.isNaN(v) ? '–' : Number(v).toFixed(d));
const uid = () => Math.random().toString(36).slice(2, 10);
const AXIS_DIRS = ['x', 'y', 'z'];
const KIN_COORDS = ['X', 'Y', 'Z', 'A', 'B', 'C'];
const AREA_COLORS = { SAFE_AREA: 0xe53935, WORK_AREA_EXCL: 0xfb8c00, WORK_AREA_INCL: 0x43a047 };
const AREA_LABELS = { SAFE_AREA: 'Safe area', WORK_AREA_EXCL: 'Work excl.', WORK_AREA_INCL: 'Work incl.' };

// ---------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------
const state = {
  scene: null,               // persisted scene document
  models: [],                // STL files on the core
  axes: [], kins: [],        // names from the Data Layer
  live: { axes: {}, kins: {} },
  manual: {},                // signal -> value when Live is off
  liveEnabled: true,
  appMode: 'edit',           // 'edit' | 'run'
  motion: { safeAreas: [], points: [], errors: [], nodes: {} },
  selection: null,           // {kind: 'part'|'frame'|'point', id}
  dirty: false,
};

// The ctrlX sidebar link passes the user's JWT as ?token=; every API call sends it back.
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const api = async (path, options = {}) => {
  const headers = { ...(options.headers || {}), ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return (res.headers.get('content-type') || '').includes('json') ? res.json() : res;
};

function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'toast' + (error ? ' error' : '');
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (el.hidden = true), error ? 6000 : 2500);
}

function setDirty(dirty = true) {
  state.dirty = dirty;
  $('#dirty').hidden = !dirty;
}

function unitToMM(unit) {
  switch ((unit || 'mm').toLowerCase()) {
    case 'm': return 1000;
    case 'cm': return 10;
    case 'um': case 'µm': return 0.001;
    case 'in': case 'inch': return 25.4;
    default: return 1;
  }
}

// ---------------------------------------------------------------------------------------
// Three.js setup
// ---------------------------------------------------------------------------------------
const viewport = $('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
viewport.appendChild(renderer.domElement);
const labelRenderer = new CSS2DRenderer();
Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
viewport.appendChild(labelRenderer.domElement);

const scene3d = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 1, 200000);
camera.position.set(1400, -1600, 1100);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.target.set(0, 0, 150);
// Without limits the wheel can park the camera on its target, where zooming out barely moves it
orbit.minDistance = 20;
orbit.maxDistance = 60000;
orbit.zoomToCursor = true;

scene3d.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(1500, -1000, 3000);
scene3d.add(sun);
const grid = new THREE.GridHelper(4000, 40, 0x8a96a3, 0xc3ccd5);
grid.rotation.x = Math.PI / 2;
grid.material.transparent = true;
grid.material.opacity = 0.5;
scene3d.add(grid);
scene3d.add(new THREE.AxesHelper(150));

const world = new THREE.Group();   // parts and frames live here
scene3d.add(world);

const gizmo = new TransformControls(camera, renderer.domElement);
gizmo.setSize(0.8);
scene3d.add(gizmo);
gizmo.addEventListener('dragging-changed', (e) => (orbit.enabled = !e.value));
gizmo.addEventListener('objectChange', onGizmoChange);

function resize() {
  const { clientWidth: w, clientHeight: h } = viewport;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);

// ---------------------------------------------------------------------------------------
// Scene graph: part = joint (pose) -> motion (axis) -> meshHolder (mesh offset) -> mesh
//              children parts and frames hang below the parent's motion group
// ---------------------------------------------------------------------------------------
const nodes = new Map();   // part id -> {joint, motion, holder, mesh}
const frames = new Map();  // frame name -> {group, overlay}
const geometryCache = new Map();
const stlLoader = new STLLoader();
const pickables = [];
const removePickable = (mesh) => { const i = pickables.indexOf(mesh); if (i >= 0) pickables.splice(i, 1); };

function loadGeometry(name) {
  if (!geometryCache.has(name)) {
    const p = api(`api/models/${encodeURIComponent(name)}`)
      .then((res) => res.arrayBuffer())
      .then((buf) => {
        const geo = stlLoader.parse(buf);
        if (!geo.hasAttribute('normal')) geo.computeVertexNormals();
        geo.computeBoundingBox();
        return geo;
      });
    p.catch(() => geometryCache.delete(name));
    geometryCache.set(name, p);
  }
  return geometryCache.get(name);
}

function defaultPart(model) {
  return {
    id: uid(), name: model.replace(/\.stl$/i, ''), model, parent: null,
    position: [0, 0, 0], rotation: [0, 0, 0], color: '#9aa7b3', opacity: 1, modelScale: 1, visible: true,
    meshOffset: { position: [0, 0, 0], rotation: [0, 0, 0] }, pivot: [0, 0, 0], motion: null,
  };
}

function normalizeScene(doc) {
  doc.parts ??= [];
  doc.frames ??= {};
  doc.frames.MCS ??= { parent: null, position: [0, 0, 0], rotation: [0, 0, 0] };
  doc.overlay = { showPoints: true, showAreas: true, areaExtent: 1000, trailLength: 600, hiddenAreas: [], kins: {},
    hiddenPoints: [], hiddenPointGroups: [], pointLabels: 'all', areaLabels: true, ...(doc.overlay || {}) };
  for (const p of doc.parts) {
    p.meshOffset ??= { position: [0, 0, 0], rotation: [0, 0, 0] };
    p.pivot ??= [0, 0, 0];
    p.opacity ??= 1; p.modelScale ??= 1; p.visible ??= true; p.color ??= '#9aa7b3';
  }
  return doc;
}

const partById = (id) => state.scene.parts.find((p) => p.id === id);

function parentObject(parentId) {
  return (parentId && nodes.get(parentId)?.motion) || world;
}

function applyPose(obj, position, rotation) {
  obj.position.fromArray(position);
  obj.rotation.set(rotation[0] * DEG, rotation[1] * DEG, rotation[2] * DEG, 'XYZ');
}

// The part origin (joint) is its rotation point: shift the STL so that `pivot`
// (in the STL's own coordinates) lands on it.
function holderPosition(part) {
  const o = part.meshOffset;
  const pivot = new THREE.Vector3().fromArray(part.pivot || [0, 0, 0]).multiplyScalar(part.modelScale || 1)
    .applyEuler(new THREE.Euler(o.rotation[0] * DEG, o.rotation[1] * DEG, o.rotation[2] * DEG, 'XYZ'));
  return new THREE.Vector3().fromArray(o.position).sub(pivot);
}

// Move the rotation point without moving the part on screen
function setPivot(part, pivot) {
  const before = holderPosition(part);
  part.pivot = pivot.map((v) => +(+v).toFixed(4));
  const shift = before.sub(holderPosition(part)); // how far the STL would jump, in joint coordinates
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(part.rotation[0] * DEG, part.rotation[1] * DEG, part.rotation[2] * DEG, 'XYZ'));
  shift.applyQuaternion(q);
  part.position = part.position.map((v, i) => +(v + shift.getComponent(i)).toFixed(3));
  syncPart(part);
  setDirty();
}

function createPartNode(part) {
  const joint = new THREE.Group();
  const motion = new THREE.Group();
  const holder = new THREE.Group();
  joint.add(motion);
  motion.add(holder);
  joint.userData = { kind: 'part', id: part.id };
  const node = { joint, motion, holder, mesh: null };
  nodes.set(part.id, node);
  return node;
}

function syncPart(part) {
  const node = nodes.get(part.id) || createPartNode(part);
  const parent = parentObject(part.parent);
  if (node.joint.parent !== parent) parent.add(node.joint);
  applyPose(node.joint, part.position, part.rotation);
  applyPose(node.holder, part.meshOffset.position, part.meshOffset.rotation);
  node.holder.position.copy(holderPosition(part));
  node.holder.scale.setScalar(part.modelScale || 1);
  node.joint.visible = part.visible;

  if (node.mesh && node.mesh.userData.model !== part.model) {
    node.holder.remove(node.mesh);
    removePickable(node.mesh);
    node.mesh = null;
  }
  if (!node.mesh) {
    const material = new THREE.MeshStandardMaterial({ color: part.color, metalness: 0.15, roughness: 0.6 });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(20, 20, 20), material);
    mesh.userData = { kind: 'part', id: part.id, model: part.model };
    node.mesh = mesh;
    node.holder.add(mesh);
    pickables.push(mesh);
    loadGeometry(part.model)
      .then((geo) => { if (node.mesh === mesh) mesh.geometry = geo; })
      .catch(() => { material.wireframe = true; material.color.set(0xff0000); toast(`Model ${part.model} not found on the core`, true); });
  }
  const m = node.mesh.material;
  m.color.set(part.color);
  m.opacity = part.opacity;
  m.transparent = part.opacity < 1;
  m.depthWrite = part.opacity >= 1;
  m.emissive.set(state.selection?.kind === 'part' && state.selection.id === part.id ? 0x1d5d86 : 0x000000);
}

function makeLabel(text, cls) {
  const div = document.createElement('div');
  div.className = 'lbl ' + cls;
  div.textContent = text;
  return new CSS2DObject(div);
}

function syncFrame(name) {
  const def = state.scene.frames[name];
  let f = frames.get(name);
  if (!f) {
    const group = new THREE.Group();
    group.userData = { kind: 'frame', id: name };
    const axes = new THREE.AxesHelper(80);
    axes.material.depthTest = false;
    axes.renderOrder = 5;
    group.add(axes);
    const label = makeLabel(name, 'frame');
    label.position.set(0, 0, 0);
    group.add(label);
    const overlay = new THREE.Group();
    group.add(overlay);
    f = { group, overlay, label };
    frames.set(name, f);
  }
  const parent = parentObject(def.parent);
  if (f.group.parent !== parent) parent.add(f.group);
  applyPose(f.group, def.position, def.rotation);
}

function rebuildAll() {
  // Parents first, so children find their parent's motion group
  const order = [];
  const visit = (parentId) => state.scene.parts.filter((p) => (p.parent || null) === parentId).forEach((p) => { order.push(p); visit(p.id); });
  visit(null);
  state.scene.parts.filter((p) => !order.includes(p)).forEach((p) => { p.parent = null; order.push(p); });
  order.forEach(syncPart);
  for (const [id, node] of nodes) {
    if (!partById(id)) { node.joint.removeFromParent(); removePickable(node.mesh); nodes.delete(id); }
  }
  for (const name of Object.keys(state.scene.frames)) syncFrame(name);
  for (const [name, f] of frames) if (!state.scene.frames[name]) { f.group.removeFromParent(); frames.delete(name); }
  buildOverlays();
  attachGizmo();
}

// Run fn with every axis motion at zero, so poses can be re-expressed without baking in axis positions.
function withZeroMotion(fn) {
  for (const node of nodes.values()) { node.motion.position.set(0, 0, 0); node.motion.rotation.set(0, 0, 0); }
  world.updateMatrixWorld(true);
  fn();
}

function reparent(obj, data, newParentId) {
  withZeroMotion(() => {
    parentObject(newParentId).attach(obj);
    data.parent = newParentId;
    data.position = obj.position.toArray().map((v) => +v.toFixed(3));
    data.rotation = [obj.rotation.x, obj.rotation.y, obj.rotation.z].map((v) => +(v / DEG).toFixed(3));
  });
}

function descendants(partId) {
  const out = new Set();
  const visit = (id) => state.scene.parts.filter((p) => p.parent === id).forEach((p) => { out.add(p.id); visit(p.id); });
  visit(partId);
  return out;
}

// ---------------------------------------------------------------------------------------
// Motion: axis values, kinematics TCP, trails
// ---------------------------------------------------------------------------------------
function signalValue(signal) {
  if (!signal) return undefined;
  if (!state.liveEnabled) return state.manual[signal] ?? 0;
  const [kind, name, index] = signal.split(':');
  if (kind === 'axis') return state.live.axes[name];
  if (kind === 'kin') {
    const k = state.live.kins[name];
    const i = Number(index);
    return k ? k.pos[i] * (i < 3 ? unitToMM(k.units?.[i]) : 1) : undefined;
  }
  return undefined;
}

function kinPosition(name) {
  if (!state.liveEnabled) {
    const v = (i) => state.manual[`kin:${name}:${i}`] ?? 0;
    return new THREE.Vector3(v(0), v(1), v(2));
  }
  const k = state.live.kins[name];
  if (!k || k.pos.length < 3) return null;
  return new THREE.Vector3(...[0, 1, 2].map((i) => k.pos[i] * unitToMM(k.units?.[i])));
}

const tmpV = new THREE.Vector3();
function applyMotion() {
  const ordered = [];
  const visit = (parentId) => state.scene.parts.filter((p) => (p.parent || null) === parentId).forEach((p) => { ordered.push(p); visit(p.id); });
  visit(null);
  for (const part of ordered) {
    const node = nodes.get(part.id);
    const m = part.motion;
    if (!node) continue;
    node.motion.position.set(0, 0, 0);
    node.motion.rotation.set(0, 0, 0);
    if (!m) continue;
    if (m.type === 'tcp') {
      const frame = frames.get(m.frame || 'MCS');
      const pos = m.kin && frame ? kinPosition(m.kin) : null;
      if (pos) {
        frame.group.updateWorldMatrix(true, false);
        node.joint.updateWorldMatrix(true, false);
        node.motion.position.copy(node.joint.worldToLocal(frame.group.localToWorld(tmpV.copy(pos))));
      }
      continue;
    }
    const raw = signalValue(m.signal);
    if (raw === undefined) continue;
    const value = (m.invert ? -1 : 1) * (raw * (m.scale ?? 1) + (m.offset ?? 0));
    const dir = AXIS_DIRS.includes(m.direction) ? m.direction : 'x';
    if (m.type === 'rotary') node.motion.rotation[dir] = value * DEG;
    else node.motion.position[dir] = value;
  }
}

// Per kinematics: marker + trail inside its frame
const kinVisuals = new Map();
function kinSettings(name) {
  const all = state.scene.overlay.kins;
  all[name] ??= { show: true, frame: 'MCS', trail: true, color: '#00acc1' };
  return all[name];
}

function ensureKinVisual(name) {
  const cfg = kinSettings(name);
  let v = kinVisuals.get(name);
  if (!v) {
    const marker = new THREE.Group();
    const ball = new THREE.Mesh(new THREE.SphereGeometry(7, 20, 14), new THREE.MeshBasicMaterial({ color: cfg.color, depthTest: false }));
    ball.renderOrder = 10;
    marker.add(ball, new THREE.AxesHelper(45));
    const label = makeLabel(name, 'tcp');
    marker.add(label);
    const max = 4000;
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(max * 3), 3));
    trailGeo.setDrawRange(0, 0);
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: cfg.color, transparent: true, opacity: 0.85 }));
    trail.frustumCulled = false;
    v = { marker, ball, label, trail, points: [], max };
    kinVisuals.set(name, v);
  }
  const frame = frames.get(cfg.frame) || frames.get('MCS');
  if (v.marker.parent !== frame.group) { frame.group.add(v.marker, v.trail); v.points = []; }
  v.ball.material.color.set(cfg.color);
  v.trail.material.color.set(cfg.color);
  v.marker.visible = cfg.show;
  v.trail.visible = cfg.show && cfg.trail;
  return v;
}

function updateKinematics() {
  const limit = Math.min(state.scene.overlay.trailLength || 600, 4000);
  for (const name of state.kins) {
    const v = ensureKinVisual(name);
    const pos = kinPosition(name);
    if (!pos) { v.marker.visible = false; continue; }
    v.marker.position.copy(pos);
    const last = v.points[v.points.length - 1];
    if (!last || last.distanceToSquared(pos) > 0.25) {
      v.points.push(pos.clone());
      if (v.points.length > limit) v.points.splice(0, v.points.length - limit);
      const arr = v.trail.geometry.attributes.position.array;
      v.points.forEach((p, i) => { arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z; });
      v.trail.geometry.attributes.position.needsUpdate = true;
      v.trail.geometry.setDrawRange(0, v.points.length);
    }
    const violations = areaViolations(name, pos);
    v.violations = violations;
    v.label.element.textContent = `${name}  ${fmt(pos.x, 1)}  ${fmt(pos.y, 1)}  ${fmt(pos.z, 1)}`;
    v.label.element.classList.toggle('violation', violations.length > 0);
    v.ball.material.color.set(violations.length ? 0xe53935 : kinSettings(name).color);
  }
}

// ---------------------------------------------------------------------------------------
// Teach points and safe / work areas
// ---------------------------------------------------------------------------------------
const pointGeo = new THREE.SphereGeometry(6, 16, 12);
const pointMat = new THREE.MeshBasicMaterial({ color: 0x8e24aa });
const pointSelMat = new THREE.MeshBasicMaterial({ color: 0xffb300 });
let areaVisuals = [];
let pointVisuals = [];

function pointXYZ(point) {
  const byMeaning = {};
  point.entries.forEach((e, i) => {
    const key = (e.meaning || KIN_COORDS[i] || '').toUpperCase();
    byMeaning[key] = e.value * unitToMM(e.unit);
  });
  if (!['X', 'Y', 'Z'].some((k) => k in byMeaning)) {
    point.entries.slice(0, 3).forEach((e, i) => (byMeaning['XYZ'[i]] = e.value * unitToMM(e.unit)));
  }
  return new THREE.Vector3(byMeaning.X ?? 0, byMeaning.Y ?? 0, byMeaning.Z ?? 0);
}

function areaBounds(area) {
  const ext = state.scene.overlay.areaExtent || 1000;
  const min = new THREE.Vector3(), max = new THREE.Vector3();
  ['x', 'y', 'z'].forEach((axis, i) => {
    const b = area.box[i];
    const active = b && b.active;
    const f = b ? unitToMM(b.unit) : 1;
    min[axis] = active ? Math.min(b.min, b.max) * f : -ext;
    max[axis] = active ? Math.max(b.min, b.max) * f : ext;
  });
  return new THREE.Box3(min, max);
}

const areaKey = (a) => `${a.source}|${a.name}`;
const pointKey = (p) => `${p.kin || p.source}|${p.name}`;
const pointGroup = (p) => p.kin || p.referenceSystem || 'Points';

// Removing a group does not remove its CSS2D labels from the page (three.js only does
// that for the label object itself), so take the label elements out here.
function disposeOverlay(object) {
  object.removeFromParent();
  object.traverse((o) => {
    if (o.isCSS2DObject) o.element.remove();
    if (o.geometry && o.geometry !== pointGeo) o.geometry.dispose();
    if (o.material && o.material !== pointMat && o.material !== pointSelMat) o.material.dispose();
  });
}

// Labels follow their object's visibility (CSS2DRenderer only checks the label itself)
function syncOverlayLabels() {
  const ov = state.scene.overlay;
  for (const v of areaVisuals) v.label.visible = v.object.visible && ov.areaLabels;
  for (const v of pointVisuals) {
    const show = ov.pointLabels === 'all' || (ov.pointLabels === 'selected' && isSelected('point', v.index));
    v.label.visible = v.object.visible && show;
  }
}

// Hide labels that would overlap one already shown: selected point first, then areas,
// then points nearest the camera.
let lastDeclutter = 0;
function declutterLabels(t) {
  if (t - lastDeclutter < 150) return;
  lastDeclutter = t;
  // TCP and frame labels always stay; the others make room for them
  const items = [...kinVisuals.values(), ...frames.values()].map((v) => ({ el: v.label.element, rank: -1, fixed: true }));
  for (const v of areaVisuals) if (v.label.visible) items.push({ el: v.label.element, rank: 1 });
  for (const v of pointVisuals) {
    if (!v.label.visible) continue;
    const d = camera.position.distanceTo(v.object.getWorldPosition(new THREE.Vector3()));
    items.push({ el: v.label.element, rank: isSelected('point', v.index) ? 0 : 2 + d / 1e6 });
  }
  items.sort((a, b) => a.rank - b.rank);
  const placed = [];
  for (const it of items) {
    if (!it.fixed) it.el.style.visibility = '';
    if (it.el.style.display === 'none' || !it.el.isConnected) continue;
    const r = it.el.getBoundingClientRect();
    if (it.fixed) { placed.push(r); continue; }
    const hit = placed.some((p) => r.left < p.right + 2 && r.right > p.left - 2 && r.top < p.bottom + 1 && r.bottom > p.top - 1);
    if (hit) it.el.style.visibility = 'hidden';
    else placed.push(r);
  }
}
// MCS teach points belong to a kinematics: draw them in that kinematics' frame
function pointFrame(point) {
  if (point.referenceSystem === 'ACS') return null;
  const name = point.kin ? kinSettings(point.kin).frame || 'MCS' : 'MCS';
  return frames.has(name) ? name : null;
}
const drawable = (coordSystem) => coordSystem && coordSystem !== 'ACS' && frames.has(coordSystem);

function buildOverlays() {
  for (const v of [...areaVisuals, ...pointVisuals]) disposeOverlay(v.object);
  areaVisuals = [];
  pointVisuals = [];
  const ov = state.scene.overlay;

  state.motion.safeAreas.forEach((area, index) => {
    if (!drawable(area.coordSystem) || area.box.length !== 3) return;
    const box = areaBounds(area);
    const size = box.getSize(new THREE.Vector3());
    const color = AREA_COLORS[area.type] ?? 0x888888;
    const group = new THREE.Group();
    const fill = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: area.type === 'WORK_AREA_INCL' ? 0.05 : 0.16, depthWrite: false, side: THREE.DoubleSide }));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(fill.geometry), new THREE.LineBasicMaterial({ color }));
    group.add(fill, edges);
    const label = makeLabel(area.name, 'area');
    label.element.style.setProperty('--c', '#' + color.toString(16).padStart(6, '0'));
    label.center.set(0.5, 1); // just above the top face
    label.position.set(0, 0, size.z / 2);
    group.add(label);
    group.position.copy(box.getCenter(new THREE.Vector3()));
    group.visible = ov.showAreas && !ov.hiddenAreas.includes(areaKey(area));
    frames.get(area.coordSystem).overlay.add(group);
    areaVisuals.push({ object: group, fill, label, area, index, box, baseOpacity: fill.material.opacity });
  });

  state.motion.points.forEach((point, index) => {
    const frameName = pointFrame(point);
    if (!frameName) return;
    const mesh = new THREE.Mesh(pointGeo, isSelected('point', index) ? pointSelMat : pointMat);
    mesh.position.copy(pointXYZ(point));
    mesh.userData = { kind: 'point', id: index };
    const label = makeLabel(point.name, 'point');
    label.center.set(0, 1); // label sits up and to the right of the dot
    mesh.add(label);
    mesh.visible = ov.showPoints && !ov.hiddenPoints.includes(pointKey(point)) && !ov.hiddenPointGroups.includes(pointGroup(point));
    frames.get(frameName).overlay.add(mesh);
    pointVisuals.push({ object: mesh, label, point, index });
  });
  syncOverlayLabels();
}

// Areas a kinematics TCP currently violates (only areas defined in the kinematics' frame)
function areaViolations(kinName, pos) {
  const frameName = kinSettings(kinName).frame || 'MCS';
  const out = [];
  for (const v of areaVisuals) {
    if (v.area.coordSystem !== frameName) continue;
    const inside = activeContains(v.area, pos);
    const violated = v.area.type === 'WORK_AREA_INCL' ? !inside : inside;
    if (violated) out.push(v.area.name);
  }
  return out;
}

function activeContains(area, pos) {
  return ['x', 'y', 'z'].every((axis, i) => {
    const b = area.box[i];
    if (!b || !b.active) return true;
    const f = unitToMM(b.unit);
    return pos[axis] >= Math.min(b.min, b.max) * f && pos[axis] <= Math.max(b.min, b.max) * f;
  });
}

function highlightViolatedAreas() {
  const hit = new Set();
  for (const v of kinVisuals.values()) (v.violations || []).forEach((n) => hit.add(n));
  for (const v of areaVisuals) {
    const on = hit.has(v.area.name);
    v.fill.material.opacity = on ? Math.max(0.35, v.baseOpacity) : v.baseOpacity;
    v.label.element.classList.toggle('violation', on);
  }
}

// ---------------------------------------------------------------------------------------
// Selection, gizmo, picking
// ---------------------------------------------------------------------------------------
const isSelected = (kind, id) => state.selection?.kind === kind && state.selection.id === id;

function select(kind, id) {
  state.selection = kind ? { kind, id } : null;
  for (const p of state.scene.parts) syncPart(p);
  pointVisuals.forEach((v) => (v.object.material = isSelected('point', v.index) ? pointSelMat : pointMat));
  syncOverlayLabels();
  attachGizmo();
  renderTree();
  renderInspector();
  renderMotionPanel();
}

function attachGizmo() {
  const sel = state.selection;
  if (state.appMode === 'run') gizmo.detach();
  else if (sel?.kind === 'part' && nodes.has(sel.id)) gizmo.attach(nodes.get(sel.id).joint);
  else if (sel?.kind === 'frame' && frames.has(sel.id)) gizmo.attach(frames.get(sel.id).group);
  else gizmo.detach();
}

function onGizmoChange() {
  const obj = gizmo.object;
  if (!obj) return;
  const { kind, id } = obj.userData;
  const data = kind === 'part' ? partById(id) : state.scene.frames[id];
  if (!data) return;
  data.position = obj.position.toArray().map((v) => +v.toFixed(3));
  data.rotation = [obj.rotation.x, obj.rotation.y, obj.rotation.z].map((v) => +(v / DEG).toFixed(3));
  setDirty();
  updatePoseInputs(data);
}

const raycaster = new THREE.Raycaster();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4 || gizmo.dragging) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const targets = [...pickables.filter((m) => m.visible), ...pointVisuals.filter((v) => v.object.visible).map((v) => v.object)];
  const hit = raycaster.intersectObjects(targets, false).find((h) => isVisible(h.object));
  if (hit) select(hit.object.userData.kind, hit.object.userData.id);
  else select(null);
});
const isVisible = (obj) => { for (let o = obj; o; o = o.parent) if (!o.visible) return false; return true; };

function fitView() {
  const box = new THREE.Box3();
  for (const node of nodes.values()) if (node.mesh && isVisible(node.mesh)) box.expandByObject(node.mesh);
  if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(0, 0, 0), new THREE.Vector3(800, 800, 400));
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getSize(new THREE.Vector3()).length() / 2;
  const dist = radius / Math.sin((camera.fov * DEG) / 2) * 1.1;
  const dir = camera.position.clone().sub(orbit.target).normalize();
  orbit.target.copy(center);
  camera.position.copy(center).addScaledVector(dir, dist);
}

// ---------------------------------------------------------------------------------------
// UI: library, tree, inspector, motion panel
// ---------------------------------------------------------------------------------------
function renderModels() {
  const used = new Set(state.scene.parts.map((p) => p.model));
  $('#model-list').innerHTML = state.models.length ? state.models.map((m) => `
    <li title="${esc(m.name)}">
      <span class="name">${esc(m.name)}</span>
      <span class="meta">${(m.size / 1024).toFixed(0)} kB</span>
      <button class="small" data-add="${esc(m.name)}" title="Add to assembly">Add</button>
      <button class="icon-btn" data-del-model="${esc(m.name)}" title="Delete from core"${used.has(m.name) ? ' disabled' : ''}>✕</button>
    </li>`).join('') : '<li class="muted">No STL files yet</li>';
}

$('#model-list').addEventListener('click', async (e) => {
  const add = e.target.closest('[data-add]')?.dataset.add;
  const del = e.target.closest('[data-del-model]')?.dataset.delModel;
  if (add) {
    const part = defaultPart(add);
    state.scene.parts.push(part);
    syncPart(part);
    setDirty();
    select('part', part.id);
    renderModels();
  } else if (del && confirm(`Delete ${del} from the core?`)) {
    state.models = await api(`api/models/${encodeURIComponent(del)}`, { method: 'DELETE' });
    geometryCache.delete(del);
    renderModels();
  }
});

async function uploadFiles(files) {
  const stl = [...files].filter((f) => /\.stl$/i.test(f.name));
  if (!stl.length) return toast('Only .stl files can be uploaded', true);
  const form = new FormData();
  stl.forEach((f) => form.append('file', f, f.name));
  try {
    const res = await api('api/models', { method: 'POST', body: form });
    state.models = res.models;
    res.saved.forEach((n) => geometryCache.delete(n));
    // Reload parts that use a replaced model
    for (const p of state.scene.parts) if (res.saved.includes(p.model)) { const n = nodes.get(p.id); if (n?.mesh) n.mesh.userData.model = null; syncPart(p); }
    renderModels();
    toast(`Uploaded ${res.saved.join(', ')}`);
  } catch (err) { toast(`Upload failed: ${err.message}`, true); }
}
$('#file-input').addEventListener('change', (e) => { uploadFiles(e.target.files); e.target.value = ''; });
viewport.addEventListener('dragover', (e) => { e.preventDefault(); $('#drop-hint').hidden = false; });
viewport.addEventListener('dragleave', (e) => { if (!viewport.contains(e.relatedTarget)) $('#drop-hint').hidden = true; });
viewport.addEventListener('drop', (e) => { e.preventDefault(); $('#drop-hint').hidden = true; uploadFiles(e.dataTransfer.files); });

function bindingLabel(m) {
  if (!m) return '';
  if (m.type === 'tcp') return `TCP ${m.kin || '?'}`;
  return `${m.type === 'rotary' ? '⟳' : '↔'} ${(m.signal || '?').replace(/^axis:/, '').replace(/^kin:/, '')}`;
}

function renderTree() {
  const rows = [];
  const add = (parentId, depth) => {
    state.scene.parts.filter((p) => (p.parent || null) === parentId).forEach((p) => {
      rows.push(`<li data-kind="part" data-id="${p.id}" class="${isSelected('part', p.id) ? 'selected' : ''}" style="padding-left:${6 + depth * 14}px">
        <button class="icon-btn" data-vis="${p.id}" title="Show/hide">${p.visible ? '◉' : '○'}</button>
        <span class="name">${esc(p.name)}</span><span class="bind">${esc(bindingLabel(p.motion))}</span></li>`);
      Object.entries(state.scene.frames).filter(([, f]) => f.parent === p.id).forEach(([n]) => rows.push(frameRow(n, depth + 1)));
      add(p.id, depth + 1);
    });
  };
  Object.entries(state.scene.frames).filter(([, f]) => !f.parent).forEach(([n]) => rows.push(frameRow(n, 0)));
  add(null, 0);
  $('#tree').innerHTML = rows.join('') || '<li class="muted">Add a model from the library</li>';
}
const frameRow = (name, depth) => `<li data-kind="frame" data-id="${esc(name)}" class="${isSelected('frame', name) ? 'selected' : ''}" style="padding-left:${6 + depth * 14}px">
  <span class="kind">frame</span><span class="name">${esc(name)}</span></li>`;

$('#tree').addEventListener('click', (e) => {
  const vis = e.target.closest('[data-vis]')?.dataset.vis;
  if (vis) { const p = partById(vis); p.visible = !p.visible; syncPart(p); setDirty(); renderTree(); return; }
  const li = e.target.closest('li[data-kind]');
  if (li) select(li.dataset.kind, li.dataset.id);
});

$('#btn-add-frame').addEventListener('click', () => {
  const name = prompt('Frame name (use the coordinate system name of your areas, e.g. WCS or PCS):', 'WCS');
  if (!name || state.scene.frames[name]) return;
  state.scene.frames[name] = { parent: null, position: [0, 0, 0], rotation: [0, 0, 0] };
  syncFrame(name);
  buildOverlays();
  setDirty();
  select('frame', name);
});

const num = (path, value, step = 1) => `<input type="number" step="${step}" data-path="${path}" value="${+(+value).toFixed(4)}">`;
const xyz = (path, arr, step) => `<div class="xyz">${arr.map((v, i) => num(`${path}.${i}`, v, step)).join('')}</div>`;
const field = (label, html) => `<label class="field"><span>${label}</span>${html}</label>`;
const options = (list, value) => list.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(l)}</option>`).join('');

function signalOptions(current) {
  const list = [['', '— select —']];
  state.axes.forEach((a) => list.push([`axis:${a}`, `Axis ${a}`]));
  state.kins.forEach((k) => KIN_COORDS.forEach((c, i) => list.push([`kin:${k}:${i}`, `Kin ${k} · ${c}`])));
  if (current && !list.some(([v]) => v === current)) list.push([current, `${current} (offline)`]);
  return options(list, current);
}

function renderInspector() {
  const el = $('#inspector');
  const sel = state.selection;
  if (!sel) { el.innerHTML = '<p class="hint">Select a part, frame or point.</p>'; return; }
  if (sel.kind === 'part') return renderPartInspector(el, partById(sel.id));
  if (sel.kind === 'frame') return renderFrameInspector(el, sel.id);
  if (sel.kind === 'point') return renderPointInspector(el, state.motion.points[sel.id]);
}

function renderPartInspector(el, part) {
  if (!part) { el.innerHTML = ''; return; }
  const blocked = descendants(part.id);
  const parents = [['', 'World'], ...state.scene.parts.filter((p) => p.id !== part.id && !blocked.has(p.id)).map((p) => [p.id, p.name])];
  const m = part.motion || { type: '' };
  const isAxis = m.type === 'linear' || m.type === 'rotary';
  el.innerHTML = `
    <fieldset><legend>Part</legend>
      ${field('Name', `<input type="text" data-path="name" value="${esc(part.name)}">`)}
      ${field('Model', `<select data-path="model">${options(state.models.map((x) => [x.name, x.name]).concat(state.models.some((x) => x.name === part.model) ? [] : [[part.model, part.model + ' (missing)']]), part.model)}</select>`)}
      ${field('Attached to', `<select data-action="parent">${options(parents, part.parent || '')}</select>`)}
    </fieldset>
    <fieldset><legend>Placement (in parent, mm / °)</legend>
      ${field('Position', xyz('position', part.position, 1))}
      ${field('Rotation', xyz('rotation', part.rotation, 1))}
    </fieldset>
    <fieldset><legend>Rotation point (STL coordinates)</legend>
      ${field('Point', `<div class="xyz">${part.pivot.map((v, i) => `<input type="number" step="1" data-pivot="${i}" value="${+(+v).toFixed(4)}">`).join('')}</div>`)}
      <div class="row">
        <button class="small" data-action="pivot-center" title="Centre of the STL's bounding box">Model centre</button>
        <button class="small" data-action="pivot-bottom" title="Centre of the bottom face of the bounding box">Bottom centre</button>
        <button class="small" data-action="pivot-origin" title="Origin of the STL file">STL origin</button>
      </div>
      <p class="hint">The part rotates about this point, and the gizmo sits on it. Changing it keeps the part in place.</p>
    </fieldset>
    <fieldset><legend>Motion</legend>
      ${field('Driven by', `<select data-path="motion.type" data-action="motion-type">${options([['', 'Nothing (static)'], ['linear', 'Linear axis'], ['rotary', 'Rotary axis'], ['tcp', 'Kinematics TCP (follows X/Y/Z)']], m.type)}</select>`)}
      ${isAxis ? `
        ${field('Signal', `<select data-path="motion.signal">${signalOptions(m.signal)}</select>`)}
        ${field('Direction', `<select data-path="motion.direction">${options(AXIS_DIRS.map((d) => [d, `${m.type === 'rotary' ? 'about' : 'along'} local ${d.toUpperCase()}`]), m.direction)}</select>`)}
        ${field('Scale', num('motion.scale', m.scale ?? 1, 0.001))}
        ${field('Offset', num('motion.offset', m.offset ?? 0, 0.1))}
        <label class="field"><span>Invert</span><input type="checkbox" data-path="motion.invert"${m.invert ? ' checked' : ''}></label>
        ${field('Value', `<span class="readout" id="motion-readout">–</span>`)}
        ${!state.liveEnabled && m.signal ? field('Manual', `<input type="range" data-manual="${esc(m.signal)}" min="${m.type === 'rotary' ? -360 : -1000}" max="${m.type === 'rotary' ? 360 : 1000}" step="0.5" value="${state.manual[m.signal] ?? 0}">`) : ''}
      ` : ''}
      ${m.type === 'tcp' ? `
        ${field('Kinematics', `<select data-path="motion.kin">${options([['', '— select —'], ...state.kins.map((k) => [k, k])].concat(m.kin && !state.kins.includes(m.kin) ? [[m.kin, m.kin + ' (offline)']] : []), m.kin)}</select>`)}
        ${field('In frame', `<select data-path="motion.frame">${options(Object.keys(state.scene.frames).map((f) => [f, f]), m.frame || 'MCS')}</select>`)}
        ${field('TCP', `<span class="readout" id="motion-readout">–</span>`)}
        <p class="hint">Set the <em>Rotation point</em> on the tool tip so it sits on the TCP.</p>
      ` : ''}
    </fieldset>
    <fieldset><legend>Appearance</legend>
      <div class="row">
        <input type="color" data-path="color" value="${esc(part.color)}" title="Colour">
        <label class="row muted">Opacity <input type="range" min="0.1" max="1" step="0.05" data-path="opacity" value="${part.opacity}"></label>
      </div>
      ${field('STL scale', num('modelScale', part.modelScale, 0.001))}
      <details><summary>STL orientation / extra offset</summary>
        ${field('Position', xyz('meshOffset.position', part.meshOffset.position, 1))}
        ${field('Rotation', xyz('meshOffset.rotation', part.meshOffset.rotation, 1))}
      </details>
    </fieldset>
    <div class="row">
      <button class="small" data-action="duplicate">Duplicate</button>
      <button class="small" data-action="drop">Drop to parent Z=0</button>
      <span class="spacer"></span>
      <button class="small danger" data-action="delete">Delete</button>
    </div>`;
  el.dataset.kind = 'part';
  el.dataset.id = part.id;
}

function renderFrameInspector(el, name) {
  const f = state.scene.frames[name];
  const parents = [['', 'World'], ...state.scene.parts.map((p) => [p.id, p.name])];
  el.innerHTML = `
    <fieldset><legend>Coordinate frame ${esc(name)}</legend>
      ${field('Attached to', `<select data-action="parent">${options(parents, f.parent || '')}</select>`)}
      ${field('Position', xyz('position', f.position, 1))}
      ${field('Rotation', xyz('rotation', f.rotation, 1))}
      <p class="hint">Teach points and areas defined in <b>${esc(name)}</b> are drawn relative to this frame. Place MCS at the machine zero.</p>
    </fieldset>
    ${name === 'MCS' ? '' : '<div class="row"><span class="spacer"></span><button class="small danger" data-action="delete">Delete frame</button></div>'}`;
  el.dataset.kind = 'frame';
  el.dataset.id = name;
}

function renderPointInspector(el, point) {
  if (!point) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <fieldset><legend>Teach point</legend>
      ${field('Name', `<b>${esc(point.name)}</b>`)}
      ${field('System', esc(point.referenceSystem))}
      ${point.kin ? field('Kinematics', esc(point.kin)) : ''}
      ${point.description ? field('Description', esc(point.description)) : ''}
      ${point.entries.map((e, i) => field(esc(e.meaning || KIN_COORDS[i] || `#${i}`), `<span class="readout">${fmt(e.value, 3)} ${esc(e.unit)}</span>`)).join('')}
      ${field('Source', `<code>${esc(point.source)}</code>`)}
    </fieldset>`;
  el.dataset.kind = 'point';
}

function currentData() {
  const { kind, id } = $('#inspector').dataset;
  return kind === 'part' ? partById(id) : kind === 'frame' ? state.scene.frames[id] : null;
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]] ??= {};
  o[keys[keys.length - 1]] = value;
}

function refreshData(data) {
  const { kind, id } = $('#inspector').dataset;
  if (kind === 'part') syncPart(data);
  else if (kind === 'frame') { syncFrame(id); }
  setDirty();
}

$('#inspector').addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.manual) { state.manual[t.dataset.manual] = +t.value; return; }
  if (t.dataset.pivot !== undefined) {
    const part = partById($('#inspector').dataset.id);
    const pivot = [...$('#inspector').querySelectorAll('[data-pivot]')].map((i) => +i.value);
    if (part && pivot.every(Number.isFinite)) { setPivot(part, pivot); updatePoseInputs(part); }
    return;
  }
  const data = currentData();
  if (!data || !t.dataset.path || t.dataset.action) return;
  if (t.tagName === 'SELECT') return; // handled on change
  const value = t.type === 'checkbox' ? t.checked : t.type === 'number' || t.type === 'range' ? +t.value : t.value;
  if (t.type === 'number' && Number.isNaN(value)) return;
  setPath(data, t.dataset.path, value);
  refreshData(data);
  if (t.dataset.path === 'name') renderTree();
});

$('#inspector').addEventListener('change', (e) => {
  const t = e.target;
  const data = currentData();
  if (!data) return;
  const { kind, id } = $('#inspector').dataset;
  if (t.dataset.action === 'parent') {
    const obj = kind === 'part' ? nodes.get(id).joint : frames.get(id).group;
    reparent(obj, data, t.value || null);
    setDirty();
    renderTree();
    renderInspector();
    return;
  }
  if (t.dataset.action === 'motion-type') {
    const type = t.value;
    const prev = data.motion || {};
    data.motion = type ? { signal: prev.signal || '', direction: prev.direction || (type === 'rotary' ? 'z' : 'x'), scale: prev.scale ?? 1, offset: prev.offset ?? 0, invert: !!prev.invert, kin: prev.kin || state.kins[0] || '', frame: prev.frame || 'MCS', type } : null;
    setDirty();
    subscribe();
    renderTree();
    renderInspector();
    return;
  }
  if (t.tagName === 'SELECT' && t.dataset.path) {
    setPath(data, t.dataset.path, t.value);
    refreshData(data);
    subscribe();
    renderTree();
    if (t.dataset.path === 'model') renderModels();
  }
});

$('#inspector').addEventListener('click', (e) => {
  const action = e.target.closest('button[data-action]')?.dataset.action;
  if (!action) return;
  const { kind, id } = $('#inspector').dataset;
  if (kind === 'frame' && action === 'delete') {
    delete state.scene.frames[id];
    for (const k of Object.values(state.scene.overlay.kins)) if (k.frame === id) k.frame = 'MCS';
    rebuildAll(); setDirty(); select(null); return;
  }
  const part = partById(id);
  if (!part) return;
  if (action === 'delete') {
    if (!confirm(`Delete part "${part.name}"? Attached parts move to its parent.`)) return;
    state.scene.parts.filter((p) => p.parent === part.id).forEach((child) => reparent(nodes.get(child.id).joint, child, part.parent));
    Object.entries(state.scene.frames).filter(([, f]) => f.parent === part.id).forEach(([n, f]) => reparent(frames.get(n).group, f, part.parent));
    state.scene.parts = state.scene.parts.filter((p) => p.id !== part.id);
    rebuildAll(); setDirty(); select(null); renderModels();
  } else if (action === 'duplicate') {
    const copy = { ...structuredClone(part), id: uid(), name: part.name + ' copy' };
    copy.position = [copy.position[0] + 50, copy.position[1] + 50, copy.position[2]];
    state.scene.parts.push(copy);
    syncPart(copy); setDirty(); select('part', copy.id);
  } else if (action.startsWith('pivot-')) {
    loadGeometry(part.model).then((geo) => {
      const b = geo.boundingBox;
      const c = b.getCenter(new THREE.Vector3());
      const pivot = action === 'pivot-center' ? c.toArray() : action === 'pivot-bottom' ? [c.x, c.y, b.min.z] : [0, 0, 0];
      setPivot(part, pivot);
      renderInspector();
    });
  } else if (action === 'drop') {
    loadGeometry(part.model).then((geo) => {
      const node = nodes.get(part.id);
      withZeroMotion(() => {
        const box = new THREE.Box3().setFromObject(node.holder);
        const parentObj = node.joint.parent;
        const minLocal = parentObj.worldToLocal(box.min.clone());
        part.position[2] = +(part.position[2] - minLocal.z).toFixed(3);
      });
      syncPart(part); setDirty(); renderInspector();
    });
  }
});

function updatePoseInputs(data) {
  const el = $('#inspector');
  ['position', 'rotation'].forEach((k) => data[k].forEach((v, i) => {
    const input = el.querySelector(`input[data-path="${k}.${i}"]`);
    if (input && document.activeElement !== input) input.value = +v.toFixed(3);
  }));
}

function updateReadouts() {
  const out = $('#motion-readout');
  const sel = state.selection;
  if (out && sel?.kind === 'part') {
    const m = partById(sel.id)?.motion;
    if (m?.type === 'tcp') {
      const p = m.kin && kinPosition(m.kin);
      out.textContent = p ? `${fmt(p.x, 1)}  ${fmt(p.y, 1)}  ${fmt(p.z, 1)}` : 'no data';
    } else if (m) {
      const v = signalValue(m.signal);
      out.textContent = v === undefined ? 'no data' : `${fmt(v, 3)} ${m.type === 'rotary' ? '°' : 'mm'}`;
    }
  }
  for (const name of state.kins) {
    const el = document.querySelector(`[data-kin-readout="${CSS.escape(name)}"]`);
    if (!el) continue;
    const p = kinPosition(name);
    const v = kinVisuals.get(name);
    el.textContent = p ? `X ${fmt(p.x, 2)}   Y ${fmt(p.y, 2)}   Z ${fmt(p.z, 2)}` : 'no data';
    const box = el.closest('.kin');
    const vio = v?.violations || [];
    box.classList.toggle('violation', vio.length > 0);
    box.querySelector('.vio').textContent = vio.length ? `⚠ in violation: ${vio.join(', ')}` : '';
  }
}

// Motion panel (kinematics / points / areas)
function renderMotionPanel() {
  const ov = state.scene.overlay;
  const frameOpts = (v) => options(Object.keys(state.scene.frames).map((f) => [f, f]), v);
  $('#tab-kins').innerHTML = state.kins.length ? state.kins.map((k) => {
    const c = kinSettings(k);
    return `<div class="kin" data-kin="${esc(k)}">
      <div class="row"><input type="checkbox" data-kset="show"${c.show ? ' checked' : ''} title="Show TCP"><b class="name">${esc(k)}</b>
        <input type="color" data-kset="color" value="${esc(c.color)}" title="Colour"></div>
      <div class="readout" data-kin-readout="${esc(k)}">–</div>
      ${state.liveEnabled ? '' : [0, 1, 2].map((i) => `<label class="field"><span>Manual ${'XYZ'[i]}</span><input type="range" data-manual="kin:${esc(k)}:${i}" min="-1000" max="1000" step="1" value="${state.manual[`kin:${k}:${i}`] ?? 0}"></label>`).join('')}
      <div class="row muted">Frame <select data-kset="frame">${frameOpts(c.frame)}</select>
        <label class="row"><input type="checkbox" data-kset="trail"${c.trail ? ' checked' : ''}> Trail</label>
        <button class="small ghost" data-kclear>Clear</button></div>
      <div class="vio errors"></div>
    </div>`;
  }).join('') + `<label class="row muted">Trail length <input type="number" id="trail-len" min="10" max="4000" step="50" value="${ov.trailLength}" style="width:80px"> samples</label>`
    : '<p class="hint">No kinematics found under motion/kin.</p>';

  const pts = state.motion.points;
  const groups = new Map();
  pts.forEach((p, i) => { const g = pointGroup(p); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(i); });
  const filter = $('#point-filter')?.value || '';
  $('#tab-points').innerHTML = `<div class="row"><label class="row"><input type="checkbox" id="show-points"${ov.showPoints ? ' checked' : ''}> Show teach points</label>
      <span class="spacer"></span>
      <label class="row muted">Labels <select id="point-labels">${options([['all', 'All'], ['selected', 'Selected only'], ['none', 'None']], ov.pointLabels)}</select></label></div>` +
    (pts.length ? `<div class="row"><input type="search" id="point-filter" placeholder="Filter points…" value="${esc(filter)}" style="flex:1">
        <button class="small ghost" data-points-all="1">All</button><button class="small ghost" data-points-all="0">None</button></div>` +
      [...groups].map(([g, idx]) => {
        const shown = idx.filter((i) => !ov.hiddenPoints.includes(pointKey(pts[i]))).length;
        return `<div class="point-group${ov.showPoints ? '' : ' off'}">
        <label class="group-head"><input type="checkbox" data-point-group="${esc(g)}"${ov.hiddenPointGroups.includes(g) ? '' : ' checked'}>
          <b>${esc(g)}</b><span class="muted">${shown}/${idx.length}</span></label>
        ${idx.map((i) => { const p = pts[i]; return `<div class="item clickable${isSelected('point', i) ? ' selected' : ''}" data-point="${i}" data-filter="${esc(p.name.toLowerCase())}">
          <input type="checkbox" data-point-key="${esc(pointKey(p))}"${ov.hiddenPoints.includes(pointKey(p)) ? '' : ' checked'}${pointFrame(p) ? '' : ' disabled'}>
          <span class="name" title="${esc(p.description || p.name)}">${esc(p.name)}</span>
          <span class="muted readout">${pointFrame(p) ? pointXYZ(p).toArray().map((v) => fmt(v, 1)).join(' / ') : esc(p.referenceSystem) + ' – not drawn'}</span></div>`; }).join('')}
      </div>`;
      }).join('')
      : '<p class="hint">No teach points found. Check the node addresses in Settings.</p>');
  applyPointFilter();

  const areas = state.motion.safeAreas;
  $('#tab-areas').innerHTML = `<div class="row"><label class="row"><input type="checkbox" id="show-areas"${ov.showAreas ? ' checked' : ''}> Show ${areas.length} areas</label>
      <span class="spacer"></span><label class="row muted"><input type="checkbox" id="area-labels"${ov.areaLabels ? ' checked' : ''}> Labels</label></div>` +
    (areas.length ? areas.map((a) => {
      const color = '#' + (AREA_COLORS[a.type] ?? 0x888888).toString(16).padStart(6, '0');
      const ok = drawable(a.coordSystem) && a.box.length === 3;
      return `<div class="item">
        <input type="checkbox" data-area="${esc(areaKey(a))}"${ov.hiddenAreas.includes(areaKey(a)) ? '' : ' checked'}${ok ? '' : ' disabled'}>
        <span class="name" title="${esc(a.source)}">${esc(a.name)}</span>
        <span class="type-badge" style="background:${color}">${AREA_LABELS[a.type] || esc(a.type)}</span>
        <span class="muted">${esc(a.coordSystem)}${ok ? '' : ' – add a frame'}</span></div>`;
    }).join('') + `<label class="row muted">Open sides drawn to ±<input type="number" id="area-extent" min="100" step="100" value="${ov.areaExtent}" style="width:80px"> mm</label>`
      : '<p class="hint">No safe or work areas found. Check the node addresses in Settings.</p>');

  $('#motion-errors').textContent = state.motion.errors.join('\n');
}

document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  ['kins', 'points', 'areas'].forEach((t) => ($(`#tab-${t}`).hidden = t !== b.dataset.tab));
}));

$('#tab-kins').addEventListener('input', (e) => {
  if (e.target.dataset.manual) state.manual[e.target.dataset.manual] = +e.target.value;
});
$('#tab-kins').addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'trail-len') { state.scene.overlay.trailLength = Math.max(10, +t.value || 600); setDirty(); return; }
  const k = t.closest('[data-kin]')?.dataset.kin;
  if (!k || !t.dataset.kset) return;
  kinSettings(k)[t.dataset.kset] = t.type === 'checkbox' ? t.checked : t.value;
  ensureKinVisual(k);
  if (t.dataset.kset === 'frame') { buildOverlays(); renderMotionPanel(); }
  setDirty();
});
$('#tab-kins').addEventListener('click', (e) => {
  const k = e.target.closest('[data-kclear]') && e.target.closest('[data-kin]')?.dataset.kin;
  if (k) { const v = kinVisuals.get(k); v.points = []; v.trail.geometry.setDrawRange(0, 0); }
});
function applyPointFilter() {
  const q = ($('#point-filter')?.value || '').trim().toLowerCase();
  document.querySelectorAll('#tab-points [data-filter]').forEach((el) => (el.hidden = !!q && !el.dataset.filter.includes(q)));
}
const toggleIn = (list, key, on) => { const out = list.filter((x) => x !== key); if (!on) out.push(key); return out; };

$('#tab-points').addEventListener('input', (e) => { if (e.target.id === 'point-filter') applyPointFilter(); });
$('#tab-points').addEventListener('change', (e) => {
  const t = e.target, ov = state.scene.overlay;
  if (t.id === 'point-filter') return;
  if (t.id === 'show-points') ov.showPoints = t.checked;
  else if (t.id === 'point-labels') ov.pointLabels = t.value;
  else if (t.dataset.pointGroup !== undefined) ov.hiddenPointGroups = toggleIn(ov.hiddenPointGroups, t.dataset.pointGroup, t.checked);
  else if (t.dataset.pointKey !== undefined) ov.hiddenPoints = toggleIn(ov.hiddenPoints, t.dataset.pointKey, t.checked);
  else return;
  buildOverlays();
  renderMotionPanel();
  setDirty();
});
$('#tab-points').addEventListener('click', (e) => {
  const all = e.target.closest('[data-points-all]')?.dataset.pointsAll;
  if (all !== undefined) {
    // All / None act on the points the filter currently shows
    const ov = state.scene.overlay;
    const keys = [...document.querySelectorAll('#tab-points [data-point]:not([hidden]) [data-point-key]')].map((el) => el.dataset.pointKey);
    for (const k of keys) ov.hiddenPoints = toggleIn(ov.hiddenPoints, k, all === '1');
    if (all === '1') ov.hiddenPointGroups = [];
    buildOverlays(); renderMotionPanel(); setDirty();
    return;
  }
  if (e.target.matches('input')) return;
  const i = e.target.closest('[data-point]')?.dataset.point;
  if (i !== undefined) select('point', +i);
});
$('#tab-areas').addEventListener('change', (e) => {
  const ov = state.scene.overlay;
  if (e.target.id === 'show-areas') ov.showAreas = e.target.checked;
  else if (e.target.id === 'area-labels') ov.areaLabels = e.target.checked;
  else if (e.target.id === 'area-extent') ov.areaExtent = Math.max(100, +e.target.value || 1000);
  else if (e.target.dataset.area) {
    const key = e.target.dataset.area;
    ov.hiddenAreas = ov.hiddenAreas.filter((x) => x !== key);
    if (!e.target.checked) ov.hiddenAreas.push(key);
  }
  buildOverlays();
  setDirty();
});

// ---------------------------------------------------------------------------------------
// Live data: WebSocket with HTTP polling fallback
// ---------------------------------------------------------------------------------------
let ws = null;
let wsFailures = 0;
let pollTimer = null;
let polling = false;

function subscription() {
  // Run mode lists every axis and kinematics
  if (state.appMode === 'run') return { axes: [...state.axes], kins: [...state.kins] };
  const axes = new Set();
  const kins = new Set(state.kins.filter((k) => kinSettings(k).show));
  for (const p of state.scene?.parts || []) {
    const m = p.motion;
    if (!m) continue;
    if (m.type === 'tcp' && m.kin) kins.add(m.kin);
    const [kind, name] = (m.signal || '').split(':');
    if (m.type !== 'tcp' && kind === 'axis') axes.add(name);
    if (m.type !== 'tcp' && kind === 'kin') kins.add(name);
  }
  return { axes: [...axes], kins: [...kins] };
}

function subscribe() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(subscription()));
}

function onSample(msg) {
  state.live.axes = msg.axes || {};
  state.live.kins = msg.kins || {};
}

function connectWs() {
  const url = new URL('api/ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (TOKEN) url.searchParams.set('token', TOKEN);
  ws = new WebSocket(url);
  ws.onopen = () => { wsFailures = 0; stopPolling(); subscribe(); };
  ws.onmessage = (e) => onSample(JSON.parse(e.data));
  ws.onclose = () => {
    ws = null;
    if (++wsFailures >= 3) startPolling();
    // keep trying the WebSocket (slower once polling has taken over)
    setTimeout(connectWs, wsFailures >= 3 ? 10000 : 1500);
  };
}

function startPolling() {
  if (pollTimer) return;
  console.warn('WebSocket unavailable, polling instead');
  pollTimer = setInterval(async () => {
    const sub = subscription();
    if (polling || (!sub.axes.length && !sub.kins.length)) return;
    polling = true; // never stack requests while the server is slow or down
    try { onSample(await api(`api/values?axes=${encodeURIComponent(sub.axes.join(','))}&kins=${encodeURIComponent(sub.kins.join(','))}`)); } catch { /* keep trying */ }
    polling = false;
  }, 100);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

async function refreshStatus() {
  const el = $('#status');
  try {
    const s = await api('api/status');
    el.textContent = s.source === 'simulation' ? 'Simulation' : s.connected ? 'Data Layer connected' : 'Data Layer offline';
    el.className = 'badge ' + (s.source === 'simulation' ? 'sim' : s.connected ? 'ok' : 'err');
    el.title = `App version ${s.version}` + (s.message ? '\n' + s.message : '');
    $('#app-version').textContent = 'v' + s.version;
  } catch (err) {
    const auth = /token|session/i.test(err.message);
    el.textContent = auth ? 'Not logged in' : 'Server unreachable';
    el.className = 'badge err';
    el.title = err.message;
  }
}

async function refreshAxes() {
  try {
    const res = await api('api/axes');
    const changed = JSON.stringify([res.axes, res.kins]) !== JSON.stringify([state.axes, state.kins]);
    state.axes = res.axes;
    state.kins = res.kins;
    if (changed) { subscribe(); renderMotionPanel(); renderInspector(); renderRunPanel(); }
  } catch { /* status badge reports it */ }
}

async function refreshMotionObjects(force = false) {
  let motion;
  try {
    motion = await api('api/motion-objects');
  } catch (err) {
    motion = { safeAreas: [], points: [], errors: [err.message], nodes: {} };
  }
  // The periodic reload only redraws when ctrlX MOTION actually changed something
  if (!force && JSON.stringify(motion) === JSON.stringify(state.motion)) return;
  state.motion = motion;
  buildOverlays();
  renderMotionPanel();
}
$('#btn-refresh').addEventListener('click', () => { refreshAxes(); refreshMotionObjects(true); });

// ---------------------------------------------------------------------------------------
// Toolbar, settings, save
// ---------------------------------------------------------------------------------------
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
function setMode(mode) {
  gizmo.setMode(mode);
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
}
$('#btn-space').addEventListener('click', toggleSpace);
function toggleSpace() {
  gizmo.setSpace(gizmo.space === 'local' ? 'world' : 'local');
  $('#btn-space').textContent = gizmo.space === 'local' ? 'Local' : 'World';
}
gizmo.setSpace('local');
$('#btn-snap').addEventListener('click', (e) => {
  const on = !e.currentTarget.classList.contains('active');
  e.currentTarget.classList.toggle('active', on);
  gizmo.setTranslationSnap(on ? 5 : null);
  gizmo.setRotationSnap(on ? 15 * DEG : null);
});
$('#btn-fit').addEventListener('click', fitView);
$('#btn-labels').addEventListener('click', (e) => {
  const on = !e.currentTarget.classList.contains('active');
  e.currentTarget.classList.toggle('active', on);
  labelRenderer.domElement.style.display = on ? '' : 'none';
});
$('#btn-live').addEventListener('click', (e) => {
  state.liveEnabled = !state.liveEnabled;
  e.currentTarget.classList.toggle('active', state.liveEnabled);
  e.currentTarget.textContent = state.liveEnabled ? 'Live' : 'Manual';
  renderInspector();
  renderMotionPanel();
});

// ---------------------------------------------------------------------------------------
// Edit / Run mode and collapsible side panels
// ---------------------------------------------------------------------------------------
// Which panels are open is remembered per mode in this browser
const PANEL_DEFAULTS = { edit: { left: true, right: true }, run: { left: false, right: true } };
let panels = PANEL_DEFAULTS;
try { panels = { ...PANEL_DEFAULTS, ...JSON.parse(localStorage.getItem('3dviewer.panels') || '{}') }; } catch { /* defaults */ }

function applyPanels() {
  const p = panels[state.appMode];
  document.body.classList.toggle('hide-left', !p.left);
  document.body.classList.toggle('hide-right', !p.right);
  $('#btn-left').setAttribute('aria-pressed', String(p.left));
  $('#btn-right').setAttribute('aria-pressed', String(p.right));
}

function togglePanel(side) {
  const p = panels[state.appMode];
  panels = { ...panels, [state.appMode]: { ...p, [side]: !p[side] } };
  try { localStorage.setItem('3dviewer.panels', JSON.stringify(panels)); } catch { /* not kept */ }
  applyPanels();
}
$('#btn-left').addEventListener('click', () => togglePanel('left'));
$('#btn-right').addEventListener('click', () => togglePanel('right'));

function setAppMode(mode) {
  state.appMode = mode;
  document.body.classList.toggle('mode-run', mode === 'run');
  document.querySelectorAll('[data-app-mode]').forEach((b) => b.classList.toggle('active', b.dataset.appMode === mode));
  if (mode === 'run' && !state.liveEnabled) $('#btn-live').click(); // run mode always follows the machine
  try { localStorage.setItem('3dviewer.mode', mode); } catch { /* not kept */ }
  attachGizmo();
  applyPanels();
  renderRunPanel();
  subscribe();
}
document.querySelectorAll('[data-app-mode]').forEach((b) => b.addEventListener('click', () => setAppMode(b.dataset.appMode)));

function renderRunPanel() {
  $('#run-axes').innerHTML = state.axes.length
    ? state.axes.map((a) => `<tr><td>${esc(a)}</td><td class="val" data-run-axis="${esc(a)}">–</td></tr>`).join('')
    : '<tr><td class="hint">No axes found under motion/axs.</td></tr>';
  $('#run-kins').innerHTML = state.kins.length
    ? state.kins.map((k) => `<div class="run-kin" data-run-kin="${esc(k)}" style="--c:${esc(kinSettings(k).color)}">
        <b>${esc(k)}</b><table class="live-table"></table><div class="vio"></div></div>`).join('')
    : '<p class="hint">No kinematics found under motion/kin.</p>';
}

function updateRunReadouts() {
  for (const el of document.querySelectorAll('[data-run-axis]')) {
    el.textContent = fmt(state.live.axes[el.dataset.runAxis], 3);
  }
  for (const box of document.querySelectorAll('[data-run-kin]')) {
    const name = box.dataset.runKin;
    const k = state.live.kins[name];
    const table = box.querySelector('table');
    table.innerHTML = k?.pos?.length
      ? k.pos.map((v, i) => `<tr><td>${KIN_COORDS[i] || i + 1}</td><td class="val">${fmt(v, 3)}</td><td class="unit">${esc(k.units?.[i] || '')}</td></tr>`).join('')
      : '<tr><td class="hint">no data</td></tr>';
    const vio = kinVisuals.get(name)?.violations || [];
    box.classList.toggle('violation', vio.length > 0);
    box.querySelector('.vio').textContent = vio.length ? `⚠ in violation: ${vio.join(', ')}` : '';
  }
}

async function save() {
  try {
    await api('api/scene', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.scene) });
    setDirty(false);
    toast('Scene saved on the core');
  } catch (err) { toast(`Save failed: ${err.message}`, true); }
}
$('#btn-save').addEventListener('click', save);

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (e.target.closest('input, textarea, select, dialog')) return;
  const k = e.key.toLowerCase();
  if (k === 'f') { fitView(); return; }
  if (state.appMode === 'run') return;
  if (k === 'w') setMode('translate');
  else if (k === 'e') setMode('rotate');
  else if (k === 'q') toggleSpace();
  else if (k === 'f') fitView();
  else if (k === 'escape') select(null);
});
window.addEventListener('beforeunload', (e) => { if (state.dirty) e.preventDefault(); });

const dialog = $('#settings');
$('#btn-settings').addEventListener('click', async () => {
  const s = await api('api/settings');
  $('#set-areas').value = s.safeAreaNodes.join('\n');
  $('#set-points').value = s.pointNodes.join('\n');
  $('#set-auto').checked = s.autoDiscover;
  showDiscovered(state.motion.nodes);
  dialog.showModal();
});
function showDiscovered(nodesFound) {
  const n = nodesFound || {};
  $('#discovered').textContent = `Safe areas:\n  ${(n.safeAreas || []).join('\n  ') || '–'}\nTeach points:\n  ${(n.points || []).join('\n  ') || '–'}`;
}
$('#btn-discover').addEventListener('click', async () => {
  $('#discovered').textContent = 'Searching motion/ …';
  try { showDiscovered(await api('api/discover', { method: 'POST' })); } catch (err) { $('#discovered').textContent = err.message; }
});
dialog.addEventListener('close', async () => {
  if (dialog.returnValue !== 'save') return;
  const lines = (id) => $(id).value.split('\n').map((s) => s.trim()).filter(Boolean);
  await api('api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ safeAreaNodes: lines('#set-areas'), pointNodes: lines('#set-points'), autoDiscover: $('#set-auto').checked }) });
  refreshMotionObjects(true);
});

// ---------------------------------------------------------------------------------------
// Main loop and start-up
// ---------------------------------------------------------------------------------------
let lastReadout = 0;
function animate(t) {
  requestAnimationFrame(animate);
  if (state.scene) {
    if (!gizmo.dragging) applyMotion();
    updateKinematics();
    highlightViolatedAreas();
    if (t - lastReadout > 100) {
      if (state.appMode === 'run') updateRunReadouts(); else updateReadouts();
      lastReadout = t;
    }
  }
  orbit.update();
  if (!Number.isFinite(camera.position.lengthSq()) || !Number.isFinite(orbit.target.lengthSq())) {
    orbit.target.set(0, 0, 150);
    camera.position.set(1400, -1600, 1100);
    fitView();
  }
  renderer.render(scene3d, camera);
  labelRenderer.render(scene3d, camera);
  if (state.scene) declutterLabels(t);
}

async function start() {
  resize();
  requestAnimationFrame(animate);
  try {
    const [doc, models] = await Promise.all([api('api/scene'), api('api/models')]);
    state.scene = normalizeScene(doc);
    state.models = models;
  } catch (err) {
    toast(`Could not load scene: ${err.message}`, true);
    state.scene = normalizeScene({});
  }
  rebuildAll();
  renderModels();
  renderTree();
  renderInspector();
  await Promise.all([refreshStatus(), refreshAxes()]);
  renderMotionPanel();
  let mode = 'edit';
  try { mode = localStorage.getItem('3dviewer.mode') === 'run' ? 'run' : 'edit'; } catch { /* edit */ }
  setAppMode(mode);
  refreshMotionObjects(true);
  connectWs();
  if (state.scene.parts.length) setTimeout(fitView, 300);
  setInterval(refreshStatus, 5000);
  setInterval(refreshAxes, 15000);
  setInterval(refreshMotionObjects, 30000);
}
window.__stlm = { state, nodes, frames, scene3d, camera };
start();
