import * as THREE from 'three';

/**
 * What the buildings of the 3D city look like.
 *
 * The facts a building carries — its height, its footprint and the coloured
 * bands of what its bytes are — are the same in every style; a style only
 * decides the shape they are poured into and what sits on the roof. So a
 * pagoda and a glass tower over the same folder are equally tall and equally
 * striped, and switching styles never changes what the city says.
 *
 * Each style has several kinds of building and picks between them by the
 * folder's name, with the details (how far a tower steps in, how big the
 * dome is, which colour the roof tiles are) jittered by the same seed. A
 * street is then a mix, and the same folder looks the same every visit.
 */

export const CITY_STYLES = [
  { id: 'today', label: 'Today — the modern mix', group: 'Now' },
  { id: 'eastasia', label: 'East Asia — pagodas & eaves', group: 'Around the world' },
  { id: 'mideast', label: 'Middle East — domes & minarets', group: 'Around the world' },
  { id: 'mediterranean', label: 'Mediterranean — terracotta & blue domes', group: 'Around the world' },
  { id: 'canal', label: 'Northern Europe — canal-house gables', group: 'Around the world' },
  { id: 'ancient', label: 'Ancient Greece & Rome', group: 'Through time' },
  { id: 'medieval', label: 'Medieval — castles & turrets', group: 'Through time' },
  { id: 'victorian', label: 'Victorian — mansards & chimneys', group: 'Through time' },
  { id: 'deco', label: 'Art Deco — 1930s skyline', group: 'Through time' },
  { id: 'future', label: 'Futuristic — the year 2200', group: 'Through time' },
];

export const DEFAULT_STYLE = 'today';

export function styleById(id) {
  return CITY_STYLES.find((s) => s.id === id) || CITY_STYLES[0];
}

/* ------------------------------------------------------------------ */
/* Seeds                                                               */
/* ------------------------------------------------------------------ */

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** A small deterministic generator, so a folder keeps its building. */
export function seeded(key) {
  let a = hash(String(key)) || 1;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.pick = (arr) => arr[Math.floor(next() * arr.length) % arr.length];
  next.range = (a0, a1) => a0 + next() * (a1 - a0);
  return next;
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

const S = 8;   // world units per window tile, as scaledBox in city3d

/**
 * A cylinder (or a 4- or 8-sided prism) whose walls carry the window tile
 * at its true size. The caps map to a single wall pixel, as the boxes' do.
 */
function scaledCylinder(rTop, rBot, h, segs, v0 = 0) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, segs, 1, false);
  const uv = g.attributes.uv;
  const torso = (segs + 1) * 2;
  const perim = Math.PI * (rTop + rBot) * (segs <= 8 ? Math.sin(Math.PI / segs) * segs / Math.PI : 1);
  for (let i = 0; i < uv.count; i++) {
    if (i >= torso) { uv.setXY(i, 0.01, 0.01); continue; }
    uv.setXY(i, uv.getX(i) * perim / S, uv.getY(i) * h / S + v0 / S);
  }
  uv.needsUpdate = true;
  return g;
}

/** A gable: a triangle `w` wide and `h` high, `len` long, ridge along z. */
function prismGeo(w, h, len) {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(0, h);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
  g.translate(0, 0, -len / 2);
  return g;
}

/** A square pyramid or hip roof over a square of side `w`. */
function pyramidGeo(w, h, top = 0) {
  const g = new THREE.CylinderGeometry(top * Math.SQRT1_2, w * Math.SQRT1_2, h, 4, 1);
  g.rotateY(Math.PI / 4);
  return g;
}

/* ------------------------------------------------------------------ */
/* The builder                                                         */
/* ------------------------------------------------------------------ */

/**
 * One building, into `g`, standing on y = 0.
 *
 * `bands` is [[colour, share], …] bottom up; `bandMat(colour)` makes the
 * windowed wall material for one, and `accent(colour, opts)` a plain one.
 * Both are expected to remember what they made, so the caller can dim the
 * whole building when the filter rules it out.
 *
 * Returns the height of the walls (what the building is "as tall as") and
 * of the very top (where its sign goes), and anything that wants to turn.
 */
export function buildTower(g, { styleId, seed, w, h, bands, bandMat, accent, box, night }) {
  const rnd = seeded(styleId + '|' + seed);
  const ctx = { g, rnd, w, h, bands, bandMat, accent, box, night, spin: [], top: 0 };
  const recipe = RECIPES[styleId] || RECIPES.today;
  recipe(ctx);
  return { H: ctx.H, top: Math.max(ctx.top, ctx.H), spin: ctx.spin };
}

const add = (ctx, geo, mat, x, y, z, { shadow = true } = {}) => {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (shadow) m.castShadow = m.receiveShadow = true;
  ctx.g.add(m);
  return m;
};

const raise = (ctx, y) => { ctx.top = Math.max(ctx.top, y); };

/**
 * The walls, band by band.
 *
 *   shape  'box' | 'round' | 'oct' | 'taper'
 *   shrink how much narrower each band is than the one under it (setbacks)
 *   taper  for 'taper': the top's width as a share of the bottom's
 *   between(ctx, y, width) is called at each join, for eaves and cornices
 */
