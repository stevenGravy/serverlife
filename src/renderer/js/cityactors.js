import * as THREE from 'three';

/**
 * The town's occasional visitors: a superhero who flies over now and then,
 * and a police car chasing somebody through the streets.
 *
 * Neither means anything — the buildings are the information, and these are
 * the reason to leave the view open. Both are built from a handful of
 * primitives, like everything else here, and each is a Group that owns its
 * geometry, so a visit is thrown away whole when it ends.
 */

const std = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...o });

/* ------------------------------------------------------------------ */
/* The superhero                                                       */
/* ------------------------------------------------------------------ */

/**
 * Flying the classic way: flat out, nose (well, fist) first along -z, one
 * arm forward, the cape streaming behind. About twice life size, or from a
 * flying camera they are a speck.
 */
export function makeHero() {
  const g = new THREE.Group();
  const suit = std(0x2457c5);
  const cape = new THREE.MeshStandardMaterial({ color: 0xc62828, roughness: 0.8, side: THREE.DoubleSide });
  const skin = std(0xf1c27d);
  const boots = std(0xb71c1c);
  const belt = std(0xffd33d, { metalness: 0.4 });

  const limb = (r, len, mat) => {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 8), mat);
    m.rotation.x = Math.PI / 2;
    m.castShadow = true;
    return m;
  };
  const torso = limb(0.42, 1.2, suit);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.34, 14, 10), skin);
  head.position.set(0, 0.18, -1.2);
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.35, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), std(0x1b1b1b));
  hair.position.copy(head.position);
  hair.rotation.x = -0.5;
  const armF = limb(0.14, 1.1, suit);
  armF.position.set(0.32, 0.05, -1.9);
  const fist = new THREE.Mesh(new THREE.SphereGeometry(0.17, 8, 6), skin);
  fist.position.set(0.32, 0.05, -2.55);
  const armB = limb(0.14, 1.0, suit);
  armB.position.set(-0.55, -0.05, -0.1);
  const legL = limb(0.17, 1.3, suit);
  legL.position.set(0.2, -0.05, 1.35);
  const legR = legL.clone();
  legR.position.x = -0.2;
  const bootL = limb(0.19, 0.4, boots);
  bootL.position.set(0.2, -0.05, 2.15);
  const bootR = bootL.clone();
  bootR.position.x = -0.2;
  const sash = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.44, 0.16, 14), belt);
  sash.rotation.x = Math.PI / 2;
  sash.position.z = 0.45;
  const emblem = new THREE.Mesh(new THREE.CircleGeometry(0.22, 5), std(0xffd33d, { emissive: 0x332200 }));
  emblem.rotation.x = Math.PI / 2;
  emblem.position.set(0, -0.43, -0.4);

  // The cape: a strip of cloth whose vertices ripple every frame.
  const capeGeo = new THREE.PlaneGeometry(1.3, 3.2, 4, 12);
  capeGeo.rotateX(-Math.PI / 2);
  capeGeo.translate(0, 0.45, 0.9);
  const capeMesh = new THREE.Mesh(capeGeo, cape);
  capeMesh.castShadow = true;

  g.add(torso, head, hair, armF, fist, armB, legL, legR, bootL, bootR, sash, emblem, capeMesh);
  g.scale.setScalar(2);
  g.userData = {
    cape: capeMesh,
    capeRest: Float32Array.from(capeGeo.attributes.position.array),
    item: { kind: 'hero', name: 'a superhero' },
  };
  return g;
}

/** Ripple the cape; `t` is time, `speed` how hard the wind is. */
export function flapCape(hero, t, speed = 1) {
  const { cape, capeRest } = hero.userData;
  const pos = cape.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const z = capeRest[i * 3 + 2];
    const back = Math.max(0, z - 0.9);              // fixed at the shoulders
    pos.setY(i, capeRest[i * 3 + 1] + Math.sin(t * 14 * speed - z * 2.4) * 0.16 * back);
    pos.setX(i, capeRest[i * 3] * (1 + back * 0.12));
  }
  pos.needsUpdate = true;
  cape.geometry.computeVertexNormals();
}

