import * as THREE from 'three';
import { state, needsMfaApproval } from './state.js';
import { el, clear, fmtBytes, sortEntries } from './util.js';
import { status } from './ui.js';
import { kindOf } from '../../main/filekinds.js';
import { buildTower, CITY_STYLES, DEFAULT_STYLE, styleById } from './cityarch.js';
import { makeHero, flapCape, makeCar, flashLights, spinWheels, chaseRoute } from './cityactors.js';
import { ProcTraffic } from './cityprocs.js';

/**
 * The file explorer as a city.
 *
 * Every folder in the directory is a building: as tall as the data under it,
 * as wide as the number of files, and painted in bands by what those bytes
 * are — code, logs, images, archives. The loose files sit in the plaza in
 * front. Double-click a building to walk into it: inside, the files are crates
 * on the floor (sized and coloured the same way) and the folders are doors in
 * the walls.
 *
 * It is a view of an Explorer, not a second file manager. Where it is, what is
 * selected, the name filter, hidden files, search and the right-click menu are
 * all the explorer's own — so everything the toolbar does works here, and
 * switching back to the list loses nothing.
 */

const isDir = (e) => e.type === 'directory' || e.targetType === 'directory';

const KIND_COLORS = {
  code: 0x4c8dff,
  config: 0xa371f7,
  docs: 0xe3b341,
  images: 0x3fb950,
  media: 0xf778ba,
  archives: 0xd18616,
  logs: 0x56d4dd,
  data: 0x2ea4a0,
  binaries: 0xda3633,
  secrets: 0xffd33d,
  other: 0x8b95a5,
};
const KIND_LABEL = {
  code: 'Code', config: 'Config', docs: 'Documents', images: 'Images', media: 'Audio & video',
  archives: 'Archives', logs: 'Logs', data: 'Data & disks', binaries: 'Binaries',
  secrets: 'Keys & certs', other: 'Other',
};
const MEASURING = 0x5b6475;
const EMPTY = 0x3a404c;

const EYE = 1.7;          // eye height when walking
const CELL = 36;          // city block pitch
const MIN_GRID = 4;       // a town is at least this many blocks across, parks filling the gaps
const MAX_BUILDINGS = 600;
const MAX_CRATES = 400;

/** Measurements, per source and directory, shared by every explorer. */
const scans = new Map();
const inflight = new Map();

const css = (n) => '#' + n.toString(16).padStart(6, '0');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const short = (s, n = 26) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function isLightTheme() {
  const t = document.documentElement.getAttribute('data-tone');
  if (t) return t === 'light';
  return window.matchMedia?.('(prefers-color-scheme: light)').matches;
}

/** Height of a building for this many bytes — logarithmic, or one tall folder hides the rest. */
const heightFor = (bytes) => 3 + 5.2 * Math.log2(1 + (bytes || 0) / 32768);
const footFor = (files) => clamp(10 + 2 * Math.log2(1 + (files || 0)), 10, 26);
const crateFor = (bytes) => clamp(0.45 + 0.3 * Math.log2(1 + (bytes || 0) / 4096), 0.45, 2.8);

/* ------------------------------------------------------------------ */
/* Textures and small builders                                         */
/* ------------------------------------------------------------------ */

/**
 * Windows: a tile of 4×4 with a random few lit. The colour map is white walls
 * and dark glass, so the material colour paints the wall; the emissive map is
 * only the lit panes, so the city lights up at night and not in the day.
 */
function windowTextures() {
  const N = 128, n = 4, cell = N / n;
  const a = document.createElement('canvas');
  const b = document.createElement('canvas');
  a.width = a.height = b.width = b.height = N;
  const ca = a.getContext('2d'), cb = b.getContext('2d');
  ca.fillStyle = '#ffffff'; ca.fillRect(0, 0, N, N);
  cb.fillStyle = '#000000'; cb.fillRect(0, 0, N, N);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = i * cell + cell * 0.22, y = j * cell + cell * 0.18;
      const w = cell * 0.56, h = cell * 0.62;
      ca.fillStyle = '#4b5463'; ca.fillRect(x, y, w, h);
      if (Math.random() < 0.55) {
        cb.fillStyle = Math.random() < 0.5 ? '#ffd98a' : '#fff1c9';
        cb.fillRect(x, y, w, h);
      }
    }
  }
  const mk = (c) => {
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  return { map: mk(a), emissive: mk(b) };
}

/**
 * A box whose UVs are in world units / 8, so the window tile keeps its size
 * however tall the band is. Tops and bottoms map to a single wall pixel.
 */
function scaledBox(w, h, d, v0 = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv;
  const S = 8;
  // Face order: +x, -x, +y, -y, +z, -z — four vertices each.
  const dims = [[d, h], [d, h], [0, 0], [0, 0], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = dims[f];
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      if (!su) { uv.setXY(i, 0.01, 0.01); continue; }
      uv.setXY(i, uv.getX(i) * su / S, uv.getY(i) * sv / S + v0 / S);
    }
  }
  uv.needsUpdate = true;
  return g;
}

/** A text sign that always faces you. `lines[0]` is bold. */
function makeLabel(lines, { height = 1, color = '#ffffff', bg = 'rgba(12,16,24,.78)', accent = null } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const F0 = 'bold 40px -apple-system, "Segoe UI", system-ui, sans-serif';
  const F1 = '30px -apple-system, "Segoe UI", system-ui, sans-serif';
  const pad = 18, lh0 = 48, lh1 = 38;
  ctx.font = F0;
  let w = ctx.measureText(lines[0]).width;
  ctx.font = F1;
  for (const l of lines.slice(1)) w = Math.max(w, ctx.measureText(l).width);
  c.width = Math.ceil(w + pad * 2);
  c.height = Math.ceil(pad * 2 + lh0 + lh1 * (lines.length - 1));
  ctx.fillStyle = bg;
  const r = 14;
  ctx.beginPath();
  ctx.roundRect(0, 0, c.width, c.height, r);
  ctx.fill();
  if (accent) { ctx.fillStyle = accent; ctx.fillRect(0, c.height - 6, c.width, 6); }
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  ctx.font = F0;
  ctx.fillText(lines[0], pad, pad);
  ctx.font = F1;
  ctx.globalAlpha = 0.8;
  lines.slice(1).forEach((l, i) => ctx.fillText(l, pad, pad + lh0 + i * lh1));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const s = new THREE.Sprite(mat);
  const hh = height * (lines.length === 1 ? 1 : 1 + 0.75 * (lines.length - 1));
  s.scale.set(hh * c.width / c.height, hh, 1);
  s.userData.ownMap = true;
  s.renderOrder = 2;
  return s;
}

function dispose(obj) {
  obj.traverse((o) => {
    o.geometry?.dispose?.();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (o.userData.ownMap) m.map?.dispose();
      m.dispose();
    }
  });
}

/** Bytes per kind, biggest first, small slivers folded into "other". */
function bands(rec) {
  const total = rec.bytes || 0;
  if (!total) return [];
  const out = [];
  let other = 0;
  for (const [k, b] of Object.entries(rec.kinds || {})) {
    if (!b) continue;
    if (b / total < 0.03 && k !== 'other') other += b;
    else if (k === 'other') other += b;
    else out.push([k, b]);
  }
  if (other) out.push(['other', other]);
  out.sort((a, b) => b[1] - a[1]);
  return out;
}

function kindSummary(rec) {
  const bs = bands(rec);
  if (!bs.length) return '';
  return bs.slice(0, 4).map(([k, b]) => `${KIND_LABEL[k]} ${Math.round(100 * b / rec.bytes)}%`).join(' · ');
}

/* ------------------------------------------------------------------ */
/* The view                                                            */
/* ------------------------------------------------------------------ */

export class City3D {
  constructor(explorer) {
    this.ex = explorer;
    this.mode = 'city';          // 'city' | 'room'
    this.dir = null;
    this.flying = true;
    this.yaw = 0;
    this.pitch = -0.3;
    this.vy = 0;
    this.keys = new Set();
    this.items = new Map();      // path → item
    this.pickables = [];
    this.solids = [];            // { x0, x1, z0, z1, top }
    this.extent = 60;
    this.center = new THREE.Vector3();
    this.destroyed = false;
    this.time = 0;
    this.hover = null;
    this._nextMode = null;
    this._returnFrom = null;
    this._mfaOk = false;
    this.topHeight = 0;
    this.plazaFront = 10;
    this.style = styleById(state.settings.city3dStyle || DEFAULT_STYLE).id;
    this.spinners = [];          // halos, flags and smoke the buildings asked to animate
    this.streets = null;         // { xs, zs } of the city's street grid, for the chase
    this.hero = null;
    this.chase = null;
    this._nextHero = 12 + Math.random() * 15;
    this._nextChase = 8 + Math.random() * 12;
    this.trafficOn = state.settings.city3dTraffic === true;
    this.traffic = null;
    this._trafficLayout = null;

    this._buildDom();
    this._initGL();
    this._initSky();
    if (this.trafficOn) this._startTraffic();
    this._last = performance.now();
    this._loop = this._loop.bind(this);
    this.raf = requestAnimationFrame(this._loop);
  }

  /* ---------------- DOM ---------------- */

