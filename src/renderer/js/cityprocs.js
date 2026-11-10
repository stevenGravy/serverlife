import * as THREE from 'three';
import { makeCar, spinWheels } from './cityactors.js';

/**
 * The machine's processes as traffic.
 *
 * A periodic `ps` (Get-Process on Windows), the busiest forty, and each one
 * becomes something moving around town — sized by what it is using:
 *
 *   cars    processes that are mostly CPU, driving the streets; the more CPU,
 *           the faster they go
 *   boats   processes that are mostly memory, on the river behind the town,
 *           sitting lower and longer the more they hold
 *   rockets the few that are big either way, on launch pads at the edge of
 *           town, going up again and again with a flame as big as their CPU
 *
 * Each vehicle is kept by pid between looks, so it grows and shrinks as its
 * process does rather than being replaced every few seconds, and one that
 * has exited sinks or drives off rather than blinking out.
 */

const MB = 1024 * 1024;
const ROCKET_MEM = 1.5 * 1024 * MB;
const ROCKET_CPU = 60;
const MAX_ROCKETS = 3;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sizeFor = (p) => clamp(0.7 + 0.42 * Math.log2(1 + p.mem / (64 * MB)) + p.cpu / 60, 0.6, 3.6);

function hashHue(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % 360) / 360;
}
const colorFor = (user) => new THREE.Color().setHSL(user === 'root' ? 0.0 : hashHue(user || '?'), 0.62, 0.5).getHex();

export function kindFor(p, rocketSlots) {
  if (rocketSlots > 0 && (p.mem >= ROCKET_MEM || p.cpu >= ROCKET_CPU)) return 'rocket';
  return p.mem / (100 * MB) > p.cpu ? 'boat' : 'car';
}

/* ------------------------------------------------------------------ */
/* Models                                                              */
/* ------------------------------------------------------------------ */

function makeBoat(color) {
  const g = new THREE.Group();
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x2b303a, roughness: 0.7 });
  const hull = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.1, 5.4), hullMat);
  hull.position.y = 0.35;
  const bow = new THREE.Mesh(new THREE.ConeGeometry(1.84, 2.4, 4), hullMat);
  bow.rotation.set(-Math.PI / 2, Math.PI / 4, 0);
  bow.scale.set(1, 1, 0.6);
  bow.position.set(0, 0.35, -3.9);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.64, 0.22, 5.44), new THREE.MeshStandardMaterial({ color }));
  stripe.position.y = 0.75;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.9, 1.1, 2), new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.5 }));
  cabin.position.set(0, 1.45, 0.9);
  const funnel = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.42, 1.2, 10), new THREE.MeshStandardMaterial({ color }));
  funnel.position.set(0, 2.5, 1.2);
  const wake = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 6),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }));
  wake.rotation.x = -Math.PI / 2;
  wake.position.set(0, -0.12, 5.6);
  for (const m of [hull, bow, cabin, funnel]) m.castShadow = true;
  g.add(hull, bow, stripe, cabin, funnel, wake);
  g.userData.wake = wake;
  return g;
}