/* ------------------------------------------------------------------ */
/* Cars                                                                */
/* ------------------------------------------------------------------ */

/**
 * A car, nose along -z, sitting on y = 0. The police one has a light bar
 * whose two halves `flashLights` takes turns with; in the future, cars have
 * no wheels and float, as was always promised.
 */
export function makeCar({ police = false, color = 0xd6452f, hover = false } = {}) {
  const g = new THREE.Group();
  const lift = hover ? 1.4 : 0;
  const paint = std(police ? 0x14171c : color, { metalness: 0.5, roughness: 0.35 });
  const glass = std(0x1d2733, { metalness: 0.8, roughness: 0.15 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.75, 4.5), paint);
  body.position.y = 0.7 + lift;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.7, 2.3), glass);
  cabin.position.set(0, 1.4 + lift, 0.25);
  body.castShadow = cabin.castShadow = true;
  g.add(body, cabin);

  if (police) {
    // White doors, the way every police car in every film has them.
    const white = std(0xf4f6fa);
    for (const s of [1, -1]) {
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.6, 2), white);
      door.position.set(s * 1.07, 0.72 + lift, 0.1);
      g.add(door);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.08, 2.0), white);
    roof.position.set(0, 1.79 + lift, 0.25);
    g.add(roof);
  }

  if (hover) {
    const under = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 0.08, 20), new THREE.MeshBasicMaterial({ color: 0x4cf2ff, transparent: true, opacity: 0.7 }));
    under.position.y = lift - 0.05;
    g.add(under);
    g.userData.under = under;
  } else {
    const tyre = std(0x111111, { roughness: 0.9 });
    const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.32, 14);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheels = [];
    for (const [x, z] of [[1, -1.45], [-1, -1.45], [1, 1.45], [-1, 1.45]]) {
      const w = new THREE.Mesh(wheelGeo, tyre);
      w.position.set(x * 1.0, 0.42, z);
      g.add(w);
      wheels.push(w);
    }
    g.userData.wheels = wheels;
  }

  const head = new THREE.MeshBasicMaterial({ color: 0xfff6d8 });
  const tail = new THREE.MeshBasicMaterial({ color: 0xff2a2a });
  for (const s of [1, -1]) {
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.2, 0.05), head);
    h.position.set(s * 0.7, 0.8 + lift, -2.26);
    const t = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.18, 0.05), tail);
    t.position.set(s * 0.7, 0.8 + lift, 2.26);
    g.add(h, t);
  }

  if (police) {
    const red = new THREE.MeshBasicMaterial({ color: 0xff2020 });
    const blue = new THREE.MeshBasicMaterial({ color: 0x2060ff });
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 0.35), std(0x222222));
    bar.position.set(0, 1.88 + lift, 0.1);
    const r = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.22, 0.38), red);
    r.position.set(0.33, 2.0 + lift, 0.1);
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.22, 0.38), blue);
    b.position.set(-0.33, 2.0 + lift, 0.1);
    g.add(bar, r, b);
    g.userData.lights = { red, blue };
  }
  g.userData.item = police
    ? { kind: 'police', name: 'a police car' }
    : { kind: 'suspect', name: 'a getaway car' };
  g.userData.lift = lift;
  return g;
}

/** Red, blue, red, blue: the lights take turns, and dim when it is not theirs. */
export function flashLights(car, t) {
  const L = car.userData.lights;
  if (!L) return;
  const on = Math.floor(t * 7) % 2 === 0;
  L.red.color.setHex(on ? 0xff2020 : 0x3a0808);
  L.blue.color.setHex(on ? 0x0c1640 : 0x2060ff);
}

export function spinWheels(car, dist) {
  for (const w of car.userData.wheels || []) w.rotation.x = -dist / 0.42;
}

/* ------------------------------------------------------------------ */
/* The route                                                           */
/* ------------------------------------------------------------------ */