  _buildDom() {
    this.canvas = el('canvas', { class: 'c3-canvas' });
    this.where = el('div', { class: 'c3-where' });
    this.measureNote = el('div', { class: 'c3-measure' });
    this.trafficNote = el('div', { class: 'c3-measure' });
    this.tip = el('div', { class: 'c3-tip hidden' });
    this.legend = el('div', { class: 'c3-legend' });
    this.cross = el('div', { class: 'c3-cross hidden' });
    const b = (text, title, fn) => el('button', { class: 'c3-btn', text, title, onClick: (e) => { e.stopPropagation(); fn(); this.element.focus({ preventScroll: true }); } });
    this.modeBtn = b('', 'Walk on the ground, or fly (G)', () => this.setFlying(!this.flying));
    this.outBtn = b('', '', () => this.out());
    this.hereBtn = b('🏙 City of here', 'See this folder’s own folders as a city', () => {
      this.mode = 'city';
      this.rebuild({ spawn: true });
      this._measure(this.dir);
    });
    this.homeBtn = b('⌂', 'Back to the overview', () => this._spawn());
    this.trafficBtn = b('🚦 Processes', 'Show this machine’s processes as traffic — cars for CPU, boats for memory, rockets for the biggest', () => this.setTraffic(!this.trafficOn));
    this.maxBtn = b('⤢', 'Fill the window (Esc to come back)', () => this.toggleMax());
    this.helpBtn = b('?', 'How to move around', () => this.help.classList.toggle('hidden'));
    /*
     * What the town is built in. Remembered across folders and launches, since
     * it is a taste rather than a fact about any one folder.
     */
    const groups = [...new Set(CITY_STYLES.map((x) => x.group))];
    this.styleSel = el('select', { class: 'c3-btn c3-style', title: 'Architecture — the shapes change, the heights and colours never do' },
      ...groups.map((gname) => el('optgroup', { label: gname },
        ...CITY_STYLES.filter((x) => x.group === gname).map((x) => el('option', {
          value: x.id, text: x.label, selected: x.id === this.style || null,
        })))));
    this.styleSel.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.styleSel.addEventListener('keydown', (e) => e.stopPropagation());
    this.styleSel.addEventListener('change', () => this.setStyle(this.styleSel.value));
    // Same as pressing 3D again on the toolbar.
    this.listBtn = el('button', {
      class: 'c3-btn', text: '☰ List', title: 'Back to the file list (or press 3D again)',
      onClick: (e) => { e.stopPropagation(); this.ex.toggle3d(false); },
    });
    this.approveBtn = el('button', {
      class: 'c3-btn hidden', text: 'Measure folders (approve MFA)',
      onClick: () => {
        this._mfaOk = true;
        this.approveBtn.classList.add('hidden');
        this._measure(this.dir);
        if (this.traffic) { clearTimeout(this._trafficTimer); this._pollTraffic(); }
      },
    });
    this.help = el('div', { class: 'c3-help hidden' },
      el('div', { class: 'c3-help-h', text: 'Getting around' }),
      ...[
        ['Drag', 'look around'],
        ['W A S D / arrows', 'move'],
        ['Space', 'up (fly) · jump (walk)'],
        ['X', 'down (fly)'],
        ['Shift', 'faster'],
        ['Scroll', 'glide forward and back'],
        ['G', 'walk ⇄ fly'],
        ['Click', 'select · ⌘-click adds'],
        ['Double-click / Enter', 'go in, or open the file'],
        ['Backspace', 'go out'],
        ['/ or ⌘F', 'filter by name'],
        ['Right-click', 'the usual file menu'],
      ].map(([k, v]) => el('div', { class: 'c3-help-row' }, el('kbd', { text: k }), el('span', { text: v }))),
      el('div', { class: 'c3-help-note', text: 'Height is the data under a folder; width is how many files; colours are what kind.' }));

    this.element = el('div', { class: 'c3', tabindex: '0' },
      this.canvas,
      el('div', { class: 'c3-top' },
        el('div', { class: 'c3-top-l' }, this.where, this.measureNote, this.trafficNote, this.approveBtn),
        el('div', { class: 'c3-top-r' }, this.styleSel, this.trafficBtn, this.outBtn, this.hereBtn, this.modeBtn, this.homeBtn, this.maxBtn, this.helpBtn, this.listBtn)),
      this.legend, this.tip, this.cross, this.help);

    const E = this.element;
    E.addEventListener('keydown', (e) => this._onKeyDown(e));
    E.addEventListener('keyup', (e) => this.keys.delete(e.code));
    E.addEventListener('blur', () => this.keys.clear());
    E.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    E.addEventListener('pointermove', (e) => this._onPointerMove(e));
    E.addEventListener('pointerup', (e) => this._onPointerUp(e));
    E.addEventListener('pointerleave', () => { this.tip.classList.add('hidden'); this.hover = null; });
    E.addEventListener('dblclick', (e) => {
      if (e.target !== this.canvas) return;
      const it = this._pickAt(e.clientX, e.clientY);
      if (it) this.activate(it);
    });
    E.addEventListener('contextmenu', (e) => {
      if (e.target !== this.canvas) return;
      const it = this._pickAt(e.clientX, e.clientY);
      e.preventDefault();
      e.stopPropagation();
      this.ex._onContextMenu(e, it?.entry || null);
    });
    E.addEventListener('wheel', (e) => {
      if (e.target !== this.canvas) return;
      e.preventDefault();
      const f = this._forward(this.flying);
      const step = -e.deltaY * 0.02 * (this.flying ? this._flySpeed() / 18 : 1);
      this._moveBy(f.x * step, this.flying ? f.y * step : 0, f.z * step);
    }, { passive: false });
    this.setFlying(true);
    this._paintTrafficBtn();
  }

  /* ---------------- processes as traffic ---------------- */

  _paintTrafficBtn() {
    this.trafficBtn.classList.toggle('active', this.trafficOn);
    this.trafficBtn.textContent = this.trafficOn ? '🚦 Processes on' : '🚦 Processes';
  }

  async setTraffic(on) {
    this.trafficOn = on;
    this._paintTrafficBtn();
    if (!on) this._stopTraffic();
    // The river and the launch pads need room cleared in the woods, and
    // giving it back when they go.
    this.rebuild();
    this._applyState();
    if (on) this._startTraffic();
    try { state.settings = await window.api.settings.set({ city3dTraffic: on }); } catch { /* the toggle still applies for this window */ }
  }

  _startTraffic() {
    if (!this.trafficOn || this.destroyed) return;
    if (!this.traffic) {
      this.traffic = new ProcTraffic(this.scene);
      this.traffic.layout(this.mode === 'city' ? this._trafficLayout : null);
    }
    clearTimeout(this._trafficTimer);
    this._trafficSrc = this.ex.sourceKey;
    this._pollTraffic();
  }

  _stopTraffic() {
    clearTimeout(this._trafficTimer);
    this._trafficTimer = null;
    this.traffic?.dispose();
    this.traffic = null;
    this.trafficNote.textContent = '';
  }

  /**
   * One look at the processes, then the next one booked. Locally every five
   * seconds; on a server every ten, since each look is a command over the
   * connection. A machine with no ps to ask — a Windows server over SSH, a
   * stripped-down appliance — gets a note and no traffic, and the view goes
   * on being a file browser.
   */
  async _pollTraffic() {
    if (!this.trafficOn || !this.traffic || this.destroyed) return;
    const local = this.ex.source.kind === 'local';
    const src = this.ex.sourceKey;
    let next = local ? 5000 : 10000;
    try {
      let procs;
      if (local) procs = await window.api.city.procsLocal();
      else {
        const conn = this.ex.connId ? state.getConnection(this.ex.connId) : null;
        if (!conn || conn.state !== 'connected') {
          this.trafficNote.textContent = 'Processes: waiting for the connection';
          procs = null;
        } else if (needsMfaApproval(conn) && !this._mfaOk) {
          this.trafficNote.textContent = 'Processes: each look would need an MFA approval — approve measuring to allow it';
          this.approveBtn.classList.remove('hidden');
          procs = null;
        } else {
          procs = await window.api.city.procsRemote(this.ex.connId);
        }
      }
      if (this.destroyed || !this.traffic || src !== this.ex.sourceKey) return;
      if (procs) {
        if (!procs.length) throw new Error('ps returned nothing');
        this.traffic.update(procs);
        this.trafficNote.textContent = '';
      }
    } catch (e) {
      if (this.destroyed || !this.traffic) return;
      this.trafficNote.textContent = `Processes: not available here (${String(e.message || e).split('\n')[0].slice(0, 80)}) — the files are all still here`;
      next = 60000;
    }
    this._trafficTimer = setTimeout(() => this._pollTraffic(), next);
  }

  async setStyle(id) {
    const st = styleById(id);
    if (st.id === this.style) return;
    this.style = st.id;
    if (this.styleSel) this.styleSel.value = st.id;
    this.rebuild();
    this._applyState();
    this.element.focus({ preventScroll: true });
    status(`The town is now built in ${st.label.split(' — ')[0]}`);
    try { state.settings = await window.api.settings.set({ city3dStyle: st.id }); } catch { /* the style still applies for this window */ }
  }

  toggleMax(force) {
    const pane = this.ex.element;
    const on = force === undefined ? !pane.classList.contains('c3-max') : force;
    pane.classList.toggle('c3-max', on);
    this.maxBtn.textContent = on ? '⤡' : '⤢';
    this._resize();
  }

  setFlying(on) {
    this.flying = on;
    this.vy = 0;
    this.modeBtn.textContent = on ? '✈ Flying' : '🚶 Walking';
    this.cross.classList.toggle('hidden', on);
  }

  /* ---------------- GL ---------------- */