function makeRocket(color) {
  const g = new THREE.Group();
  const white = new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.4, metalness: 0.3 });
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 9, 20), white);
  body.position.y = 5.5;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(1.02, 1.02, 1.2, 20), paint);
  band.position.y = 7.5;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(1, 3, 20), paint);
  nose.position.y = 11.5;
  const fins = [];
  for (let i = 0; i < 3; i++) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.15, 2.4, 1.6), paint);
    const a = (i / 3) * Math.PI * 2;
    f.position.set(Math.sin(a) * 1.2, 1.9, Math.cos(a) * 1.2);
    f.rotation.y = a;
    fins.push(f);
  }
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.85, 0.9, 14), new THREE.MeshStandardMaterial({ color: 0x3a3f4a, metalness: 0.6 }));
  nozzle.position.y = 0.65;
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.75, 4, 14, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffa23a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  flame.rotation.x = Math.PI;
  flame.position.y = -1.8;
  const core = new THREE.Mesh(new THREE.ConeGeometry(0.4, 2.4, 10, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xfff3c4, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
  core.rotation.x = Math.PI;
  core.position.y = -1;
  for (const m of [body, nose, ...fins]) m.castShadow = true;
  g.add(body, band, nose, ...fins, nozzle, flame, core);
  g.userData.flame = flame;
  g.userData.core = core;
  return g;
}

function makePad() {
  const g = new THREE.Group();
  const concrete = new THREE.MeshStandardMaterial({ color: 0x8a8f99, roughness: 0.95 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.6, metalness: 0.4 });
  const slab = new THREE.Mesh(new THREE.CylinderGeometry(7, 7.5, 0.6, 24), concrete);
  slab.position.y = 0.3;
  slab.receiveShadow = true;
  const tower = new THREE.Mesh(new THREE.BoxGeometry(1.2, 18, 1.2), steel);
  tower.position.set(4.4, 9, 0);
  const arm = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.4, 0.5), steel);
  arm.position.set(2.8, 14, 0);
  tower.castShadow = true;
  g.add(slab, tower, arm);
  return g;
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

/** A loop round a random rectangle of blocks, keeping right. */
function blockLoop({ xs, zs }, lane = 1.3) {
  const r = (n) => Math.floor(Math.random() * n);
  let i0 = r(xs.length - 1), i1 = i0 + 1 + r(xs.length - 1 - i0);
  let j0 = r(zs.length - 1), j1 = j0 + 1 + r(zs.length - 1 - j0);
  const corners = [[xs[i0], zs[j0]], [xs[i1], zs[j0]], [xs[i1], zs[j1]], [xs[i0], zs[j1]]];
  if (Math.random() < 0.5) corners.reverse();
  const n = corners.length;
  const dir = (a, b) => { const dx = Math.sign(b[0] - a[0]), dz = Math.sign(b[1] - a[1]); return [dx, dz]; };
  const right = ([a, b]) => [-b, a];
  const pts = corners.map((c, k) => {
    const din = dir(corners[(k + n - 1) % n], c), dout = dir(c, corners[(k + 1) % n]);
    const ri = right(din), ro = right(dout);
    return new THREE.Vector3(c[0] + (ri[0] + ro[0]) * lane, 0, c[1] + (ri[1] + ro[1]) * lane);
  });
  pts.push(pts[0].clone());
  const lens = [0];
  for (let k = 1; k < pts.length; k++) lens.push(lens[k - 1] + pts[k].distanceTo(pts[k - 1]));
  const length = lens[lens.length - 1];
  const at = (s) => {
    s = ((s % length) + length) % length;
    let k = 1;
    while (k < lens.length - 1 && lens[k] < s) k++;
    const t = (s - lens[k - 1]) / (lens[k] - lens[k - 1] || 1);
    return new THREE.Vector3().lerpVectors(pts[k - 1], pts[k], t);
  };
  return { length, at };
}

/* ------------------------------------------------------------------ */
/* The traffic                                                         */
/* ------------------------------------------------------------------ */