function walls(ctx, { shape = 'box', shrink = 0, minScale = 0.5, taper = 0.6, between = null } = {}) {
  const { w, h, bands } = ctx;
  const total = bands.reduce((s, [, b]) => s + b, 0);
  let y = 0;
  let width = w;
  const n = bands.length;
  bands.forEach(([color, b], i) => {
    const bh = Math.max(0.7, h * b / total);
    const mat = ctx.bandMat(color);
    let geo;
    if (shape === 'taper') {
      const f0 = 1 - (1 - taper) * (y / h), f1 = 1 - (1 - taper) * Math.min(1, (y + bh) / h);
      geo = scaledCylinder(w * f1 * Math.SQRT1_2, w * f0 * Math.SQRT1_2, bh, 4, y);
      geo.rotateY(Math.PI / 4);
      width = w * f1;
    } else if (shape === 'round') {
      geo = scaledCylinder(width / 2, width / 2, bh, 24, y);
    } else if (shape === 'oct') {
      geo = scaledCylinder(width / 2 / Math.cos(Math.PI / 8), width / 2 / Math.cos(Math.PI / 8), bh, 8, y);
      geo.rotateY(Math.PI / 8);
    } else {
      geo = ctx.box(width, bh, width, y);
    }
    add(ctx, geo, mat, 0, y + bh / 2, 0);
    y += bh;
    if (i < n - 1) {
      if (between) between(ctx, y, width);
      if (shrink) width = Math.max(w * minScale, width * (1 - shrink));
    }
  });
  ctx.H = y;
  ctx.topW = width;
  raise(ctx, y);
  return y;
}

/* ---------------- roofs and crowns ---------------- */

function flatUnit(ctx, mat) {
  const { H, topW, rnd } = ctx;
  const n = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const s = topW * rnd.range(0.18, 0.4), hh = rnd.range(0.8, 2);
    add(ctx, new THREE.BoxGeometry(s, hh, s), mat,
      (rnd() - 0.5) * (topW - s) * 0.8, H + hh / 2, (rnd() - 0.5) * (topW - s) * 0.8);
    raise(ctx, H + hh);
  }
}

function antenna(ctx, { height = null, color = 0x9aa3b2, tip = 0xff3b3b, x = 0, z = 0 } = {}) {
  const base = ctx.top;
  const hh = height || ctx.rnd.range(3, 8);
  add(ctx, new THREE.CylinderGeometry(0.08, 0.16, hh, 6), ctx.accent(color, { metal: 0.6 }), x, base + hh / 2, z, { shadow: false });
  add(ctx, new THREE.SphereGeometry(0.28, 8, 6), new THREE.MeshBasicMaterial({ color: tip }), x, base + hh, z, { shadow: false });
  raise(ctx, base + hh);
}

function spire(ctx, mat, { k = 0.6, needle = true } = {}) {
  const { topW } = ctx;
  const base = ctx.top;
  const hh = topW * k;
  add(ctx, pyramidGeo(topW * 0.98, hh), mat, 0, base + hh / 2, 0);
  raise(ctx, base + hh);
  if (needle) antenna(ctx, { height: ctx.rnd.range(2, 5), color: 0xc9ccd4, tip: 0xffe08a });
}

function dome(ctx, mat, { k = 0.45, drum = 1.2, onion = false, finial = 0xd9a441 } = {}) {
  const { topW } = ctx;
  let base = ctx.top;
  const r = topW * k;
  if (drum) {
    add(ctx, new THREE.CylinderGeometry(r * 1.02, r * 1.05, drum, 24), ctx.accent(0xd8d2c4), 0, base + drum / 2, 0);
    base += drum;
  }
  const geo = new THREE.SphereGeometry(r, 24, 14, 0, Math.PI * 2, 0, onion ? Math.PI * 0.62 : Math.PI / 2);
  const m = add(ctx, geo, mat, 0, base, 0);
  if (onion) {
    m.scale.set(1, 1.35, 1);
    const tip = r * 0.9;
    add(ctx, new THREE.ConeGeometry(r * 0.32, tip, 16), mat, 0, base + r * 1.35 * 0.9 + tip / 2 - r * 0.15, 0);
    base += r * 1.35 + tip * 0.75;
  } else {
    base += r;
  }
  add(ctx, new THREE.SphereGeometry(Math.max(0.2, r * 0.07), 8, 6), ctx.accent(finial, { metal: 0.7 }), 0, base + 0.2, 0, { shadow: false });
  raise(ctx, base + 0.4);
}

function gable(ctx, mat, { along = 'x', k = 0.55, overhang = 0.6, chimneys = 0, chimneyMat = null } = {}) {
  const { H, topW, rnd } = ctx;
  const hh = topW * k;
  const geo = prismGeo(topW + overhang * 2, hh, topW + overhang * 2);
  if (along === 'x') geo.rotateY(Math.PI / 2);
  add(ctx, geo, mat, 0, H, 0);
  raise(ctx, H + hh);
  for (let i = 0; i < chimneys; i++) {
    const cx = (rnd() - 0.5) * topW * 0.6, cz = (rnd() - 0.5) * topW * 0.6;
    const ch = hh * rnd.range(0.7, 1.1) + 1.2;
    add(ctx, new THREE.BoxGeometry(0.9, ch, 0.9), chimneyMat || mat, cx, H + ch / 2, cz);
    raise(ctx, H + ch);
  }
}