  _initGL() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(65, 1, 0.1, 5000);
    this.camera.rotation.order = 'YXZ';
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.raycaster = new THREE.Raycaster();
    this.win = windowTextures();
    this.ro = new ResizeObserver(() => this._resize());
    this.ro.observe(this.element);
  }

  _resize() {
    const w = this.element.clientWidth, h = this.element.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Sun or moon, sky, ground, clouds, stars, birds and planes — the parts that never rebuild. */
  _initSky() {
    const light = isLightTheme();
    this.night = !light;
    const sky = light ? 0x9fd3ff : 0x1a2747;
    this.scene.background = new THREE.Color(sky);
    this.scene.fog = new THREE.Fog(sky, 200, 900);

    // Night is dusk rather than dark: the colours are the information.
    this.hemi = new THREE.HemisphereLight(light ? 0xdff1ff : 0x8ea6d8, light ? 0x4f6b3a : 0x2a3140, light ? 0.9 : 1.1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(light ? 0xfff2dc : 0xc4d2ff, light ? 2.2 : 1.3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(6000, 6000),
      new THREE.MeshStandardMaterial({ color: light ? 0x6f9a5a : 0x2f4a35, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    if (this.night) {
      const pts = [];
      for (let i = 0; i < 900; i++) {
        const u = Math.random() * Math.PI * 2, v = Math.random() * 0.45 + 0.08;
        pts.push(Math.cos(u) * Math.cos(v) * 1800, Math.sin(v) * 1800, Math.sin(u) * Math.cos(v) * 1800);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      this.stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, fog: false }));
      this.scene.add(this.stars);
    }

    // Clouds: a few lumps of flat-shaded spheres, drifting.
    this.clouds = [];
    const cloudMat = new THREE.MeshLambertMaterial({ color: light ? 0xffffff : 0x3b465c, flatShading: true });
    const puff = new THREE.IcosahedronGeometry(1, 1);
    for (let i = 0; i < 10; i++) {
      const c = new THREE.Group();
      const n = 4 + (Math.random() * 4 | 0);
      for (let k = 0; k < n; k++) {
        const m = new THREE.Mesh(puff, cloudMat);
        const s = 6 + Math.random() * 8;
        m.scale.set(s * 1.4, s * 0.8, s);
        m.position.set((k - n / 2) * 9 + Math.random() * 4, Math.random() * 4, Math.random() * 8 - 4);
        c.add(m);
      }
      c.userData = { r: 120 + Math.random() * 380, a: Math.random() * Math.PI * 2, speed: 0.004 + Math.random() * 0.006, y: 110 + Math.random() * 60 };
      this.clouds.push(c);
      this.scene.add(c);
    }

    this._initBirds();
    this.planes = [];
    this._nextPlane = 3;
  }

  /* ---------------- birds ---------------- */

  /**
   * Flocks of a few birds each, in a loose V, circling over wherever you are.
   * Fly into one and it scatters.
   */
  _initBirds() {
    this.flocks = [];
    const mat = new THREE.MeshLambertMaterial({ color: this.night ? 0xc9d3e6 : 0x262a33, side: THREE.DoubleSide });
    const wingGeo = new THREE.BufferGeometry();
    wingGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.35, 0, 0, 0.35, 1.5, 0, 0.15], 3));
    wingGeo.computeVertexNormals();
    const bodyGeo = new THREE.ConeGeometry(0.18, 1.1, 5);
    bodyGeo.rotateX(-Math.PI / 2);

    for (let f = 0; f < 4; f++) {
      const flock = new THREE.Group();
      const n = 5 + (Math.random() * 6 | 0);
      const birds = [];
      for (let i = 0; i < n; i++) {
        const bird = new THREE.Group();
        bird.add(new THREE.Mesh(bodyGeo, mat));
        const l = new THREE.Mesh(wingGeo, mat);
        const r = new THREE.Mesh(wingGeo, mat);
        r.scale.x = -1;
        bird.add(l, r);
        const side = i % 2 ? 1 : -1, rank = Math.ceil(i / 2);
        bird.userData = { l, r, off: new THREE.Vector3(side * rank * 2.2, (Math.random() - 0.5) * 0.8, rank * 2.4), ph: Math.random() * 6 };
        bird.userData.item = { kind: 'bird', name: 'a bird' };
        flock.add(bird);
        birds.push(bird);
      }
      flock.userData = {
        birds, r: 40 + Math.random() * 120, alt: 28 + Math.random() * 30, speed: 7 + Math.random() * 5,
        a: Math.random() * Math.PI * 2, dir: Math.random() < 0.5 ? 1 : -1, scare: 0,
        cx: (Math.random() - 0.5) * 60, cz: (Math.random() - 0.5) * 60,
      };
      this.flocks.push(flock);
      this.scene.add(flock);
    }
  }

  _updateBirds(dt) {
    const cam = this.camera.position;
    const base = Math.max(this.topHeight + 12, 24);
    for (const flock of this.flocks) {
      const u = flock.userData;
      u.a += u.dir * dt * u.speed / u.r;
      const cx = this.center.x + u.cx, cz = this.center.z + u.cz;
      const alt = base + u.alt - 24 + Math.sin(this.time * 0.4 + u.r) * 3 + u.scare * 14;
      flock.position.set(cx + Math.cos(u.a) * u.r, alt, cz + Math.sin(u.a) * u.r);
      // Heading: along the circle.
      flock.rotation.y = -u.a + (u.dir > 0 ? Math.PI : 0);
      const near = flock.position.distanceTo(cam) < 14;
      u.scare = near ? Math.min(1, u.scare + dt * 3) : Math.max(0, u.scare - dt * 0.25);
      for (const bird of u.birds) {
        const b = bird.userData;
        const spread = 1 + u.scare * 2.5;
        bird.position.set(b.off.x * spread, b.off.y * spread + Math.sin(this.time * 1.3 + b.ph) * 0.4, b.off.z * spread);
        const flap = Math.sin(this.time * (8 + u.scare * 10) + b.ph) * 0.7;
        b.l.rotation.z = flap;
        b.r.rotation.z = -flap;
      }
    }
  }

  /* ---------------- planes ---------------- */

  _makePlane(banner) {
    const g = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.5, metalness: 0.2 });
    const stripe = new THREE.MeshStandardMaterial({ color: 0x4c8dff, roughness: 0.5 });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.7, 10, 10), white);
    body.rotation.x = Math.PI / 2;
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2, 10), white);
    nose.rotation.x = -Math.PI / 2;
    nose.position.z = -6;
    const wing = new THREE.Mesh(new THREE.BoxGeometry(14, 0.25, 2.2), white);
    wing.position.set(0, -0.2, -0.6);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.6, 1.8), stripe);
    tail.position.set(0, 1.5, 4.3);
    const stab = new THREE.Mesh(new THREE.BoxGeometry(5, 0.2, 1.3), white);
    stab.position.set(0, 0.3, 4.4);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.92, 0.82, 1.2, 10), stripe);
    band.rotation.x = Math.PI / 2;
    band.position.z = 1.5;
    const lamp = (color, x) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 6), new THREE.MeshBasicMaterial({ color }));
      m.position.set(x, -0.2, -0.6);
      return m;
    };
    const red = lamp(0xff3b3b, -7), green = lamp(0x3bff6b, 7);
    const strobe = new THREE.Mesh(new THREE.SphereGeometry(0.25, 6, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    strobe.position.set(0, 2.9, 4.8);
    g.add(body, nose, wing, tail, stab, band, red, green, strobe);
    g.userData = { strobe };
    for (const m of [body, wing, tail]) m.castShadow = true;

    if (banner) {
      const sign = makeLabel([banner], { height: 3.2, bg: 'rgba(255,250,235,.96)', color: '#1c2128', accent: '#d29922' });
      sign.position.set(0, -0.6, 14 + sign.scale.x / 2);
      // A sprite would turn to face you; a banner should not. Two faces, back
      // to back, so it reads the right way round from either side.
      const geo = new THREE.PlaneGeometry(sign.scale.x, sign.scale.y);
      const mat = new THREE.MeshBasicMaterial({ map: sign.material.map, transparent: true });
      const mesh = new THREE.Group();
      const front = new THREE.Mesh(geo, mat);
      const back = new THREE.Mesh(geo, mat);
      back.rotation.y = Math.PI;
      front.userData.ownMap = true;
      mesh.add(front, back);
      mesh.rotation.y = Math.PI / 2;
      mesh.position.copy(sign.position);
      sign.material.dispose();
      const rope = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -0.4, 5), new THREE.Vector3(0, -0.6, 14)]),
        new THREE.LineBasicMaterial({ color: 0x555555 }));
      g.add(mesh, rope);
      g.userData.banner = mesh;
    }
    g.userData.item = { kind: 'plane', name: 'a plane' };
    return g;
  }

  /** Something worth trailing behind a plane, about where you are. */
  _bannerText() {
    const recs = [...this.items.values()].filter((i) => i.kind === 'building' && i.rec);
    const pick = [];
    if (recs.length) {
      const big = recs.reduce((a, b) => (b.rec.bytes > a.rec.bytes ? b : a));
      pick.push(`Biggest here: ${short(big.entry.name, 22)} — ${fmtBytes(big.rec.bytes)}`);
      const total = recs.reduce((s, i) => s + i.rec.bytes, 0);
      pick.push(`${recs.length} folders · ${fmtBytes(total)} below`);
    }
    const base = (this.dir || '').split('/').filter(Boolean).pop() || this.dir || 'here';
    pick.push(`Welcome to ${short(base, 24)}`);
    pick.push('Visit beautiful ' + short(base, 20));
    return pick[Math.floor(Math.random() * pick.length)];
  }

  _updatePlanes(dt) {
    this._nextPlane -= dt;
    if (this._nextPlane <= 0 && this.planes.length < 2) {
      this._nextPlane = 14 + Math.random() * 20;
      const p = this._makePlane(Math.random() < 0.7 ? this._bannerText() : null);
      const L = Math.max(this.extent * 2, 300);
      const h = Math.random() * Math.PI * 2;
      const start = new THREE.Vector3(this.center.x + Math.cos(h) * L, 0, this.center.z + Math.sin(h) * L);
      const lateral = (Math.random() - 0.5) * this.extent;
      const end = new THREE.Vector3(this.center.x - Math.cos(h) * L - Math.sin(h) * lateral, 0, this.center.z - Math.sin(h) * L + Math.cos(h) * lateral);
      const alt = Math.max(this.topHeight + 35, 70) + Math.random() * 40;
      start.y = end.y = alt;
      p.position.copy(start);
      p.lookAt(end);
      p.rotateY(Math.PI);       // the model's nose is -z; lookAt points +z at the target
      p.userData.from = start;
      p.userData.to = end;
      p.userData.t = 0;
      p.userData.dur = start.distanceTo(end) / (32 + Math.random() * 14);
      this.planes.push(p);
      this.scene.add(p);
    }
    for (const p of [...this.planes]) {
      const u = p.userData;
      u.t += dt / u.dur;
      p.position.lerpVectors(u.from, u.to, u.t);
      p.position.y += Math.sin(u.t * 8) * 0.6;
      u.strobe.visible = (this.time % 1.2) < 0.08;
      if (u.banner) u.banner.rotation.x = Math.sin(this.time * 6) * 0.06;
      if (u.t >= 1) {
        this.scene.remove(p);
        dispose(p);
        this.planes.splice(this.planes.indexOf(p), 1);
      }
    }
  }

  /* ---------------- explorer → view ---------------- */

  /** Called whenever the explorer redraws. Cheap unless the folder changed. */
  sync() {
    const v = this.ex.view;
    if (!v.path && v.path !== '') return;
    const sig = this._signature();
    if (v.path !== this.dir || this.ex.sourceKey !== this.src) {
      if (this._nextMode) this.mode = this._nextMode;
      this._nextMode = null;
      this.dir = v.path;
      this.src = this.ex.sourceKey;
      this._sig = sig;
      this.rebuild({ spawn: true });
      this._measure(this.dir);
      // Another machine is other processes.
      if (this.trafficOn && this._trafficSrc !== this.src) { this._stopTraffic(); this._startTraffic(); }
    } else if (sig !== this._sig) {
      this._sig = sig;
      this.rebuild();
    }
    this._applyState();
  }

  _signature() {
    const v = this.ex.view;
    return [v.path, state.showHidden, this.mode, ...v.entries.map((e) => e.name + ':' + e.size + ':' + e.type)].join('|');
  }

  /** Forget the measurements for the folder on screen, and take them again. */
  invalidate() {
    scans.delete(this._scanKey(this.dir));
    this._measure(this.dir);
  }

  _scanKey(dir) { return this.ex.sourceKey + '|' + dir; }

  async _measure(dir) {
    if (dir === null || dir === undefined) return;
    const key = this._scanKey(dir);
    if (scans.has(key)) { this._noteMeasured(scans.get(key)); return; }
    const local = this.ex.source.kind === 'local';
    const connId = this.ex.connId;
    if (!local) {
      const conn = connId ? state.getConnection(connId) : null;
      if (!conn || conn.state !== 'connected') return;
      // On a per-session-MFA host a scan is one more approval; ask first.
      if (needsMfaApproval(conn) && !this._mfaOk) {
        this.measureNote.textContent = 'Buildings are not measured yet.';
        this.approveBtn.classList.remove('hidden');
        return;
      }
    }
    this.approveBtn.classList.add('hidden');
    this.measureNote.textContent = 'Measuring the folders…';
    let p = inflight.get(key);
    if (!p) {
      p = local ? window.api.city.scanLocal(dir) : window.api.city.scanRemote(connId, dir);
      inflight.set(key, p);
    }
    try {
      const r = await p;
      scans.set(key, r);
      if (this.destroyed || this.dir !== dir) return;
      this._noteMeasured(r);
      this.rebuild();
      this._applyState();
    } catch (e) {
      if (this.dir === dir) this.measureNote.textContent = 'Could not measure: ' + e.message;
    } finally {
      inflight.delete(key);
    }
  }

  _noteMeasured(r) {
    this.measureNote.textContent = r.truncated
      ? 'Stopped measuring early — big trees are a floor, not the total.'
      : '';
  }

  _rec(entry) {
    const s = scans.get(this._scanKey(this.dir));
    if (!s) return null;
    return s.children?.[entry.name] || { bytes: 0, files: 0, dirs: 0, kinds: {} };
  }

  /* ---------------- building the world ---------------- */

  rebuild({ spawn = false } = {}) {
    this.tip.classList.add('hidden');
    this.hover = null;
    const prev = new Map([...this.items].map(([p, it]) => [p, it.h]));
    dispose(this.world);
    this.scene.remove(this.world);
    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.items = new Map();
    this.pickables = [];
    this.solids = [];
    this.topHeight = 0;
    this.spinners = [];
    this.streets = null;
    this._trafficLayout = null;
    // A chase mid-way through streets that just moved would drive through walls.
    this._endChase();

    // Hidden files go; the name filter only dims, so a filter reads as "these, here".
    const entries = sortEntries(this.ex._notHidden(this.ex.view.entries), this.ex._sortOpts());
    const dirs = entries.filter(isDir);
    const files = entries.filter((e) => !isDir(e));
    if (this.mode === 'room') this._buildRoom(dirs, files, prev);
    else this._buildCity(dirs, files, prev);

    this._drawLegend();
    this._syncHud();
    this._sig = this._signature();

    // Shadows cover the place you are in, whatever its size.
    const ext = this.extent;
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -ext;
    sc.right = sc.top = ext;
    sc.near = 1;
    sc.far = ext * 4 + 300;
    sc.updateProjectionMatrix();
    this.sun.position.set(this.center.x + ext * 0.6, ext * 1.4 + 120, this.center.z + ext * 0.4);
    this.sun.target.position.copy(this.center);
    this.scene.fog.near = Math.max(120, ext * 1.4);
    this.scene.fog.far = Math.max(700, ext * 5);

    this.traffic?.layout(this.mode === 'city' ? this._trafficLayout : null);
    if (spawn) this._spawn();
  }

  _material(color) {
    return new THREE.MeshStandardMaterial({
      color,
      map: this.win.map,
      emissiveMap: this.win.emissive,
      emissive: this.night ? 0xffcf7a : 0x000000,
      emissiveIntensity: this.night ? 0.55 : 0,
      roughness: 0.75,
      metalness: 0.08,
    });
  }

  _buildCity(dirs, files, prev) {
    const shown = dirs.slice(0, MAX_BUILDINGS);
    const n = shown.length;
    const cols = Math.max(MIN_GRID, Math.ceil(Math.sqrt(n * 1.3)));
    const rows = Math.max(MIN_GRID, Math.ceil(n / cols));
    const width = cols * CELL;
    const x0 = -(cols - 1) * CELL / 2;
    const z0 = -CELL / 2 - 8;                       // the first row's centre
    const zFront = z0 + CELL / 2;                   // the street you arrive on
    const zBack = z0 - (rows - 1) * CELL - CELL / 2;
    const cellAt = (i) => ({ x: x0 + (i % cols) * CELL, z: z0 - Math.floor(i / cols) * CELL });

    // Streets: one slab of asphalt under the blocks, pavements on top.
    const road = new THREE.Mesh(
      new THREE.BoxGeometry(width + 12, 0.1, rows * CELL + 12),
      new THREE.MeshStandardMaterial({ color: this.night ? 0x262b35 : 0x3a3f47, roughness: 0.95 }));
    road.position.set(0, 0.05, (zFront + zBack) / 2);
    road.receiveShadow = true;
    this.world.add(road);

    const paveMat = new THREE.MeshStandardMaterial({ color: this.night ? 0x4a515e : 0xb9bdc4, roughness: 0.9 });
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x1b1f27, roughness: 0.6, emissive: this.night ? 0x332200 : 0 });

    shown.forEach((entry, i) => {
      const { x, z } = cellAt(i);
      const rec = this._rec(entry);
      const w = rec ? footFor(rec.files) : 12;
      const h = rec ? (rec.bytes ? heightFor(rec.bytes) : 1.6) : 4.4;
      this.topHeight = Math.max(this.topHeight, h);

      const pave = new THREE.Mesh(new THREE.BoxGeometry(w + 5, 0.3, w + 5), paveMat);
      pave.position.set(x, 0.2, z);
      pave.receiveShadow = true;
      this.world.add(pave);

      const g = new THREE.Group();
      g.position.set(x, 0.35, z);
      const mats = [];
      const bs = rec ? bands(rec) : [];
      if (!bs.length) bs.push([rec ? 'empty' : 'measuring', 1]);
      // The shape is the style's; the height, footprint and bands are the
      // folder's, whichever style is chosen.
      const built = buildTower(g, {
        styleId: this.style,
        seed: entry.path,
        w, h,
        bands: bs.map(([k, b]) => [k === 'empty' ? EMPTY : k === 'measuring' ? MEASURING : KIND_COLORS[k], b]),
        bandMat: (color) => { const m = this._material(color); mats.push(m); return m; },
        accent: (color, { metal = 0.1, glow = 0 } = {}) => {
          const m = new THREE.MeshStandardMaterial({
            color, roughness: 0.7 - metal * 0.4, metalness: metal,
            emissive: glow ? color : 0x000000, emissiveIntensity: glow * (this.night ? 1 : 0.5),
          });
          mats.push(m);
          return m;
        },
        box: scaledBox,
        night: this.night,
      });
      const H = built.H;
      for (const s of built.spin) this.spinners.push({ ...s, group: g });
      const dh = Math.min(4.2, H);
      const door = new THREE.Mesh(new THREE.BoxGeometry(3, dh, 0.3), doorMat);
      door.position.set(0, dh / 2, w / 2 + 0.08);
      g.add(door);

      const item = { kind: 'building', entry, rec, group: g, mats, h: H, w, x, z };
      g.traverse((o) => { if (o.isMesh) { o.userData.item = item; this.pickables.push(o); } });
      const from = prev.get(entry.path);
      item.grow = from === undefined ? 0.02 : clamp(from / H, 0.02, 4);
      g.scale.y = item.grow;
      this.world.add(g);

      item.label = makeLabel([short(entry.name), rec ? fmtBytes(rec.bytes) : 'measuring…'], { height: 3.6, accent: css(rec && bands(rec)[0] ? KIND_COLORS[bands(rec)[0][0]] : MEASURING) });
      item.labelY = built.top + 4;
      this.topHeight = Math.max(this.topHeight, built.top);
      item.label.position.set(x, item.labelY * item.grow + 0.35, z);
      item.label.userData.item = item;
      item.label.userData.near = 260;
      item.label.userData.base = item.label.scale.clone();
      this.world.add(item.label);

      this.items.set(entry.path, item);
      this.solids.push({ x0: x - w / 2, x1: x + w / 2, z0: z - w / 2, z1: z + w / 2, top: H + 0.35 });
    });

    // Blocks with no folder on them are parks, so a small folder is still a town.
    const parks = [];
    for (let i = n; i < cols * rows; i++) parks.push(cellAt(i));
    const grassMat = new THREE.MeshStandardMaterial({ color: this.night ? 0x35583c : 0x7fb069, roughness: 1 });
    const trees = [];
    for (const p of parks) {
      const lawn = new THREE.Mesh(new THREE.BoxGeometry(CELL - 8, 0.3, CELL - 8), grassMat);
      lawn.position.set(p.x, 0.2, p.z);
      lawn.receiveShadow = true;
      this.world.add(lawn);
      const k = 4 + (Math.random() * 5 | 0);
      for (let t = 0; t < k; t++) {
        trees.push([p.x + (Math.random() - 0.5) * (CELL - 14), p.z + (Math.random() - 0.5) * (CELL - 14), 0.8 + Math.random() * 0.7]);
      }
    }
    // With the processes shown, a river behind the town and launch pads to
    // the east — and the woods kept off both.
    const riverZ = zBack - 34;
    const padX = width / 2 + 36;
    const padsZ = [zFront - 14, zFront - 48, zFront - 82];
    const clearing = this.trafficOn
      ? (x, z) => Math.abs(z - riverZ) < 17 || (x > padX - 16 && x < padX + 16 && z < zFront + 4 && z > padsZ[2] - 14)
      : () => false;
    if (this.trafficOn) {
      this._trafficLayout = {
        river: { z: riverZ, width: 24, x0: -width / 2 - 240, x1: width / 2 + 240 },
        pads: padsZ.map((z) => ({ x: padX, z })),
        night: this.night,
        hover: this.style === 'future',
      };
    }
    // A belt of woods around the edge of town, out to the horizon-ish.
    const rx = width / 2 + 14, rz0 = zBack - 14, rz1 = zFront + 14;
    for (let t = 0; t < 420; t++) {
      const a = Math.random() * Math.PI * 2;
      const d = 10 + Math.pow(Math.random(), 0.7) * 160;
      let x = Math.cos(a) * (rx + d);
      let z = (rz0 + rz1) / 2 + Math.sin(a) * ((rz1 - rz0) / 2 + d);
      // Keep the approach to the plaza open.
      if (z > zFront && Math.abs(x) < width / 2 + 10) continue;
      if (clearing(x, z)) continue;
      trees.push([x, z, 0.8 + Math.random() * 1.1]);
    }
    this._trees(trees);
    this._lamps(cols, rows, x0, z0);
    if (this._trafficLayout) this._trafficLayout.streets = null;
    this.streets = {
      xs: Array.from({ length: cols + 1 }, (_, c) => x0 - CELL / 2 + c * CELL),
      zs: Array.from({ length: rows + 1 }, (_, r) => z0 + CELL / 2 - r * CELL),
    };
    if (this._trafficLayout) this._trafficLayout.streets = this.streets;

    // The plaza: loose files, in front of the city where you arrive.
    const plazaFiles = [...files].sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, MAX_CRATES);
    const PX = 4, PZ = 4.2;
    const pcols = Math.max(10, Math.floor(Math.max(width * 0.7, 60) / PX));
    const pStart = zFront + 14;
    plazaFiles.forEach((entry, i) => {
      const c = i % pcols, r = Math.floor(i / pcols);
      this._crate(entry, -(pcols - 1) * PX / 2 + c * PX, pStart + r * PZ, prev, { small: true });
    });
    const plazaDepth = plazaFiles.length ? Math.ceil(plazaFiles.length / pcols) * PZ + 8 : 0;
    if (plazaFiles.length) {
      const plaza = new THREE.Mesh(
        new THREE.BoxGeometry(pcols * PX + 8, 0.12, plazaDepth + 4),
        new THREE.MeshStandardMaterial({ color: this.night ? 0x5a5240 : 0xd8cfb8, roughness: 0.95 }));
      plaza.position.set(0, 0.06, pStart - 4 + plazaDepth / 2);
      plaza.receiveShadow = true;
      this.world.add(plaza);
    }
    if (files.length > plazaFiles.length) {
      const sign = makeLabel([`+${files.length - plazaFiles.length} more files`, 'the list view has them all'], { height: 1.4 });
      sign.position.set(0, 4, pStart + plazaDepth);
      this.world.add(sign);
    }

    if (!n && !files.length) {
      const sign = makeLabel(['Nothing here', 'an empty lot'], { height: 3 });
      sign.position.set(0, 6, z0);
      this.world.add(sign);
    }

    const depth = (zFront - zBack) + plazaDepth + 30;
    this.extent = Math.max(90, Math.max(width, depth) / 2 + 30);
    this.center.set(0, 0, (zBack + zFront + plazaDepth) / 2);
    this.bounds = null;
    this.plazaFront = pStart + plazaDepth;
  }

  /** Trees as two instanced meshes: one draw call for a forest. */
  _trees(list) {
    if (!list.length) return;
    const trunkGeo = new THREE.CylinderGeometry(0.35, 0.5, 3, 6);
    trunkGeo.translate(0, 1.5, 0);
    const leafGeo = new THREE.ConeGeometry(2.6, 7, 7);
    leafGeo.translate(0, 6, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 }), list.length);
    const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true }), list.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), c = new THREE.Color();
    const greens = this.night ? [0x2e5a3a, 0x3a6b45, 0x284d33] : [0x3f8f4a, 0x2f7a3d, 0x5aa04f, 0x4b8a3c];
    list.forEach(([x, z, sc], i) => {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * 6);
      m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(sc, sc, sc));
      trunks.setMatrixAt(i, m);
      leaves.setMatrixAt(i, m);
      leaves.setColorAt(i, c.setHex(greens[i % greens.length]));
    });
    trunks.castShadow = leaves.castShadow = true;
    this.world.add(trunks, leaves);
  }

  /** Street lamps at the crossroads — lit at night. */
  _lamps(cols, rows, x0, z0) {
    const pts = [];
    for (let c = 0; c <= cols; c++) {
      for (let r = 0; r <= rows; r++) pts.push([x0 - CELL / 2 + c * CELL, z0 + CELL / 2 - r * CELL]);
    }
    const poleGeo = new THREE.CylinderGeometry(0.15, 0.2, 7, 6);
    poleGeo.translate(0, 3.5, 0);
    const bulbGeo = new THREE.SphereGeometry(0.55, 10, 8);
    bulbGeo.translate(0, 7.2, 0);
    const poles = new THREE.InstancedMesh(poleGeo, new THREE.MeshStandardMaterial({ color: 0x2b303a, roughness: 0.6, metalness: 0.4 }), pts.length);
    const bulbs = new THREE.InstancedMesh(bulbGeo, new THREE.MeshStandardMaterial({
      color: 0xfff2c8, emissive: 0xffd27a, emissiveIntensity: this.night ? 2.2 : 0.2,
    }), pts.length);
    const m = new THREE.Matrix4();
    pts.forEach(([x, z], i) => {
      m.makeTranslation(x, 0, z);
      poles.setMatrixAt(i, m);
      bulbs.setMatrixAt(i, m);
    });
    this.world.add(poles, bulbs);
  }

  _crate(entry, x, z, prev, { small = false } = {}) {
    const s = crateFor(entry.size) * (small ? 1.2 : 1);
    const k = kindOf(entry.name);
    const mat = new THREE.MeshStandardMaterial({ color: KIND_COLORS[k], roughness: 0.55, metalness: 0.1 });
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const box = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), mat);
    box.position.y = s / 2;
    box.castShadow = box.receiveShadow = true;
    // A lid strip so a crate reads as a crate rather than a cube.
    const lid = new THREE.Mesh(new THREE.BoxGeometry(s * 1.04, s * 0.08, s * 1.04),
      new THREE.MeshStandardMaterial({ color: 0x2b303a, roughness: 0.7 }));
    lid.position.y = s * 0.96;
    g.add(box, lid);
    const item = { kind: 'crate', entry, group: g, mats: [mat], h: s, w: s, x, z };
    for (const m of [box, lid]) { m.userData.item = item; this.pickables.push(m); }
    const from = prev.get(entry.path);
    item.grow = from === undefined ? 0.02 : 1;
    g.scale.y = item.grow;
    this.world.add(g);
    item.label = makeLabel([short(entry.name, 30), fmtBytes(entry.size || 0)], { height: small ? 0.5 : 0.38 });
    item.labelY = s + 0.6;
    item.label.position.set(x, item.labelY, z);
    item.label.userData.item = item;
    item.label.userData.near = small ? 22 : 14;
    this.world.add(item.label);
    this.items.set(entry.path, item);
    this.solids.push({ x0: x - s / 2, x1: x + s / 2, z0: z - s / 2, z1: z + s / 2, top: s });
    return item;
  }

  _buildRoom(dirs, files, prev) {
    const crates = files.slice(0, MAX_CRATES);
    const SP = 3.4;
    const fc = Math.max(1, Math.ceil(Math.sqrt(crates.length)));
    const doors = dirs.slice(0, MAX_BUILDINGS);
    let W = Math.max(16, fc * SP + 8);
    let D = Math.max(16, Math.ceil(crates.length / fc) * SP + 10);
    // Room enough on the walls for every door, leaving the exit clear.
    const need = doors.length * 4 + 8;
    if (2 * W + 2 * D < need) { const k = need / (2 * W + 2 * D); W = Math.ceil(W * k); D = Math.ceil(D * k); }
    const WALL = 6, T = 0.4;

    const floor = new THREE.Mesh(new THREE.BoxGeometry(W, 0.2, D),
      new THREE.MeshStandardMaterial({ color: this.night ? 0x4a3a2a : 0xa98463, roughness: 0.85 }));
    floor.position.y = 0.1;
    floor.receiveShadow = true;
    this.world.add(floor);

    const wallMat = new THREE.MeshStandardMaterial({ color: this.night ? 0x59606e : 0xe9e4da, roughness: 0.9 });
    const wall = (x, z, w, d) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, WALL, d), wallMat);
      m.position.set(x, WALL / 2, z);
      m.castShadow = m.receiveShadow = true;
      this.world.add(m);
      this.solids.push({ x0: x - w / 2, x1: x + w / 2, z0: z - d / 2, z1: z + d / 2, top: WALL });
    };
    const GAP = 3.2;
    wall(0, -D / 2, W + T, T);
    wall(-W / 2, 0, T, D);
    wall(W / 2, 0, T, D);
    wall(-(W / 2 + GAP / 2) / 2, D / 2, W / 2 - GAP / 2, T);
    wall((W / 2 + GAP / 2) / 2, D / 2, W / 2 - GAP / 2, T);

    // Exit: the gap in the south wall, with a sign over it.
    const exitSign = makeLabel(['⇦ Out to the street'], { height: 0.7, bg: 'rgba(26,127,55,.92)' });
    exitSign.position.set(0, 3.6, D / 2 - 0.3);
    exitSign.userData.item = { kind: 'exit', name: 'the way out' };
    this.world.add(exitSign);
    this.pickables.push(exitSign);

    // Doors around the walls: north, then east, west, then the south either side of the exit.
    const slots = [];
    const along = (len, f) => { const k = Math.floor((len - 2) / 4); for (let i = 0; i < k; i++) f(-len / 2 + 1 + 2 + i * 4 + ((len - 2) - k * 4) / 2); };
    along(W, (x) => slots.push({ x, z: -D / 2 + T / 2 + 0.06, ry: 0 }));
    along(D, (z) => slots.push({ x: W / 2 - T / 2 - 0.06, z, ry: -Math.PI / 2 }));
    along(D, (z) => slots.push({ x: -W / 2 + T / 2 + 0.06, z, ry: Math.PI / 2 }));
    along(W, (x) => { if (Math.abs(x) > GAP / 2 + 2) slots.push({ x, z: D / 2 - T / 2 - 0.06, ry: Math.PI }); });
    const frameDark = new THREE.MeshStandardMaterial({ color: 0x1b1f27, roughness: 0.6 });
    doors.forEach((entry, i) => {
      const s = slots[i];
      if (!s) return;
      const rec = this._rec(entry);
      const k = rec ? (bands(rec)[0]?.[0] || 'other') : null;
      const color = rec ? (rec.bytes ? KIND_COLORS[k] : EMPTY) : MEASURING;
      const g = new THREE.Group();
      g.position.set(s.x, 0, s.z);
      g.rotation.y = s.ry;
      const frameMat = new THREE.MeshStandardMaterial({ color, roughness: 0.6 });
      const frame = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3.4, 0.25), frameMat);
      frame.position.y = 1.7;
      const panel = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 0.3), frameDark);
      panel.position.set(0, 1.5, 0.05);
      const knob = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), new THREE.MeshStandardMaterial({ color: 0xd2b048, metalness: 0.8, roughness: 0.3 }));
      knob.position.set(0.7, 1.4, 0.25);
      g.add(frame, panel, knob);
      const item = { kind: 'door', entry, rec, group: g, mats: [frameMat], h: 3.4, w: 2.6, x: s.x, z: s.z };
      for (const m of [frame, panel, knob]) { m.userData.item = item; this.pickables.push(m); }
      this.world.add(g);
      item.label = makeLabel(['📁 ' + short(entry.name, 22), rec ? fmtBytes(rec.bytes) + (rec.files ? ` · ${rec.files} files` : '') : '…'], { height: 0.42 });
      const inward = new THREE.Vector3(0, 0, 0.6).applyAxisAngle(new THREE.Vector3(0, 1, 0), s.ry);
      item.label.position.set(s.x + inward.x, 4.1, s.z + inward.z);
      item.labelY = 4.1;
      item.grow = 1;
      item.label.userData.item = item;
      this.world.add(item.label);
      this.items.set(entry.path, item);
    });
    if (doors.length > slots.length) {
      const sign = makeLabel([`+${doors.length - slots.length} more folders`], { height: 0.6 });
      sign.position.set(0, 5, -D / 2 + 1);
      this.world.add(sign);
    }

    // Crates in aisles.
    const cx0 = -(fc - 1) * SP / 2;
    crates.forEach((entry, i) => {
      const c = i % fc, r = Math.floor(i / fc);
      this._crate(entry, cx0 + c * SP, -D / 2 + 4 + r * SP, prev);
    });
    if (files.length > crates.length) {
      const sign = makeLabel([`+${files.length - crates.length} more files`, 'the list view has them all'], { height: 0.5 });
      sign.position.set(0, 2.5, D / 2 - 3);
      this.world.add(sign);
    }
    if (!files.length && !doors.length) {
      const sign = makeLabel(['An empty room'], { height: 0.8 });
      sign.position.set(0, 2.5, 0);
      this.world.add(sign);
    }

    // A ceiling light per few metres, for night.
    if (this.night) {
      const lamp = new THREE.PointLight(0xffe2b0, 40, Math.max(W, D) * 1.2, 1.6);
      lamp.position.set(0, WALL + 2, 0);
      this.world.add(lamp);
    }

    this.topHeight = WALL;
    this.extent = Math.max(40, Math.max(W, D) / 2 + 10);
    this.center.set(0, 0, 0);
    this.bounds = { W, D, GAP };
  }

  /* ---------------- where you stand ---------------- */

  _spawn() {
    const cam = this.camera.position;
    if (this.mode === 'room') {
      this.setFlying(false);
      cam.set(0, EYE, this.bounds.D / 2 - 2);
      this.yaw = 0;
      this.pitch = -0.08;
      return;
    }
    const back = this._returnFrom && this.items.get(this._returnFrom);
    this._returnFrom = null;
    if (back) {
      // Out of the door you went in by, facing the building.
      cam.set(back.x, this.flying ? 12 : EYE, back.z + back.w / 2 + 6);
      this.yaw = 0;
      this.pitch = this.flying ? -0.2 : 0.05;
      return;
    }
    // Far enough back and up to see the whole city, tallest tower included.
    const h = Math.max(24, this.extent * 0.75, this.topHeight * 0.9);
    if (this.flying) {
      const back = this.plazaFront + this.extent * 1.05;
      cam.set(0, h, back);
      this.yaw = 0;
      this.pitch = -Math.atan2(h - this.topHeight * 0.35, back - this.center.z);
    } else {
      cam.set(0, EYE, this.plazaFront + 4);
      this.yaw = 0;
      this.pitch = 0.05;
    }
  }

  _flySpeed() { return Math.max(18, this.extent / 3.5); }

  _forward(withPitch) {
    const cp = withPitch ? Math.cos(this.pitch) : 1;
    return new THREE.Vector3(-Math.sin(this.yaw) * cp, withPitch ? Math.sin(this.pitch) : 0, -Math.cos(this.yaw) * cp);
  }

  /** Height of whatever you would be standing on at (x, z) from this foot height. */
  _groundAt(x, z, feet) {
    let g = 0;
    for (const s of this.solids) {
      if (x > s.x0 - 0.3 && x < s.x1 + 0.3 && z > s.z0 - 0.3 && z < s.z1 + 0.3 && s.top <= feet + 0.45) g = Math.max(g, s.top);
    }
    return g;
  }

  _moveBy(dx, dy, dz) {
    const p = this.camera.position;
    let nx = p.x + dx, nz = p.z + dz;
    if (!this.flying || this.mode === 'room') {
      const feet = p.y - EYE;
      const R = 0.4;
      for (const s of this.solids) {
        if (s.top <= feet + 0.45) continue;              // you are above it, or can step onto it
        if (!this.flying && feet > s.top) continue;
        if (this.flying && p.y > s.top + 1) continue;
        const inX = nx > s.x0 - R && nx < s.x1 + R;
        const inZ = nz > s.z0 - R && nz < s.z1 + R;
        if (!inX || !inZ) continue;
        // Push out along whichever axis you came in on.
        const wasX = p.x > s.x0 - R && p.x < s.x1 + R;
        if (!wasX) nx = p.x;
        else nz = p.z;
      }
    }
    p.x = nx;
    p.z = nz;
    p.y = Math.max(0.6, p.y + dy);
    if (this.mode === 'room' && this.bounds && p.z > this.bounds.D / 2 + 1.2) this.out();
  }

  _update(dt) {
    const K = this.keys;
    const fast = K.has('ShiftLeft') || K.has('ShiftRight');
    if (K.has('ArrowLeft')) this.yaw += dt * 1.8;
    if (K.has('ArrowRight')) this.yaw -= dt * 1.8;
    let fwd = 0, side = 0;
    if (K.has('KeyW') || K.has('ArrowUp')) fwd += 1;
    if (K.has('KeyS') || K.has('ArrowDown')) fwd -= 1;
    if (K.has('KeyD')) side += 1;
    if (K.has('KeyA')) side -= 1;

    const p = this.camera.position;
    if (this.flying) {
      const sp = this._flySpeed() * (fast ? 3 : 1) * dt;
      const f = this._forward(true);
      const r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      let up = 0;
      if (K.has('Space')) up += 1;
      if (K.has('KeyX') || K.has('KeyC')) up -= 1;
      if (fwd || side || up) this._moveBy((f.x * fwd + r.x * side) * sp, (f.y * fwd + up) * sp, (f.z * fwd + r.z * side) * sp);
    } else {
      const sp = (fast ? 13 : 6) * dt;
      const f = this._forward(false);
      const r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      if (fwd || side) this._moveBy((f.x * fwd + r.x * side) * sp, 0, (f.z * fwd + r.z * side) * sp);
      const ground = this._groundAt(p.x, p.z, p.y - EYE);
      const feet = p.y - EYE;
      if (feet <= ground + 0.001 && this.vy <= 0) {
        p.y = ground + EYE;
        this.vy = 0;
        if (K.has('Space')) this.vy = 7.5;
      } else {
        this.vy -= 22 * dt;
        p.y = Math.max(ground + EYE, p.y + this.vy * dt);
      }
    }
    this.pitch = clamp(this.pitch, -1.5, 1.5);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
  }

  _animate(dt) {
    const step = dt * 2.2;
    for (const it of this.items.values()) {
      if (it.grow === 1) continue;
      it.grow = it.grow < 1 ? Math.min(1, it.grow + step) : Math.max(1, it.grow - step);
      it.group.scale.y = it.grow;
      if (it.label && it.kind !== 'door') it.label.position.y = it.labelY * it.grow + (it.kind === 'building' ? 0.3 : 0);
    }
    // Selected things bob a little and wear a ring of light.
    for (const it of this.items.values()) {
      if (!it.beacon) continue;
      it.beacon.rotation.y += dt * 1.5;
      it.beacon.material.opacity = 0.35 + Math.sin(this.time * 4) * 0.15;
    }
    for (const c of this.clouds) {
      const u = c.userData;
      u.a += u.speed * dt;
      c.position.set(this.center.x + Math.cos(u.a) * u.r, u.y, this.center.z + Math.sin(u.a) * u.r);
    }
    if (this.stars) this.stars.position.copy(this.camera.position);
    for (const s of this.spinners) {
      if (s.kind === 'halo') s.obj.rotation.z += dt * s.speed;
      else if (s.kind === 'flag') s.obj.rotation.y = Math.sin(this.time * 3 + s.obj.id) * 0.35;
      else if (s.kind === 'smoke') this._smoke(s, dt);
    }
  }

  /** A mill chimney's smoke: a few puffs that rise, swell and fade, then start again. */
  _smoke(s, dt) {
    if (!s.puffs) {
      s.puffs = [];
      for (let i = 0; i < 5; i++) {
        const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.8, 0),
          new THREE.MeshLambertMaterial({ color: 0x8a8f99, transparent: true, depthWrite: false, flatShading: true }));
        m.userData.t = i / 5;
        s.group.add(m);
        s.puffs.push(m);
      }
    }
    for (const m of s.puffs) {
      const t = (m.userData.t = (m.userData.t + dt * 0.22) % 1);
      m.position.set(s.at.x + t * 3, s.at.y + t * 7, s.at.z - t * 1.5);
      m.scale.setScalar(0.6 + t * 2.2);
      m.material.opacity = 0.55 * (1 - t);
    }
  }

  /* ---------------- visitors ---------------- */

  /**
   * Now and then a superhero crosses town, high enough to clear the tallest
   * building, with a barrel roll somewhere over the middle for no reason.
   */
  _updateHero(dt) {
    if (!this.hero) {
      this._nextHero -= dt;
      if (this._nextHero > 0) return;
      this._nextHero = 35 + Math.random() * 45;
      const hero = makeHero();
      const L = Math.max(this.extent * 1.6, 220);
      const a = Math.random() * Math.PI * 2;
      const lateral = (Math.random() - 0.5) * this.extent * 0.8;
      const from = new THREE.Vector3(this.center.x + Math.cos(a) * L, 0, this.center.z + Math.sin(a) * L);
      const to = new THREE.Vector3(this.center.x - Math.cos(a) * L - Math.sin(a) * lateral, 0, this.center.z - Math.sin(a) * L + Math.cos(a) * lateral);
      const alt = Math.max(this.topHeight + 10, 26) + Math.random() * 12;
      hero.userData.path = { from, to, alt, t: 0, dur: from.distanceTo(to) / (48 + Math.random() * 20), roll: 0.35 + Math.random() * 0.3 };
      this.hero = hero;
      this.scene.add(hero);
    }
    const h = this.hero;
    const u = h.userData.path;
    u.t += dt / u.dur;
    const p = new THREE.Vector3().lerpVectors(u.from, u.to, u.t);
    // Swoop in, level off over the town, climb away.
    p.y = u.alt + Math.cos(u.t * Math.PI * 2) * 6;
    h.position.copy(p);
    h.lookAt(u.to.x, p.y, u.to.z);
    h.rotateY(Math.PI);
    const r = (u.t - u.roll) / 0.08;
    h.rotateZ(r > 0 && r < 1 ? r * Math.PI * 2 : Math.sin(this.time * 1.5) * 0.12);
    h.rotateX(-Math.sin(u.t * Math.PI * 2) * 0.25);
    flapCape(h, this.time, 1.2);
    if (u.t >= 1) {
      this.scene.remove(h);
      dispose(h);
      this.hero = null;
    }
  }

  /**
   * A getaway car through the streets, with the police right behind it,
   * lights going. Only in a city — a room has no streets — and never more
   * than one at a time.
   */
  _updateChase(dt) {
    if (!this.chase) {
      if (this.mode !== 'city' || !this.streets) return;
      this._nextChase -= dt;
      if (this._nextChase > 0) return;
      this._nextChase = 30 + Math.random() * 40;
      const route = chaseRoute(this.streets);
      if (!route) return;
      const hover = this.style === 'future';
      const suspect = makeCar({ color: [0xd6452f, 0xe0b000, 0x2e8b57, 0x8e44ad, 0xf2f4f8][Math.floor(Math.random() * 5)], hover });
      const police = makeCar({ police: true, hover });
      this.chase = { route, suspect, police, s: 0, speed: 24 + Math.random() * 6, gap: 13 + Math.random() * 4 };
      this.scene.add(suspect, police);
    }
    const c = this.chase;
    c.s += dt * c.speed;
    const place = (car, s) => {
      const p = c.route.at(s);
      const ahead = c.route.at(s + 2.5);
      car.position.set(p.x, 0.12 + (car.userData.lift ? Math.sin(this.time * 3 + s) * 0.15 : 0), p.z);
      if (ahead.distanceToSquared(p) > 1e-4) {
        const want = Math.atan2(-(ahead.x - p.x), -(ahead.z - p.z));
        // Turn into the corner rather than snapping to the new street.
        let d = want - car.rotation.y;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        car.rotation.y += d * Math.min(1, dt * 9);
      }
      spinWheels(car, s);
    };
    place(c.suspect, c.s);
    place(c.police, Math.max(0, c.s - c.gap));
    flashLights(c.police, this.time);
    if (c.s - c.gap >= c.route.length) this._endChase();
  }

  _endChase() {
    if (!this.chase) return;
    for (const car of [this.chase.suspect, this.chase.police]) { this.scene.remove(car); dispose(car); }
    this.chase = null;
  }

  /**
   * Small labels only up close: a room of 400 signs is noise. Building signs
   * shrink as you come up to them, so the one in front of you does not fill
   * the screen.
   */
  _cullLabels() {
    const cam = this.camera.position;
    for (const it of this.items.values()) {
      const l = it.label;
      if (!l || it.dim) continue;
      const d = cam.distanceTo(l.position);
      const near = l.userData.near;
      l.visible = !near || it.selected || d < near;
      const base = l.userData.base;
      if (base && l.visible) l.scale.copy(base).multiplyScalar(clamp(d / 45, 0.3, 1));
    }
  }

  _loop(now) {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this._loop);
    const dt = Math.min(0.05, (now - this._last) / 1000 || 0);
    this._last = now;
    if (!this.element.getClientRects().length || document.hidden) return;
    this.time += dt;
    this._update(dt);
    this._animate(dt);
    this._updateBirds(dt);
    this._updatePlanes(dt);
    this._updateHero(dt);
    this._updateChase(dt);
    this.traffic?.tick(dt);
    if ((this._frame = (this._frame || 0) + 1) % 3 === 0) this._cullLabels();
    this.renderer.render(this.scene, this.camera);
  }

  /* ---------------- selection, filter, highlight ---------------- */

  _applyState() {
    const v = this.ex.view;
    const match = this.ex._matcher();
    for (const it of this.items.values()) {
      const matched = !match || match(it.entry.name);
      const sel = v.selection.has(it.entry.path);
      it.dim = !matched;
      for (const m of it.mats) {
        if (m.transparent === matched) m.needsUpdate = true;   // a different shader either way
        m.transparent = !matched;
        m.opacity = matched ? 1 : 0.12;
        m.depthWrite = matched;
      }
      if (it.label) it.label.visible = matched;
      if (sel !== !!it.selected) {
        it.selected = sel;
        if (sel) this._addBeacon(it);
        else if (it.beacon) { it.group.remove(it.beacon); dispose(it.beacon); it.beacon = null; }
      }
    }
    this._syncHud();
  }

  _addBeacon(it) {
    const r = it.kind === 'building' ? it.w * 0.8 : it.kind === 'door' ? 1.8 : Math.max(0.7, it.w);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(r, it.kind === 'building' ? 0.25 : 0.08, 8, 40),
      new THREE.MeshBasicMaterial({ color: 0x4c8dff, transparent: true, opacity: 0.5, depthWrite: false }));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = it.kind === 'door' ? 0.1 : 0.15;
    if (it.kind === 'door') { ring.rotation.x = 0; ring.position.set(0, 1.7, 0.3); }
    it.beacon = ring;
    it.group.add(ring);
  }

  _select(it, e) {
    const v = this.ex.view;
    if (!it?.entry) {
      if (!e.metaKey && !e.ctrlKey && !e.shiftKey) v.selection.clear();
      if (it?.kind === 'bird') status('🐦 tweet');
      if (it?.kind === 'plane') status('✈︎ nobody’s flying it — it’s a folder view');
      if (it?.kind === 'hero') status('🦸 Up, up and away!');
      if (it?.kind === 'proc') status(`${it.proc.name} · pid ${it.proc.pid} · ${it.proc.user} · ${it.proc.cpu.toFixed(1)}% CPU · ${fmtBytes(it.proc.mem)}`);
      if (it?.kind === 'police') status('🚓 Stand back — pursuit in progress');
      if (it?.kind === 'suspect') status('🚗 They went that way!');
      this.ex.render();
      return;
    }
    const p = it.entry.path;
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      v.selection.has(p) ? v.selection.delete(p) : v.selection.add(p);
    } else {
      v.selection = new Set([p]);
    }
    this.ex._lastClicked = p;
    this.ex.render();
  }

  /** Go into a building or a door; open a file. */
  activate(it) {
    if (!it) return;
    if (it.kind === 'exit') return this.out();
    if (!it.entry) return;
    if (it.kind === 'building' || it.kind === 'door') {
      this._nextMode = 'room';
      this.ex.navigate(it.entry.path).catch(() => {}).finally(() => { this._nextMode = null; });
      return;
    }
    this.ex.open(it.entry);
  }

  /** Out of a room to the street it is on; out of a city to the one above. */
  out() {
    if (this._leaving) return;
    this._leaving = true;
    setTimeout(() => { this._leaving = false; }, 400);
    this._returnFrom = this.dir;
    this._nextMode = 'city';
    if (this.mode === 'room') this.setFlying(false);
    Promise.resolve(this.ex.goParent()).catch(() => {}).finally(() => {
      // Nowhere above (the root): leaving a room still means the street.
      if (this._nextMode && this.mode === 'room') {
        this.mode = 'city';
        this.rebuild({ spawn: true });
        this._applyState();
      }
      this._nextMode = null;
    });
  }

  /* ---------------- input ---------------- */

  _pickAt(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const targets = [...this.pickables];
    for (const f of this.flocks) for (const b of f.userData.birds) targets.push(...b.children.map((c) => { c.userData.item = b.userData.item; return c; }));
    for (const p of [...this.planes, this.hero, this.chase?.suspect, this.chase?.police].filter(Boolean)) {
      p.traverse((o) => { if (o.isMesh) { o.userData.item = p.userData.item; targets.push(o); } });
    }
    if (this.traffic) targets.push(...this.traffic.pickTargets());
    const hits = this.raycaster.intersectObjects(targets, false);
    for (const h of hits) {
      const it = h.object.userData.item;
      if (it?.dim) continue;
      if (it) return it;
    }
    return null;
  }

  _onPointerDown(e) {
    if (e.target !== this.canvas) return;
    this.element.focus({ preventScroll: true });
    if (e.button !== 0) return;
    this.drag = { x: e.clientX, y: e.clientY, moved: false };
    this.canvas.setPointerCapture(e.pointerId);
  }

  _onPointerMove(e) {
    if (this.drag) {
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (!this.drag.moved && Math.hypot(dx, dy) < 4) return;
      this.drag.moved = true;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.yaw -= dx * 0.005;
      this.pitch -= dy * 0.005;
      this.tip.classList.add('hidden');
      return;
    }
    if (e.target !== this.canvas) return;
    const it = this._pickAt(e.clientX, e.clientY);
    this.hover = it;
    this.canvas.style.cursor = it ? 'pointer' : '';
    this._showTip(it, e);
  }

  _onPointerUp(e) {
    const d = this.drag;
    this.drag = null;
    if (!d || d.moved) return;
    this._select(this._pickAt(e.clientX, e.clientY), e);
  }

  _showTip(it, e) {
    if (!it) { this.tip.classList.add('hidden'); return; }
    clear(this.tip);
    const add = (cls, text) => text && this.tip.append(el('div', { class: cls, text }));
    if (it.kind === 'proc') {
      const p = it.proc;
      add('c3-tip-n', `${{ car: '🚗', boat: '🚢', rocket: '🚀' }[it.vehicle] || ''} ${p.name}`);
      add('c3-tip-m', `pid ${p.pid} · ${p.user}`);
      add('c3-tip-k', `${p.cpu.toFixed(1)}% CPU · ${fmtBytes(p.mem)} memory`);
      add('c3-tip-h', it.vehicle === 'rocket' ? 'One of the biggest on this machine' : it.vehicle === 'boat' ? 'Mostly memory — the bigger, the more' : 'Mostly CPU — the faster, the more');
    } else if (!it.entry) {
      add('c3-tip-n', { exit: 'Out to the street', bird: '🐦', hero: '🦸 Is it a bird? Is it a plane?', police: '🚓 In pursuit', suspect: '🚗 Getaway car' }[it.kind] || '✈︎');
      add('c3-tip-m', it.kind === 'exit' ? 'Double-click, or walk through' : '');
    } else if (it.kind === 'crate') {
      add('c3-tip-n', it.entry.name);
      add('c3-tip-m', `${fmtBytes(it.entry.size || 0)} · ${KIND_LABEL[kindOf(it.entry.name)]}`);
      add('c3-tip-h', 'Double-click to open');
    } else {
      add('c3-tip-n', '📁 ' + it.entry.name);
      if (it.rec) {
        add('c3-tip-m', `${fmtBytes(it.rec.bytes)} · ${it.rec.files.toLocaleString()} files · ${it.rec.dirs.toLocaleString()} folders`);
        add('c3-tip-k', kindSummary(it.rec));
      } else add('c3-tip-m', 'not measured yet');
      add('c3-tip-h', 'Double-click to go in');
    }
    const r = this.element.getBoundingClientRect();
    this.tip.style.left = Math.min(e.clientX - r.left + 14, r.width - 230) + 'px';
    this.tip.style.top = Math.min(e.clientY - r.top + 14, r.height - 90) + 'px';
    this.tip.classList.remove('hidden');
  }

  _onKeyDown(e) {
    if (e.target !== this.element) return;
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === 'f') { e.preventDefault(); this.ex.focusFilter(); return; }
    if (meta && e.key === 'a') {
      e.preventDefault();
      this.ex.view.selection = new Set([...this.items.values()].filter((i) => !i.dim).map((i) => i.entry.path));
      this.ex.render();
      return;
    }
    if (meta || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); this.ex.focusFilter(); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!this.help.classList.contains('hidden')) this.help.classList.add('hidden');
      else if (this.ex.element.classList.contains('c3-max')) this.toggleMax(false);
      else if (this.ex.filter) this.ex.clearFilter();
      else { this.ex.view.selection.clear(); this.ex.render(); }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const sel = this.ex.selected();
      if (sel.length === 1) return this.activate(this.items.get(sel[0].path));
      const r = this.canvas.getBoundingClientRect();
      return this.activate(this._pickAt(r.left + r.width / 2, r.top + r.height / 2));
    }
    if (e.key === 'Backspace') { e.preventDefault(); this.out(); return; }
    if (e.code === 'KeyG') { this.setFlying(!this.flying); return; }
    if (e.code === 'KeyH' || e.key === '?') { this.help.classList.toggle('hidden'); return; }
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyX', 'KeyC', 'Space', 'ShiftLeft', 'ShiftRight',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
      this.keys.add(e.code);
    }
  }

  /* ---------------- HUD ---------------- */

  _syncHud() {
    const name = (this.dir || '').split('/').filter(Boolean).pop() || this.dir || '/';
    this.where.textContent = this.mode === 'room' ? `🚪 Inside ${name}` : `🏙 ${this.dir || '/'}`;
    this.where.title = this.dir || '';
    const atRoot = this.dir === '/' || /^[A-Za-z]:\\?$/.test(this.dir || '');
    this.outBtn.textContent = this.mode === 'room' ? '⇦ Out' : '⇧ Up a level';
    this.outBtn.title = this.mode === 'room' ? 'Back out to the street (Backspace)' : 'The city one folder up (Backspace)';
    this.outBtn.classList.toggle('hidden', this.mode !== 'room' && atRoot);
    this.hereBtn.classList.toggle('hidden', this.mode !== 'room');
  }

  _drawLegend() {
    clear(this.legend);
    const seen = new Set();
    for (const it of this.items.values()) {
      if (it.kind === 'crate') seen.add(kindOf(it.entry.name));
      else if (it.rec) for (const [k] of bands(it.rec)) seen.add(k);
    }
    for (const k of Object.keys(KIND_COLORS)) {
      if (!seen.has(k)) continue;
      this.legend.append(el('span', { class: 'c3-chip' },
        el('i', { style: `background:${css(KIND_COLORS[k])}` }), KIND_LABEL[k]));
    }
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.toggleMax(false);
    dispose(this.world);
    for (const p of this.planes) dispose(p);
    if (this.hero) dispose(this.hero);
    this._endChase();
    this._stopTraffic();
    this.scene.traverse((o) => { o.geometry?.dispose?.(); });
    this.win.map.dispose();
    this.win.emissive.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.element.remove();
  }
}