export class ProcTraffic {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.actors = new Map();     // pid -> actor
    this.layoutInfo = null;
    this.fixtures = null;
    this.time = 0;
  }

  /**
   * Where things go: the street grid, the river behind the town, and the
   * launch pads off to its east. Called whenever the city is rebuilt.
   */
  layout(info) {
    this.layoutInfo = info;
    if (this.fixtures) { this.root.remove(this.fixtures); disposeTree(this.fixtures); }
    this.fixtures = null;
    if (!info) { this.root.visible = false; return; }
    this.root.visible = true;
    const f = new THREE.Group();
    const { river, pads, night } = info;
    const water = new THREE.Mesh(new THREE.PlaneGeometry(river.x1 - river.x0, river.width),
      new THREE.MeshStandardMaterial({ color: night ? 0x1d3b5c : 0x3f86c6, roughness: 0.25, metalness: 0.2, emissive: night ? 0x0a1a2a : 0 }));
    water.rotation.x = -Math.PI / 2;
    water.position.set((river.x0 + river.x1) / 2, 0.08, river.z);
    water.receiveShadow = true;
    const bankMat = new THREE.MeshStandardMaterial({ color: night ? 0x5a5240 : 0xc9b98f, roughness: 1 });
    for (const s of [1, -1]) {
      const bank = new THREE.Mesh(new THREE.BoxGeometry(river.x1 - river.x0, 0.3, 2.5), bankMat);
      bank.position.set((river.x0 + river.x1) / 2, 0.12, river.z + s * (river.width / 2 + 1.2));
      f.add(bank);
    }
    f.add(water);
    this.padSpots = pads.map((p) => {
      const pad = makePad();
      pad.position.set(p.x, 0, p.z);
      f.add(pad);
      return p;
    });
    this.fixtures = f;
    this.root.add(f);
    // Everything that was driving or sailing finds its place in the new town.
    for (const a of this.actors.values()) this._place(a, true);
  }

  /** A fresh look at the processes. */
  update(procs) {
    const seen = new Set();
    let rocketSlots = MAX_ROCKETS;
    const sorted = [...procs].sort((a, b) => (b.mem / ROCKET_MEM + b.cpu / ROCKET_CPU) - (a.mem / ROCKET_MEM + a.cpu / ROCKET_CPU));
    for (const p of sorted) {
      const kind = kindFor(p, rocketSlots);
      if (kind === 'rocket') rocketSlots--;
      seen.add(p.pid);
      let a = this.actors.get(p.pid);
      if (a && a.kind !== kind) { this._drop(a, true); a = null; }
      if (!a) a = this._spawn(p, kind);
      a.proc = p;
      a.item.proc = p;
      a.target = sizeFor(p);
    }
    for (const a of [...this.actors.values()]) if (!seen.has(a.proc.pid)) this._drop(a);
    this._assignPads();
  }

  _spawn(p, kind) {
    const color = colorFor(p.user);
    const obj = kind === 'car' ? makeCar({ color, hover: this.layoutInfo?.hover })
      : kind === 'boat' ? makeBoat(color) : makeRocket(color);
    const a = {
      kind, obj, proc: p, size: 0.05, target: sizeFor(p), s: Math.random() * 1000, leaving: 0,
      item: { kind: 'proc', vehicle: kind, proc: p },
    };
    obj.userData.item = a.item;
    obj.traverse((o) => { if (o.isMesh) o.userData.item = a.item; });
    this.root.add(obj);
    this.actors.set(p.pid, a);
    this._place(a, false);
    return a;
  }

  _drop(a, now = false) {
    this.actors.delete(a.proc.pid);
    if (now) { this.root.remove(a.obj); disposeTree(a.obj); return; }
    a.leaving = 1;
    (this.leaving ||= []).push(a);
  }

  /** Give a vehicle a route (a car), a lane (a boat) or a pad (a rocket). */
  _place(a, relayout) {
    const info = this.layoutInfo;
    if (!info) return;
    if (a.kind === 'car') {
      a.route = info.streets ? blockLoop(info.streets) : null;
      if (relayout) a.s = Math.random() * 1000;
    } else if (a.kind === 'boat') {
      const r = info.river;
      a.dir = Math.random() < 0.5 ? 1 : -1;
      a.laneZ = r.z + a.dir * r.width * (0.12 + Math.random() * 0.22);
      a.x = r.x0 + Math.random() * (r.x1 - r.x0);
    } else {
      a.phase = 'pad';
      a.wait = 2 + Math.random() * 6;
      a.y = 0;
      a.vy = 0;
    }
  }

  _assignPads() {
    const spots = this.padSpots || [];
    let k = 0;
    for (const a of this.actors.values()) {
      if (a.kind !== 'rocket') continue;
      a.pad = spots[k++ % Math.max(1, spots.length)] || { x: 0, z: 0 };
    }
  }

  tick(dt) {
    this.time += dt;
    if (!this.layoutInfo) return;
    for (const a of this.actors.values()) {
      a.size += (a.target - a.size) * Math.min(1, dt * 1.5);
      this._move(a, dt);
    }
    for (const a of [...(this.leaving || [])]) {
      a.leaving -= dt * 0.6;
      a.size = Math.max(0.01, a.size * (1 - dt * 1.2));
      this._move(a, dt);
      if (a.kind === 'boat') a.obj.position.y -= (1 - a.leaving) * 1.5;
      if (a.leaving <= 0) {
        this.root.remove(a.obj);
        disposeTree(a.obj);
        this.leaving.splice(this.leaving.indexOf(a), 1);
      }
    }
  }

  _move(a, dt) {
    const o = a.obj;
    o.scale.setScalar(a.size);
    const p = a.proc;
    if (a.kind === 'car') {
      if (!a.route) { o.visible = false; return; }
      o.visible = true;
      a.s += dt * clamp(6 + p.cpu * 0.5, 6, 42);
      const here = a.route.at(a.s), ahead = a.route.at(a.s + 2);
      o.position.set(here.x, 0.12 + (o.userData.lift ? Math.sin(this.time * 3 + a.s) * 0.12 : 0), here.z);
      const want = Math.atan2(-(ahead.x - here.x), -(ahead.z - here.z));
      let d = want - o.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      o.rotation.y += d * Math.min(1, dt * 8);
      spinWheels(o, a.s / a.size);
    } else if (a.kind === 'boat') {
      const r = this.layoutInfo.river;
      a.x += a.dir * dt * clamp(3 + p.cpu * 0.3, 3, 18);
      if (a.x > r.x1 - 6) a.x = r.x0 + 6;
      if (a.x < r.x0 + 6) a.x = r.x1 - 6;
      o.position.set(a.x, 0.1 - Math.min(0.5, p.mem / (2048 * MB)) * a.size * 0.3 + Math.sin(this.time * 1.4 + a.x * 0.1) * 0.08, a.laneZ);
      o.rotation.y = a.dir > 0 ? -Math.PI / 2 : Math.PI / 2;
      o.rotation.z = Math.sin(this.time * 1.1 + a.x) * 0.03;
    } else {
      const pad = a.pad || { x: 0, z: 0 };
      // Countdown on the pad, then up and out of sight, then the next one.
      if (a.phase === 'pad') {
        a.wait -= dt;
        a.y = 0;
        if (a.wait <= 0) { a.phase = 'up'; a.vy = 0; }
      } else {
        a.vy += dt * (4 + p.cpu * 0.15);
        a.y += a.vy * dt;
        if (a.y > 600) { a.phase = 'pad'; a.wait = 4 + Math.random() * 8; a.y = 0; a.vy = 0; }
      }
      o.position.set(pad.x, 0.6 + a.y, pad.z);
      const burning = a.phase === 'up' || a.wait < 1.5;
      const power = clamp(0.4 + p.cpu / 50, 0.4, 2.6);
      const flick = 0.85 + Math.sin(this.time * 40 + pad.x) * 0.15;
      a.obj.userData.flame.visible = a.obj.userData.core.visible = burning;
      a.obj.userData.flame.scale.set(1, power * flick * (a.phase === 'up' ? 1.6 : 0.6), 1);
      a.obj.userData.core.scale.set(1, power * flick, 1);
    }
  }

  pickTargets() {
    const out = [];
    for (const a of this.actors.values()) a.obj.traverse((o) => { if (o.isMesh && o.visible) out.push(o); });
    return out;
  }

  dispose() {
    this.scene.remove(this.root);
    disposeTree(this.root);
    this.actors.clear();
  }
}

function disposeTree(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) m.dispose();
  });
}