/** A stepped gable on the street front, as Amsterdam does it. */
function steppedGable(ctx, mat, trim) {
  const { H, topW } = ctx;
  const steps = 3 + Math.floor(ctx.rnd() * 2);
  const stepH = topW * 0.16;
  for (let i = 0; i < steps; i++) {
    const sw = topW * (1 - i / steps);
    add(ctx, new THREE.BoxGeometry(sw, stepH, 0.7), trim, 0, H + stepH * (i + 0.5), topW / 2 - 0.35);
  }
  // The roof behind it.
  const geo = prismGeo(topW, stepH * steps, topW - 0.7);
  add(ctx, geo, mat, 0, H, -0.35);
  raise(ctx, H + stepH * steps);
  // The hoist beam every one of them has, for the furniture.
  add(ctx, new THREE.BoxGeometry(0.25, 0.25, 1.4), ctx.accent(0x3a2a1c), 0, H + stepH * (steps - 0.5), topW / 2 + 0.4, { shadow: false });
}

function mansard(ctx, mat, chimneyMat) {
  const { H, topW, rnd } = ctx;
  const hh = rnd.range(2.2, 3.4);
  add(ctx, pyramidGeo(topW * 1.02, hh, topW * 0.62), mat, 0, H + hh / 2, 0);
  // Dormers on the street side.
  const n = Math.max(1, Math.floor(topW / 5));
  for (let i = 0; i < n; i++) {
    const x = -topW * 0.3 + (n === 1 ? topW * 0.3 : (i * topW * 0.6) / (n - 1));
    add(ctx, new THREE.BoxGeometry(1.1, 1.3, 0.9), ctx.accent(0xe8e2d4), x, H + hh * 0.45, topW * 0.42);
  }
  for (let i = 0; i < 2 + Math.floor(rnd() * 2); i++) {
    const cx = (i % 2 ? 1 : -1) * topW * 0.38, cz = (rnd() - 0.5) * topW * 0.5;
    const ch = hh + rnd.range(1, 2.4);
    add(ctx, new THREE.BoxGeometry(1, ch, 1.4), chimneyMat, cx, H + ch / 2, cz);
    add(ctx, new THREE.CylinderGeometry(0.18, 0.18, 0.6, 6), ctx.accent(0xb5653a), cx, H + ch + 0.3, cz, { shadow: false });
    raise(ctx, H + ch + 0.6);
  }
  raise(ctx, H + hh);
}

function crenellate(ctx, mat, { round = false } = {}) {
  const { H, topW } = ctx;
  const merlon = 1.1;
  add(ctx, round
    ? new THREE.CylinderGeometry(topW / 2 + 0.4, topW / 2 + 0.4, 0.7, 24)
    : new THREE.BoxGeometry(topW + 0.8, 0.7, topW + 0.8), mat, 0, H + 0.35, 0);
  const pts = [];
  if (round) {
    const n = Math.max(8, Math.round(Math.PI * topW / 2.2));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push([Math.cos(a) * (topW / 2 + 0.1), Math.sin(a) * (topW / 2 + 0.1)]);
    }
  } else {
    const n = Math.max(3, Math.round(topW / 2.4));
    const e = topW / 2 + 0.1;
    for (let i = 0; i <= n; i++) {
      const t = -e + (2 * e * i) / n;
      pts.push([t, e], [t, -e]);
      if (i > 0 && i < n) pts.push([e, t], [-e, t]);
    }
  }
  for (const [x, z] of pts) add(ctx, new THREE.BoxGeometry(0.9, merlon, 0.9), mat, x, H + 0.7 + merlon / 2, z);
  raise(ctx, H + 0.7 + merlon);
  ctx.top = H + 0.7;
}

function turretCone(ctx, mat) {
  const { topW } = ctx;
  const r = topW / 2 + 0.6;
  const hh = r * ctx.rnd.range(1.6, 2.4);
  const base = ctx.H;
  add(ctx, new THREE.ConeGeometry(r, hh, 24), mat, 0, base + hh / 2, 0);
  raise(ctx, base + hh);
  // A pennant.
  add(ctx, new THREE.CylinderGeometry(0.06, 0.06, 2.4, 4), ctx.accent(0x3a3a3a), 0, base + hh + 1.2, 0, { shadow: false });
  const flag = add(ctx, new THREE.PlaneGeometry(1.4, 0.7), new THREE.MeshLambertMaterial({ color: ctx.rnd.pick([0xc62828, 0x1e5bb8, 0xe0b000]), side: THREE.DoubleSide }), 0.7, base + hh + 2.0, 0, { shadow: false });
  ctx.spin.push({ obj: flag, kind: 'flag' });
  raise(ctx, base + hh + 2.4);
}

/** Flared eaves at a join, pagoda fashion. */
function eave(ctx, y, width, mat, { flare = 2.2, round = false } = {}) {
  const geo = round
    ? new THREE.CylinderGeometry(width / 2, width / 2 + flare, 0.9, 8)
    : pyramidGeo(width + flare * 2, 0.9, width);
  add(ctx, geo, mat, 0, y + 0.1, 0);
  // Upturned corners.
  if (!round) {
    const e = width / 2 + flare;
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      add(ctx, new THREE.ConeGeometry(0.22, 0.9, 5), mat, sx * e * 0.98, y + 0.45, sz * e * 0.98, { shadow: false });
    }
  }
}