/**
 * A getaway through the grid: in from outside town along one street, a
 * handful of random turns at the crossroads, and out again.
 *
 * `xs` are the x of the north–south streets and `zs` the z of the east–west
 * ones. Cars keep to the right of the centre line, which is also what keeps
 * them off the lamp posts standing in the middle of every crossing.
 */
export function chaseRoute({ xs, zs }, { lane = 1.3, outside = 70, turns = 8 } = {}) {
  if (xs.length < 2 || zs.length < 2) return null;
  const R = () => Math.random();
  const pick = (a) => a[Math.floor(R() * a.length)];
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const inGrid = (i, j) => i >= 0 && j >= 0 && i < xs.length && j < zs.length;

  // Enter at an edge crossing, heading inward.
  const edge = pick(['w', 'e', 'n', 's']);
  let i, j, d;
  if (edge === 'w') { i = 0; j = Math.floor(R() * zs.length); d = [1, 0]; }
  else if (edge === 'e') { i = xs.length - 1; j = Math.floor(R() * zs.length); d = [-1, 0]; }
  else if (edge === 'n') { j = zs.length - 1; i = Math.floor(R() * xs.length); d = [0, -1]; }
  else { j = 0; i = Math.floor(R() * xs.length); d = [0, 1]; }

  const P = (a, b) => new THREE.Vector3(xs[a], 0, zs[b]);
  const nodes = [{ p: P(i, j).addScaledVector(new THREE.Vector3(d[0], 0, d[1]), -outside), d }];
  nodes.push({ p: P(i, j), d });
  for (let k = 0; k < turns * 3; k++) {
    const options = DIRS.filter(([a, b]) => !(a === -d[0] && b === -d[1]) && inGrid(i + a, j + b));
    if (!options.length) break;
    const straight = options.find(([a, b]) => a === d[0] && b === d[1]);
    d = straight && R() < 0.45 ? straight : pick(options);
    i += d[0]; j += d[1];
    nodes.push({ p: P(i, j), d });
    if (nodes.length > turns + 2 && R() < 0.25) break;
  }
  // And away, straight on out of town.
  while (inGrid(i + d[0], j + d[1])) { i += d[0]; j += d[1]; nodes.push({ p: P(i, j), d }); }
  nodes.push({ p: P(i, j).addScaledVector(new THREE.Vector3(d[0], 0, d[1]), outside), d });

  // Keep right: offset each point by the right-hand side of the way in and
  // the way out, which at a corner puts it on the inside or outside of the
  // turn as it should be.
  const right = ([a, b]) => new THREE.Vector3(-b, 0, a);
  const pts = nodes.map((n, k) => {
    const din = k > 0 ? nodes[k].d : n.d;
    const dout = k < nodes.length - 1 ? nodes[k + 1].d : n.d;
    const off = right(din);
    if (din[0] !== dout[0] || din[1] !== dout[1]) off.add(right(dout));
    return n.p.clone().addScaledVector(off, lane);
  });
  // Drop points that sit in a straight line, so speed is even along them.
  const out = [pts[0]];
  for (let k = 1; k < pts.length; k++) if (pts[k].distanceTo(out[out.length - 1]) > 0.01) out.push(pts[k]);
  return polyline(out);
}

/** A path you can ask "where am I after s units?", with corners rounded off. */
function polyline(points) {
  const curve = new THREE.CurvePath();
  for (let k = 0; k < points.length - 1; k++) curve.add(new THREE.LineCurve3(points[k], points[k + 1]));
  const lens = curve.getCurveLengths();
  const length = lens[lens.length - 1];
  const at = (s) => {
    s = Math.max(0, Math.min(length, s));
    let k = 0;
    while (k < lens.length - 1 && lens[k] < s) k++;
    const start = k ? lens[k - 1] : 0;
    const segLen = lens[k] - start || 1;
    return curve.curves[k].getPoint((s - start) / segLen);
  };
  return { length, at };
}
