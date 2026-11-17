// 3D view (three.js). World mapping: three.x = X - L/2, three.y = Z (from floor), three.z = -(Y - W/2)
import * as THREE from '../vendor/three.module.min.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { layerBases, aabb } from './geom.js';

export class View3D {
  constructor(el, app) {
    this.el = el; this.app = app;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    this.renderer.setClearColor(0x0e1318);
    el.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 10, 50000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.addEventListener('change', () => this.render());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4); sun.position.set(1500, 3000, 2000); this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(-2000, 1000, -1500); this.scene.add(fill);
    const grid = new THREE.GridHelper(6000, 60, 0x2a3540, 0x1a222b); this.scene.add(grid);
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.texCache = new Map();
    this.boxGeo = new Map();
    new ResizeObserver(() => this.resize()).observe(el);
    this.resetView();
  }

  resize() {
    const r = this.el.getBoundingClientRect(); if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height, false);
    this.renderer.domElement.style.width = r.width + 'px'; this.renderer.domElement.style.height = r.height + 'px';
    this.camera.aspect = r.width / r.height; this.camera.updateProjectionMatrix();
    this.render();
  }

  resetView() {
    const p = this.app.pallet(), P = this.app.project;
    const { top } = layerBases(P.layers, this.app.types, P.settings.slip);
    const H = p.H + Math.max(top, 300);
    const d = Math.max(p.L, p.W, H) * 1.9;
    this.camera.position.set(d * 0.8, H * 0.5 + d * 0.55, d * 0.95);
    this.controls.target.set(0, H * 0.45, 0);
    this.controls.update(); this.render();
  }

  render() { if (this.el.offsetParent !== null) this.renderer.render(this.scene, this.camera); }

  clearRoot() {
    this.root.traverse((o) => { if (o.material && o.userData.own) { (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose()); } if (o.geometry && o.userData.ownGeo) o.geometry.dispose(); });
    this.root.clear();
  }

  // ----- textures -----
  faceTexture(t, face) { // face: 'label' | 'image'
    const key = `${t.id}|${face}|${t.color}|${t.labelSide}|${t.L}|${t.W}|${t.H}|${t.image ? t.image.length : 0}`;
    if (this.texCache.has(key)) return this.texCache.get(key);
    let tex;
    if (face === 'image') {
      const img = this.app.images.get(t.id);
      tex = new THREE.Texture(img); tex.colorSpace = THREE.SRGBColorSpace;
      if (img.complete) tex.needsUpdate = true; else img.addEventListener('load', () => { tex.needsUpdate = true; this.render(); }, { once: true });
    } else {
      const fw = t.labelSide === 'left' || t.labelSide === 'right' ? t.W : t.L;
      const cw = 512, ch = Math.max(64, Math.round(512 * t.H / fw));
      const c = document.createElement('canvas'); c.width = cw; c.height = Math.min(ch, 1024);
      const g = c.getContext('2d');
      g.fillStyle = t.color || '#c8a26b'; g.fillRect(0, 0, c.width, c.height);
      const img = this.app.images.get(t.id);
      if (img && img.complete && t.imageMode === 'label') g.drawImage(img, 0, 0, c.width, c.height);
      else {
        const lw = c.width * 0.6, lh = Math.min(c.height * 0.55, lw * 0.6);
        const x0 = (c.width - lw) / 2, y0 = (c.height - lh) / 2;
        g.fillStyle = '#fff'; g.fillRect(x0, y0, lw, lh);
        g.fillStyle = '#2fb4c8'; g.fillRect(x0, y0, lw, lh * 0.16);
        g.fillStyle = '#111';
        let x = x0 + lw * 0.08, k = 0;
        while (x < x0 + lw * 0.92) { const sw = k % 3 === 0 ? 5 : 2.5; if (k % 2 === 0) g.fillRect(x, y0 + lh * 0.28, sw, lh * 0.45); x += sw + ((k * 7) % 3 + 1) * 2; k++; }
        g.font = `bold ${Math.round(lh * 0.14)}px sans-serif`; g.textAlign = 'center'; g.fillText((t.name || 'LABEL').slice(0, 22), c.width / 2, y0 + lh * 0.9);
        g.strokeStyle = '#111'; g.lineWidth = 3; g.strokeRect(x0, y0, lw, lh);
      }
      tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    }
    tex.anisotropy = 4;
    this.texCache.set(key, tex);
    return tex;
  }

  materialsFor(t, opacity) {
    const col = new THREE.Color(t.color || '#c8a26b');
    const plain = () => new THREE.MeshStandardMaterial({ color: col, roughness: 0.85, transparent: opacity < 1, opacity });
    const tex = (map) => new THREE.MeshStandardMaterial({ map, roughness: 0.85, transparent: opacity < 1, opacity });
    const hasImg = !!(t.image && this.app.images.get(t.id));
    const mats = [plain(), plain(), plain(), plain(), plain(), plain()];
    if (hasImg && t.imageMode === 'all') for (let i = 0; i < 6; i++) mats[i] = tex(this.faceTexture(t, 'image'));
    if (hasImg && t.imageMode === 'top') mats[2] = tex(this.faceTexture(t, 'image'));
    const li = { right: 0, left: 1, front: 4, back: 5 }[t.labelSide];
    if (li !== undefined) mats[li] = tex(this.faceTexture(t, 'label'));
    return mats;
  }

  // ----- scene build -----
  update() {
    const app = this.app, p = app.pallet(), types = app.types, proj = app.project;
    this.clearRoot();
    const wood = new THREE.MeshStandardMaterial({ color: 0xa07c4f, roughness: 0.95 });
    const woodDark = new THREE.MeshStandardMaterial({ color: 0x7d5e38, roughness: 0.95 });
    const addBox = (sx, sy, sz, x, y, z, m) => { const ms = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m); ms.position.set(x, y, z); ms.userData.ownGeo = true; this.root.add(ms); };
    // pallet: top deck boards along X, cross boards, blocks, bottom boards
    const tb = Math.min(22, p.H * 0.16), H = p.H;
    const nb = p.W > 900 ? 7 : 5, bw = p.W / (nb * 1.45), gap = (p.W - nb * bw) / (nb - 1);
    for (let i = 0; i < nb; i++) addBox(p.L, tb, bw, 0, H - tb / 2, -(i * (bw + gap) + bw / 2 - p.W / 2), wood);
    const bl = Math.min(145, p.L * 0.13), bwid = Math.min(145, p.W * 0.15);
    const xs = [bl / 2, p.L / 2, p.L - bl / 2], ys = [bwid / 2, p.W / 2, p.W - bwid / 2];
    for (const x of xs) addBox(bl, tb, p.W, x - p.L / 2, H - tb * 1.5, 0, woodDark);
    const bh = H - tb * 3;
    for (const x of xs) for (const y of ys) addBox(bl, bh, bwid, x - p.L / 2, tb + bh / 2, -(y - p.W / 2), woodDark);
    for (const y of ys) addBox(p.L, tb, bwid, 0, tb / 2, -(y - p.W / 2), wood);

    // boxes
    const { bases, top } = layerBases(proj.layers, types, proj.settings.slip);
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x1b1b1b, transparent: true, opacity: 0.55 });
    const selEdge = new THREE.LineBasicMaterial({ color: 0xffffff });
    let maxX = p.L, minX = 0, maxY = p.W, minY = 0;
    proj.layers.forEach((layer, li) => {
      if (app.upToLayer && li > app.layerIndex) return;
      const faded = app.focusLayer && li !== app.layerIndex;
      const op = faded ? 0.18 : 1;
      for (const b of layer.boxes) {
        const t = types.get(b.typeId); if (!t) continue;
        const A = aabb(b, t); minX = Math.min(minX, A.x0); maxX = Math.max(maxX, A.x1); minY = Math.min(minY, A.y0); maxY = Math.max(maxY, A.y1);
        const gk = `${t.L}|${t.H}|${t.W}`;
        if (!this.boxGeo.has(gk)) this.boxGeo.set(gk, { g: new THREE.BoxGeometry(t.L - 1, t.H - 1, t.W - 1), e: new THREE.EdgesGeometry(new THREE.BoxGeometry(t.L - 1, t.H - 1, t.W - 1)) });
        const G = this.boxGeo.get(gk);
        const m = new THREE.Mesh(G.g, this.materialsFor(t, op)); m.userData.own = true;
        m.position.set(b.x - p.L / 2, p.H + bases[li] + t.H / 2, -(b.y - p.W / 2));
        m.rotation.y = (b.rot * Math.PI) / 180;
        const sel = li === app.layerIndex && app.selection.has(b.id);
        const e = new THREE.LineSegments(G.e, sel ? selEdge : edgeMat); m.add(e);
        if (!faded || li === app.layerIndex) this.root.add(m); else { m.renderOrder = 1; this.root.add(m); }
      }
      // slip sheet
      if (li > 0 && proj.settings.slip > 0 && (!app.upToLayer || li <= app.layerIndex)) {
        addBox(p.L - 10, proj.settings.slip, p.W - 10, 0, p.H + bases[li] - proj.settings.slip / 2, 0, new THREE.MeshStandardMaterial({ color: 0xd9cfb8, transparent: faded, opacity: faded ? 0.2 : 1 }));
      }
    });
    // active-layer outline
    if (proj.layers[app.layerIndex]) {
      const li = app.layerIndex, h = Math.max(1, layerBases([proj.layers[li]], types, 0).top);
      const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(p.L + 8, h + 4, p.W + 8));
      const ln = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x2fb4c8 })); ln.userData.ownGeo = true;
      ln.position.set(0, p.H + bases[li] + h / 2, 0); this.root.add(ln);
    }
    // overall bounding box + dimensions
    const totL = maxX - minX, totW = maxY - minY, totH = p.H + top;
    const cx = (minX + maxX) / 2 - p.L / 2, cz = -((minY + maxY) / 2 - p.W / 2);
    const bb = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(totL, totH, totW)), new THREE.LineDashedMaterial({ color: 0x8fb6c9, dashSize: 30, gapSize: 20 }));
    bb.computeLineDistances(); bb.position.set(cx, totH / 2, cz); bb.userData.ownGeo = true; this.root.add(bb);
    const s = Math.max(p.L, p.W) * 0.09;
    this.root.add(this.sprite(`${fmt(totL)} mm`, cx, -s * 0.3, cz + totW / 2 + s * 0.8, s));
    this.root.add(this.sprite(`${fmt(totW)} mm`, cx + totL / 2 + s * 1.4, -s * 0.3, cz, s));
    this.root.add(this.sprite(`H ${fmt(totH)} mm`, cx + totL / 2 + s * 1.2, totH / 2, cz + totW / 2 + s * 0.4, s));
    this.dims = { totL, totW, totH };
    this.render();
    return this.dims;
  }

  sprite(text, x, y, z, size) {
    const c = document.createElement('canvas'); c.width = 512; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(11,15,19,.85)'; roundRect(g, 4, 20, 504, 88, 16); g.fill();
    g.strokeStyle = '#2fb4c8'; g.lineWidth = 4; g.stroke();
    g.fillStyle = '#e8f6f9'; g.font = 'bold 56px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 256, 66);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
    sp.userData.own = true; sp.scale.set(size * 4, size, 1); sp.position.set(x, y, z); sp.renderOrder = 10;
    return sp;
  }
}

function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
const fmt = (v) => (Math.round(v * 10) / 10).toString();