function pagodaTop(ctx, roofMat, finialMat) {
  const { topW } = ctx;
  const base = ctx.H;
  eave(ctx, base, topW, roofMat, { flare: 2.4 });
  const hh = topW * 0.45;
  add(ctx, pyramidGeo(topW + 1.2, hh), roofMat, 0, base + 0.5 + hh / 2, 0);
  let y = base + 0.5 + hh;
  // The finial: rings on a mast.
  add(ctx, new THREE.CylinderGeometry(0.12, 0.12, 4.5, 6), finialMat, 0, y + 2.25, 0, { shadow: false });
  for (let i = 0; i < 5; i++) {
    add(ctx, new THREE.TorusGeometry(0.5 - i * 0.06, 0.09, 6, 14), finialMat, 0, y + 0.8 + i * 0.6, 0, { shadow: false })
      .rotation.x = Math.PI / 2;
  }
  raise(ctx, y + 4.5);
}

function columns(ctx, { colMat, baseMat, pediment = null, height = null } = {}) {
  const { w } = ctx;
  const ch = Math.min(height || ctx.H, 9);
  const e = w / 2 + 1.1;
  // The stylobate: three steps up.
  for (let i = 0; i < 2; i++) add(ctx, new THREE.BoxGeometry(e * 2 + 2 - i * 0.8, 0.3, e * 2 + 2 - i * 0.8), baseMat, 0, 0.15 + i * 0.3, 0);
  const n = Math.max(3, Math.round((e * 2) / 2.6));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = -e + (2 * e * i) / n;
    pts.push([t, e], [t, -e]);
    if (i > 0 && i < n) pts.push([e, t], [-e, t]);
  }
  const geo = new THREE.CylinderGeometry(0.32, 0.4, ch, 10);
  for (const [x, z] of pts) {
    // Leave the door clear.
    if (z > 0 && Math.abs(x) < 1.8 && Math.abs(z - e) < 0.01) continue;
    add(ctx, geo, colMat, x, 0.6 + ch / 2, z);
  }
  add(ctx, new THREE.BoxGeometry(e * 2 + 1, 0.8, e * 2 + 1), baseMat, 0, 0.6 + ch + 0.4, 0);
  raise(ctx, 0.6 + ch + 0.8);
  if (pediment && ch >= ctx.H - 0.5) {
    const hh = e * 0.45;
    const g = prismGeo(e * 2 + 1, hh, e * 2 + 1);
    add(ctx, g, pediment, 0, 0.6 + ch + 0.8, 0);
    raise(ctx, 0.6 + ch + 0.8 + hh);
    return true;
  }
  return false;
}

function minaret(ctx, mat, domeMat) {
  const { w, H, rnd } = ctx;
  const side = rnd() < 0.5 ? 1 : -1;
  const x = side * (w / 2 + 1.6), z = -w / 2 + 1.6;
  const mh = Math.max(H * rnd.range(1.15, 1.4), 14);
  add(ctx, new THREE.CylinderGeometry(0.75, 0.95, mh, 12), mat, x, mh / 2, z);
  // The balcony the call to prayer is made from.
  add(ctx, new THREE.CylinderGeometry(1.35, 1.1, 0.4, 14), mat, x, mh * 0.78, z);
  add(ctx, new THREE.SphereGeometry(0.85, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), domeMat, x, mh, z).scale.set(1, 1.4, 1);
  add(ctx, new THREE.ConeGeometry(0.2, 1.4, 8), domeMat, x, mh + 1.6, z, { shadow: false });
  raise(ctx, mh + 2.3);
}

function halo(ctx, color) {
  const { topW } = ctx;
  const y = ctx.top + ctx.rnd.range(1.5, 4);
  const ring = add(ctx, new THREE.TorusGeometry(topW * ctx.rnd.range(0.45, 0.75), 0.18, 8, 40),
    ctx.accent(color, { glow: 1.6 }), 0, y, 0, { shadow: false });
  ring.rotation.x = Math.PI / 2 + ctx.rnd.range(-0.25, 0.25);
  ctx.spin.push({ obj: ring, kind: 'halo', speed: ctx.rnd.range(0.4, 1.2) * (ctx.rnd() < 0.5 ? -1 : 1) });
  raise(ctx, y + 0.5);
}

function sky(ctx, mat) {
  // A skybridge stub and garden deck partway up — futures always have those.
  const { w, H, rnd } = ctx;
  const y = H * rnd.range(0.45, 0.75);
  add(ctx, new THREE.CylinderGeometry(w * 0.6, w * 0.56, 0.6, 32), mat, 0, y, 0);
  add(ctx, new THREE.CylinderGeometry(w * 0.58, w * 0.58, 0.3, 32), ctx.accent(0x5aa04f), 0, y + 0.45, 0, { shadow: false });
}

function decoCrown(ctx, trim) {
  const { topW, rnd } = ctx;
  let base = ctx.H;
  let s = topW * 0.85;
  const steps = 2 + Math.floor(rnd() * 3);
  for (let i = 0; i < steps; i++) {
    const hh = rnd.range(1.2, 2.4);
    add(ctx, new THREE.BoxGeometry(s, hh, s), trim, 0, base + hh / 2, 0);
    base += hh;
    s *= 0.72;
  }
  ctx.top = base;
  if (rnd() < 0.5) {
    // The Chrysler move: a scalloped spire of nested arches, simplified to rings.
    for (let i = 0; i < 4; i++) {
      add(ctx, new THREE.TorusGeometry(s * (0.9 - i * 0.18), 0.12, 6, 24, Math.PI), trim, 0, base + i * 0.9, 0, { shadow: false });
    }
    ctx.top = base + 3.6;
  }
  antenna(ctx, { height: rnd.range(4, 9), color: 0xd9d4c4, tip: 0xffd27a });
}

/* ---------------- the styles ---------------- */

const RECIPES = {
  today(ctx) {
    const { rnd, h } = ctx;
    const roof = ctx.accent(rnd.pick([0x2b303a, 0x3a3f4a, 0x4a3f36]));
    const kind = h < 7 && rnd() < 0.5 ? 'house' : rnd.pick(['slab', 'setback', 'round', 'spire', 'glass']);
    if (kind === 'house') {
      walls(ctx);
      gable(ctx, ctx.accent(rnd.pick([0x8c3b2e, 0x4a4f5c, 0x6b4a2f])), { along: rnd() < 0.5 ? 'x' : 'z', chimneys: rnd() < 0.6 ? 1 : 0 });
    } else if (kind === 'setback') {
      walls(ctx, { shrink: rnd.range(0.08, 0.2) });
      flatUnit(ctx, roof);
      antenna(ctx);
    } else if (kind === 'round') {
      walls(ctx, { shape: 'round' });
      add(ctx, new THREE.CylinderGeometry(ctx.topW * 0.52, ctx.topW * 0.52, 0.5, 24), roof, 0, ctx.H + 0.25, 0);
      raise(ctx, ctx.H + 0.5);
      if (rnd() < 0.5) antenna(ctx);
    } else if (kind === 'spire') {
      walls(ctx, { shrink: rnd() < 0.5 ? 0.1 : 0 });
      spire(ctx, roof, { k: rnd.range(0.3, 0.7) });
    } else if (kind === 'glass') {
      walls(ctx, { shape: 'oct', shrink: rnd.range(0, 0.08) });
      flatUnit(ctx, roof);
    } else {
      walls(ctx);
      flatUnit(ctx, roof);
    }
  },

  eastasia(ctx) {
    const { rnd } = ctx;
    const roofMat = ctx.accent(rnd.pick([0x2e3a33, 0x23303a, 0x6b1f1a, 0x3b4a3a]));
    const gold = ctx.accent(0xd9a441, { metal: 0.6 });
    const kind = rnd.pick(['pagoda', 'pagoda', 'hall', 'octpagoda', 'modern']);
    if (kind === 'pagoda' || kind === 'octpagoda') {
      const oct = kind === 'octpagoda';
      walls(ctx, {
        shape: oct ? 'oct' : 'box',
        shrink: rnd.range(0.06, 0.14),
        between: (c, y, width) => eave(c, y, width, roofMat, { flare: rnd.range(1.4, 2.4), round: oct }),
      });
      pagodaTop(ctx, roofMat, gold);
    } else if (kind === 'hall') {
      walls(ctx);
      // A hip-and-gable roof, wider than the hall, with a ridge.
      eave(ctx, ctx.H, ctx.topW, roofMat, { flare: 2.8 });
      const hh = ctx.topW * 0.35;
      add(ctx, pyramidGeo(ctx.topW + 1.5, hh, ctx.topW * 0.3), roofMat, 0, ctx.H + 0.5 + hh / 2, 0);
      add(ctx, new THREE.BoxGeometry(ctx.topW * 0.5, 0.6, 0.6), gold, 0, ctx.H + 0.5 + hh + 0.3, 0);
      raise(ctx, ctx.H + hh + 1.2);
    } else {
      // Today's Shanghai and Tokyo: towers with a crown.
      walls(ctx, { shape: rnd() < 0.5 ? 'taper' : 'box', taper: rnd.range(0.55, 0.8) });
      if (rnd() < 0.5) spire(ctx, roofMat, { k: 0.5 }); else { flatUnit(ctx, roofMat); antenna(ctx); }
    }
  },

  mideast(ctx) {
    const { rnd } = ctx;
    const domeMat = ctx.accent(rnd.pick([0xd9a441, 0x2aa198, 0x1e6fb5, 0xe9e2cf]), { metal: 0.3 });
    const stone = ctx.accent(rnd.pick([0xe2d3b3, 0xd8c39a, 0xefe6d2]));
    const kind = rnd.pick(['mosque', 'mosque', 'domed', 'tower', 'flat']);
    if (kind === 'mosque') {
      walls(ctx);
      add(ctx, new THREE.BoxGeometry(ctx.topW + 0.6, 0.5, ctx.topW + 0.6), stone, 0, ctx.H + 0.25, 0);
      ctx.top = ctx.H + 0.5;
      dome(ctx, domeMat, { k: rnd.range(0.32, 0.45), onion: rnd() < 0.6, drum: 1.4 });
      minaret(ctx, stone, domeMat);
    } else if (kind === 'domed') {
      walls(ctx, { shape: rnd() < 0.5 ? 'oct' : 'round' });
      ctx.top = ctx.H;
      dome(ctx, domeMat, { k: 0.48, onion: true, drum: 0.8 });
    } else if (kind === 'tower') {
      // Dubai: a tapering needle.
      walls(ctx, { shape: 'taper', taper: rnd.range(0.3, 0.55) });
      antenna(ctx, { height: rnd.range(6, 14), color: 0xd9d4c4, tip: 0xffffff });
    } else {
      walls(ctx);
      // Flat roofs with a parapet and a couple of little domes.
      add(ctx, new THREE.BoxGeometry(ctx.topW + 0.4, 0.8, ctx.topW + 0.4), stone, 0, ctx.H + 0.4, 0);
      for (let i = 0; i < 1 + Math.floor(rnd() * 2); i++) {
        const r = ctx.topW * rnd.range(0.1, 0.18);
        add(ctx, new THREE.SphereGeometry(r, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), domeMat,
          (rnd() - 0.5) * ctx.topW * 0.5, ctx.H + 0.8, (rnd() - 0.5) * ctx.topW * 0.5);
        raise(ctx, ctx.H + 0.8 + r);
      }
    }
  },

  mediterranean(ctx) {
    const { rnd } = ctx;
    const tile = ctx.accent(rnd.pick([0xb5653a, 0xc4703f, 0xa0522d]));
    const blue = ctx.accent(rnd.pick([0x1f5fbf, 0x2a74d4]));
    const kind = rnd.pick(['hip', 'hip', 'bluedome', 'bell', 'terrace']);
    if (kind === 'hip') {
      walls(ctx, { shrink: rnd() < 0.3 ? 0.1 : 0 });
      const hh = ctx.topW * rnd.range(0.2, 0.32);
      add(ctx, pyramidGeo(ctx.topW + 1.4, hh, rnd() < 0.5 ? 0 : ctx.topW * 0.4), tile, 0, ctx.H + hh / 2, 0);
      raise(ctx, ctx.H + hh);
    } else if (kind === 'bluedome') {
      walls(ctx, { shape: rnd() < 0.5 ? 'round' : 'box' });
      ctx.top = ctx.H;
      dome(ctx, blue, { k: rnd.range(0.35, 0.48), drum: 0.6, finial: 0xffffff });
    } else if (kind === 'bell') {
      walls(ctx);
      // A campanile at the corner.
      const bw = Math.max(3, ctx.w * 0.28), bh = ctx.H + rnd.range(5, 10);
      const x = ctx.w / 2 - bw / 2, z = -ctx.w / 2 + bw / 2;
      add(ctx, new THREE.BoxGeometry(bw, bh, bw), ctx.accent(0xefe6d2), x, bh / 2, z);
      add(ctx, pyramidGeo(bw + 0.4, bw * 0.8), tile, x, bh + bw * 0.4, z);
      raise(ctx, bh + bw * 0.8);
      const hh = ctx.topW * 0.22;
      add(ctx, pyramidGeo(ctx.topW + 1, hh), tile, 0, ctx.H + hh / 2, 0);
    } else {
      // Terraces stepping up a hillside.
      walls(ctx, { shrink: rnd.range(0.15, 0.25), minScale: 0.4, between: (c, y, width) => {
        add(c, new THREE.BoxGeometry(width + 0.3, 0.35, width + 0.3), tile, 0, y + 0.17, 0, { shadow: false });
      } });
      add(ctx, new THREE.BoxGeometry(ctx.topW + 0.3, 0.6, ctx.topW + 0.3), ctx.accent(0xefe6d2), 0, ctx.H + 0.3, 0);
      raise(ctx, ctx.H + 0.6);
    }
  },

  canal(ctx) {
    const { rnd } = ctx;
    const slate = ctx.accent(rnd.pick([0x3d4552, 0x4a4d55, 0x5b3a2e]));
    const trim = ctx.accent(rnd.pick([0xf2ede2, 0x8c3b2e, 0x2b2f38]));
    const kind = rnd.pick(['stepped', 'stepped', 'bell', 'neck', 'church']);
    walls(ctx);
    if (kind === 'stepped') steppedGable(ctx, slate, trim);
    else if (kind === 'bell' || kind === 'neck') {
      gable(ctx, slate, { along: 'z', k: kind === 'neck' ? 0.9 : 0.7, overhang: 0.2 });
      // The ornamented front gable.
      add(ctx, prismGeo(ctx.topW * 0.98, ctx.topW * (kind === 'neck' ? 0.9 : 0.7), 0.6), trim, 0, ctx.H, ctx.topW / 2 - 0.1);
    } else {
      gable(ctx, slate, { along: 'z', k: 0.8 });
      // A slim church spire at the back.
      const x = 0, z = -ctx.topW / 2 + 1.6;
      const bh = ctx.H + ctx.topW * 0.8 + rnd.range(4, 9);
      add(ctx, new THREE.BoxGeometry(3, bh, 3), trim, x, bh / 2, z);
      add(ctx, new THREE.ConeGeometry(1.9, 7, 8), slate, x, bh + 3.5, z);
      raise(ctx, bh + 7);
    }
  },

  ancient(ctx) {
    const { rnd } = ctx;
    const marble = ctx.accent(rnd.pick([0xeee9dc, 0xe6dfcc, 0xf4f0e6]));
    const tile = ctx.accent(rnd.pick([0xb5653a, 0x9e5a35]));
    const kind = rnd.pick(['temple', 'temple', 'pantheon', 'basilica', 'obelisk']);
    if (kind === 'temple') {
      walls(ctx);
      const roofed = columns(ctx, { colMat: marble, baseMat: marble, pediment: tile });
      if (!roofed) gable(ctx, tile, { along: 'z', k: 0.3, overhang: 1.2 });
    } else if (kind === 'pantheon') {
      walls(ctx, { shape: 'round' });
      columns(ctx, { colMat: marble, baseMat: marble, height: Math.min(ctx.H, 7) });
      ctx.top = ctx.H;
      dome(ctx, ctx.accent(0x9aa3a8), { k: 0.5, drum: 0.6, finial: 0xd9a441 });
    } else if (kind === 'basilica') {
      walls(ctx, { shrink: 0.1 });
      gable(ctx, tile, { along: 'z', k: 0.35, overhang: 0.8 });
    } else {
      walls(ctx, { shape: 'taper', taper: rnd.range(0.4, 0.6) });
      // A gilded pyramidion.
      add(ctx, pyramidGeo(ctx.topW, ctx.topW * 0.8), ctx.accent(0xd9a441, { metal: 0.8 }), 0, ctx.H + ctx.topW * 0.4, 0);
      raise(ctx, ctx.H + ctx.topW * 0.8);
    }
  },

  medieval(ctx) {
    const { rnd, h } = ctx;
    const stone = ctx.accent(rnd.pick([0x8f8a80, 0x9a948a, 0x7d786f]));
    const roof = ctx.accent(rnd.pick([0x5a3d6b, 0x8b3a2b, 0x3d4552, 0x6b4a2f]));
    const kind = h < 8 && rnd() < 0.6 ? 'timber' : rnd.pick(['keep', 'turret', 'turret', 'gatehouse', 'cathedral']);
    if (kind === 'timber') {
      walls(ctx);
      // Jettied upper floor and a steep roof.
      add(ctx, new THREE.BoxGeometry(ctx.topW + 1, 0.4, ctx.topW + 1), ctx.accent(0x4a3020), 0, ctx.H - 0.2, 0);
      gable(ctx, roof, { along: rnd() < 0.5 ? 'x' : 'z', k: 0.85, chimneys: 1, chimneyMat: stone });
    } else if (kind === 'keep') {
      walls(ctx);
      crenellate(ctx, stone);
      // Corner bartizans.
      for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const x = sx * ctx.topW / 2, z = sz * ctx.topW / 2;
        add(ctx, new THREE.CylinderGeometry(0.9, 0.7, 2.2, 10), stone, x, ctx.H + 1.1, z);
        add(ctx, new THREE.ConeGeometry(1.1, 2.2, 10), roof, x, ctx.H + 3.3, z);
      }
      raise(ctx, ctx.H + 4.4);
    } else if (kind === 'turret') {
      walls(ctx, { shape: 'round' });
      if (rnd() < 0.6) turretCone(ctx, roof); else crenellate(ctx, stone, { round: true });
    } else if (kind === 'gatehouse') {
      walls(ctx);
      crenellate(ctx, stone);
      for (const sx of [1, -1]) {
        const x = sx * (ctx.w / 2 + 0.2), z = ctx.w / 2 - 1;
        const th = ctx.H + rnd.range(2, 5);
        add(ctx, new THREE.CylinderGeometry(1.8, 2, th, 14), stone, x, th / 2, z);
        add(ctx, new THREE.ConeGeometry(2.3, 4, 14), roof, x, th + 2, z);
        raise(ctx, th + 4);
      }
    } else {
      walls(ctx, { shrink: 0.12 });
      gable(ctx, roof, { along: 'z', k: 0.9 });
      // A slim spire rising from the ridge, not a pyramid sat on it.
      const sh = ctx.topW * rnd.range(1.1, 1.8);
      add(ctx, new THREE.ConeGeometry(Math.max(1.2, ctx.topW * 0.12), sh, 8), roof, 0, ctx.top + sh / 2 - 0.5, 0);
      raise(ctx, ctx.top + sh);
    }
  },

  victorian(ctx) {
    const { rnd, h } = ctx;
    const slate = ctx.accent(rnd.pick([0x3d4552, 0x2f353f, 0x4a4f5c]));
    const brick = ctx.accent(rnd.pick([0x8c3b2e, 0x7a3426, 0x9b4a35]));
    const kind = h < 7 && rnd() < 0.5 ? 'terrace' : rnd.pick(['mansard', 'mansard', 'clock', 'gothic', 'mill']);
    if (kind === 'terrace') {
      walls(ctx);
      gable(ctx, slate, { along: 'x', k: 0.5, chimneys: 2, chimneyMat: brick });
    } else if (kind === 'mansard') {
      walls(ctx, { between: (c, y, width) => add(c, new THREE.BoxGeometry(width + 0.5, 0.3, width + 0.5), c.accent(0xe8e2d4), 0, y, 0, { shadow: false }) });
      mansard(ctx, slate, brick);
    } else if (kind === 'clock') {
      walls(ctx, { shrink: 0.15 });
      // A clock face on all four sides of the top band.
      const face = ctx.accent(0xf6f1e3, { glow: ctx.night ? 0.8 : 0 });
      const r = Math.min(ctx.topW * 0.32, 3);
      for (let i = 0; i < 4; i++) {
        const m = add(ctx, new THREE.CircleGeometry(r, 24), face, 0, ctx.H - r - 0.6, 0, { shadow: false });
        m.rotation.y = (i * Math.PI) / 2;
        m.translateZ(ctx.topW / 2 + 0.05);
      }
      spire(ctx, slate, { k: rnd.range(0.9, 1.4), needle: true });
    } else if (kind === 'gothic') {
      walls(ctx);
      gable(ctx, slate, { along: 'z', k: 0.9 });
      for (const [sx, sz] of [[1, 1], [-1, 1]]) {
        const x = sx * ctx.topW / 2, z = sz * ctx.topW / 2;
        add(ctx, new THREE.ConeGeometry(0.6, 3.5, 6), slate, x, ctx.H + 1.75, z);
      }
      raise(ctx, ctx.H + 3.5);
    } else {
      // A mill with its chimney stack.
      walls(ctx);
      gable(ctx, slate, { along: 'x', k: 0.3 });
      const x = ctx.w / 2 - 1.4, z = -ctx.w / 2 + 1.4;
      const sh = ctx.H + rnd.range(8, 16);
      add(ctx, new THREE.CylinderGeometry(0.8, 1.3, sh, 12), brick, x, sh / 2, z);
      raise(ctx, sh);
      ctx.spin.push({ kind: 'smoke', at: new THREE.Vector3(x, sh + 0.5, z) });
    }
  },

  deco(ctx) {
    const { rnd } = ctx;
    const trim = ctx.accent(rnd.pick([0xd9b45a, 0xc9ccd4, 0xb08d57]), { metal: 0.6, glow: ctx.night ? 0.25 : 0 });
    const kind = rnd.pick(['ziggurat', 'ziggurat', 'slab', 'round']);
    if (kind === 'ziggurat') {
      walls(ctx, { shrink: rnd.range(0.12, 0.22), minScale: 0.35,
        between: (c, y, width) => add(c, new THREE.BoxGeometry(width + 0.3, 0.35, width + 0.3), trim, 0, y, 0, { shadow: false }) });
      decoCrown(ctx, trim);
    } else if (kind === 'slab') {
      walls(ctx);
      // Vertical piers running the height.
      const n = Math.max(2, Math.floor(ctx.w / 4));
      for (let i = 0; i < n; i++) {
        const x = -ctx.w / 2 + (ctx.w * (i + 0.5)) / n;
        add(ctx, new THREE.BoxGeometry(0.35, ctx.H, 0.35), trim, x, ctx.H / 2, ctx.w / 2 + 0.1, { shadow: false });
      }
      decoCrown(ctx, trim);
    } else {
      walls(ctx, { shape: 'round', shrink: rnd.range(0.1, 0.18) });
      add(ctx, new THREE.CylinderGeometry(ctx.topW * 0.45, ctx.topW * 0.55, 1.5, 24), trim, 0, ctx.H + 0.75, 0);
      ctx.top = ctx.H + 1.5;
      antenna(ctx, { height: rnd.range(5, 10), color: 0xd9d4c4, tip: 0xffd27a });
    }
  },

  future(ctx) {
    const { rnd } = ctx;
    const glow = rnd.pick([0x4cf2ff, 0xff4cd2, 0x7cff6b, 0xffb84c, 0x9d7cff]);
    const shell = ctx.accent(rnd.pick([0xdfe6ee, 0x9aa3b2, 0x2b303a]), { metal: 0.7 });
    const kind = rnd.pick(['spindle', 'halo', 'pod', 'twist', 'arcology']);
    if (kind === 'spindle') {
      // Glowing collars at each join; corner strips would stand off a taper.
      walls(ctx, { shape: 'taper', taper: rnd.range(0.25, 0.45),
        between: (c, y, width) => add(c, new THREE.BoxGeometry(width + 0.5, 0.2, width + 0.5), c.accent(glow, { glow: 1.4 }), 0, y, 0, { shadow: false }) });
      antenna(ctx, { height: rnd.range(8, 16), color: 0xdfe6ee, tip: glow });
    } else if (kind === 'halo') {
      walls(ctx, { shape: 'round', shrink: rnd.range(0, 0.08) });
      add(ctx, new THREE.SphereGeometry(ctx.topW * 0.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), shell, 0, ctx.H, 0);
      raise(ctx, ctx.H + ctx.topW * 0.5);
      halo(ctx, glow);
      if (rnd() < 0.5) halo(ctx, glow);
    } else if (kind === 'pod') {
      walls(ctx, { shape: 'oct' });
      sky(ctx, shell);
      // A saucer on top.
      const r = ctx.topW * rnd.range(0.7, 1);
      add(ctx, new THREE.CylinderGeometry(r * 0.3, r, 1.2, 32), shell, 0, ctx.H + 1.6, 0);
      add(ctx, new THREE.CylinderGeometry(r, r * 0.4, 0.8, 32), shell, 0, ctx.H + 2.6, 0);
      add(ctx, new THREE.TorusGeometry(r, 0.12, 6, 40), ctx.accent(glow, { glow: 1.6 }), 0, ctx.H + 2.2, 0, { shadow: false }).rotation.x = Math.PI / 2;
      add(ctx, new THREE.CylinderGeometry(0.6, 0.6, 1.6, 12), shell, 0, ctx.H + 0.8, 0);
      raise(ctx, ctx.H + 3.2);
    } else if (kind === 'twist') {
      // Each band turned a little further than the one under it.
      const before = ctx.g.children.length;
      walls(ctx, { shrink: rnd.range(0, 0.06) });
      const turn = rnd.range(0.12, 0.3) * (rnd() < 0.5 ? 1 : -1);
      ctx.g.children.slice(before).forEach((m, i) => { m.rotation.y = turn * i; });
      spire(ctx, shell, { k: 0.5 });
    } else {
      walls(ctx, { shape: 'taper', taper: rnd.range(0.55, 0.75),
        between: (c, y, width) => add(c, new THREE.BoxGeometry(width + 0.8, 0.25, width + 0.8), c.accent(glow, { glow: 1.2 }), 0, y, 0, { shadow: false }) });
      sky(ctx, shell);
      halo(ctx, glow);
    }
  },
};
