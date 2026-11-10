import * as THREE from 'three';
import { el } from './util.js';

/**
 * A cluster, as a city — KubeLife's own version of the file browser's 3D
 * view (city3d.js), reusing the idea rather than the module: a filesystem
 * and a Kubernetes cluster are different enough shapes (bytes vs. phase,
 * folders vs. namespaces) that forcing one through the other's constructor
 * would mean overloading a working view rather than writing new code — and
 * this way the existing, working file browser view carries zero risk from
 * this one.
 *
 * Deliberately simpler than city3d.js — no sky/weather/birds, no walking
 * mode — but "fun" was never meant to mean "static": namespaces get their
 * own colour rather than a shared dark palette, pods glow and gently
 * breathe while running (faster and bigger the busier `kubectl top` says
 * they are) and flash when crashing, multi-container pods show one band
 * per container, and namespace labels + a legend make the thing navigable
 * without clicking blindly. Deployments (pillars, coloured by their own
 * ready/desired ratio) and Services (fixed-colour beacons) sit alongside
 * the pods in each district, not just pods alone, and a kind filter picks
 * out just one of the three when a cluster has too much of everything
 * else in the way. A search box dims everything that doesn't match and
 * flies the camera to the first hit.
 *
 * Keyboard and focus follow city3d.js's own proven pattern, not a
 * canvas-only guess: `this.element` (not the canvas) is what's
 * `tabindex`-focusable and what keydown/keyup are bound to, movement keys
 * are tracked in a `Set` and drained once per animation frame (so holding
 * a key moves smoothly, the same as city3d's WASD/arrows), and this view
 * is never hosted inside a `ui.js` modal — that was the actual reason
 * arrow keys silently went nowhere before: the modal's own 30ms
 * autofocus-steal grabbed the first button/input in the box, and a canvas
 * that never had focus has nothing to dispatch keydown to.
 *
 * Same lifecycle contract as City3D: build in the constructor, `destroy()`
 * tears everything down (cancel the raf loop, dispose every geometry and
 * material, drop the GL context, remove the DOM node) so opening and
 * closing this repeatedly never leaks.
 */

const PHASE_COLOR = {
  Running: 0x3fb950, Pending: 0xd29922, Succeeded: 0x6e8bd6, Unknown: 0x6b7689,
};
function phaseColor(phase) {
  if (PHASE_COLOR[phase] !== undefined) return PHASE_COLOR[phase];
  return /error|crash|evict|fail/i.test(phase || '') ? 0xf85149 : 0x6b7689;
}

/** A Deployment's own health, not any pod's phase — 0/3 ready mid-rollout and 0/3 ready stuck both read the same from pods alone. */
function deploymentColor(ready, desired) {
  if (!desired) return 0x6b7689;
  if (ready >= desired) return 0x3fb950;
  if (ready > 0) return 0xd29922;
  return 0xf85149;
}

/** Fixed, not namespace-hued — "that's a Service" should read at a glance, not by elimination. */
const SERVICE_COLOR = 0x4fd1ff;
/** Arrows: a Service's in its own colour, a Deployment's to its pods in a quiet grey that does not fight the pods' phase colours. */
const LINK_COLOR = { Service: SERVICE_COLOR, Deployment: 0xc9d1d9 };

/** One hue per namespace, spread round the wheel rather than picked from a short fixed list — any number of namespaces stays distinct. */
function districtColor(i, total) {
  const hue = (i / Math.max(1, total)) * 0.82 + 0.02; // avoid wrapping back to the same red twice
  return new THREE.Color().setHSL(hue, 0.38, 0.22);
}

/**
 * Building styles — the mechanism city3d.js's own cityarch.js uses (an
 * id/label list feeding a dropdown, dispatch by id, rebuild on change),
 * kept to a handful of simple geometric shapes rather than city3d's full
 * historical-architecture system: this view is about reading a cluster's
 * state at a glance, not touring an era. Colour and height always mean
 * the same thing regardless of style — only the silhouette changes.
 */
const BUILDING_STYLES = [
  { id: 'blocks', label: 'Blocks' },
  { id: 'cylinders', label: 'Cylinders' },
  { id: 'crystals', label: 'Crystals' },
];
function buildingGeometry(styleId, w, h) {
  if (styleId === 'cylinders') return new THREE.CylinderGeometry(w / 2, w / 2, h, 12);
  if (styleId === 'crystals') return new THREE.ConeGeometry(w / 1.6, h, 6);
  return new THREE.BoxGeometry(w, h, w);
}

const KIND_FILTERS = [
  { id: 'all', label: 'All kinds' },
  { id: 'Pod', label: 'Pods' },
  { id: 'Deployment', label: 'Deployments' },
  { id: 'Service', label: 'Services' },
];

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

export class Kube3D {
  constructor({ onExec, onPortForward } = {}) {
    this.onExec = onExec || (() => {});
    this.onPortForward = onPortForward || (() => {});
    this.destroyed = false;
    this._meshToResource = new Map();
    this._labels = [];     // { el, obj3d } — namespace labels, re-projected every frame
    this._living = [];     // meshes that animate (pulse / flash) while idling
    this._query = '';
    this._lastScene = null;
    this.keys = new Set();
    this.kindFilter = localStorage.getItem('sl.kube3d.kind') || 'all';
    // Namespaces left out of the layout. Hidden, not shown, so a namespace
    // that appears after the view opened turns up rather than being missed.
    this.hiddenNs = new Set();
    this.showLinks = localStorage.getItem('sl.kube3d.links') !== 'off';
    this._links = [];      // { line, cone, from, to, kind } — relationship arrows
    this._focusKey = null; // `ns\u0001Kind/name` of the clicked resource, whose arrows stay lit
    this.buildingStyle = localStorage.getItem('sl.kube3d.style') || 'blocks';
    this._t = 0;
    this._last = performance.now();
    this._build();
  }

  _build() {
    this.element = el('div', {
      class: 'kube3d', tabIndex: '0',
      style: 'position:relative;width:100%;height:100%;overflow:hidden;outline:none',
    });
    this.canvas = el('canvas', { style: 'display:block;width:100%;height:100%' });
    this.labelLayer = el('div', { style: 'position:absolute;inset:0;pointer-events:none' });
    this.info = el('div', {
      class: 'kube3d-info',
      style: 'position:absolute;left:10px;bottom:10px;background:var(--panel);border:1px solid var(--border);'
        + 'border-radius:8px;padding:8px 10px;font-size:12px;max-width:320px;display:none;pointer-events:auto',
    });
    this.legend = el('div', {
      style: 'position:absolute;right:10px;top:10px;background:var(--panel);border:1px solid var(--border);'
        + 'border-radius:8px;padding:6px 10px;font-size:11px;display:flex;gap:10px;color:var(--text-dim);flex-wrap:wrap;max-width:260px',
    },
      ...Object.entries({
        Running: '#3fb950', Pending: '#d29922', Failed: '#f85149', Other: '#6b7689',
        Deployment: '#9aa4b2', Service: '#4fd1ff',
      }).map(([label, c]) =>
        el('span', { style: 'display:flex;align-items:center;gap:4px' },
          el('span', { style: `width:9px;height:9px;border-radius:50%;background:${c};display:inline-block` }),
          el('span', { text: label }))),
    );
    this.resetBtn = el('button', {
      class: 'ghost-btn sm', text: '⤾ Reset view',
      title: 'Drag to rotate, right-drag (or shift-drag) to pan, scroll or +/- to zoom.\n'
        + 'Arrow keys rotate/tilt, +/-/PageUp/PageDown zoom — works right away, no click needed first.',
      onClick: () => this._resetView(),
    });
    this.zoomInBtn = el('button', { class: 'ghost-btn sm', text: '+', title: 'Zoom in', onClick: () => { this._zoom(-30); this._applyCamera(); } });
    this.zoomOutBtn = el('button', { class: 'ghost-btn sm', text: '−', title: 'Zoom out', onClick: () => { this._zoom(30); this._applyCamera(); } });

    const selectEl = (opts, value, title) => {
      const s = el('select', {
        title,
        style: 'padding:4px 6px;border-radius:6px;border:1px solid var(--border);background:var(--panel);'
          + 'color:var(--text);font-size:12px',
      }, ...opts.map((o) => el('option', { value: o.id, text: o.label })));
      s.value = value;
      return s;
    };
    this.kindSel = selectEl(KIND_FILTERS, this.kindFilter, 'Show just one kind — the fastest way to find a specific Service in a busy cluster');
    this.kindSel.addEventListener('change', () => {
      this.kindFilter = this.kindSel.value;
      localStorage.setItem('sl.kube3d.kind', this.kindFilter);
      this.rebuild(this._lastScene);
    });
    this.styleSel = selectEl(BUILDING_STYLES, this.buildingStyle, 'Building style — colour and height always mean the same thing, only the shape changes');
    this.styleSel.addEventListener('change', () => {
      this.buildingStyle = this.styleSel.value;
      localStorage.setItem('sl.kube3d.style', this.buildingStyle);
      this.rebuild(this._lastScene);
    });

    this.searchInput = el('input', {
      type: 'text', placeholder: 'Search pods, deployments, services…',
      style: 'padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--panel);'
        + 'color:var(--text);font-size:12px;width:190px',
    });
    this.searchInput.addEventListener('input', () => this._applyFilter(this.searchInput.value));

    // Namespaces: a checklist rather than one select — the point is to pick
    // the few that matter on a cluster with dozens of them.
    this.nsBtn = el('button', { class: 'ghost-btn sm', text: 'Namespaces', title: 'Choose which namespaces are drawn', onClick: () => this._toggleNsMenu() });
    this.nsMenu = el('div', {
      style: 'position:absolute;left:10px;top:44px;background:var(--panel);border:1px solid var(--border);border-radius:8px;'
        + 'padding:6px 8px;font-size:12px;max-height:60%;overflow:auto;display:none;pointer-events:auto;min-width:200px;z-index:2',
    });
    this.linksBtn = el('button', {
      class: 'ghost-btn sm' + (this.showLinks ? ' active' : ''), text: '⇢ Relationships',
      title: 'Arrows: Service → Deployment → Pods, from the same label selectors Kubernetes routes by. Click anything to light up just its own.',
      onClick: () => {
        this.showLinks = !this.showLinks;
        localStorage.setItem('sl.kube3d.links', this.showLinks ? 'on' : 'off');
        this.linksBtn.classList.toggle('active', this.showLinks);
        this.rebuild(this._lastScene, { keepView: true });
      },
    });
    this.mermaidBtn = el('button', {
      class: 'ghost-btn sm', text: 'Export Mermaid',
      title: 'The namespaces shown and how their resources connect, as a Mermaid flowchart — copied, and offered to save',
      onClick: () => this._exportMermaid(),
    });
    this.toolbar = el('div', {
      style: 'position:absolute;left:10px;top:10px;display:flex;gap:6px;align-items:center;pointer-events:auto;flex-wrap:wrap;max-width:calc(100% - 20px)',
    }, this.resetBtn, this.zoomInBtn, this.zoomOutBtn, this.kindSel, this.styleSel, this.nsBtn, this.linksBtn, this.mermaidBtn, this.searchInput);
    this.element.append(this.canvas, this.labelLayer, this.info, this.legend, this.toolbar, this.nsMenu);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x12151c);
    this.scene.fog = new THREE.Fog(0x12151c, 220, 950);
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 3000);
    this.world = new THREE.Group();
    this.scene.add(this.world);
    // Arrows live outside `world`: clicks raycast world only, so a line
    // crossing a building never steals the click meant for the building.
    this.linkGroup = new THREE.Group();
    this.scene.add(this.linkGroup);
    this.raycaster = new THREE.Raycaster();

    this.scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x1a1f28, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(80, 140, 60);
    this.scene.add(sun);

    this._resetView();

    let dragging = null; // 'rotate' | 'pan' | null
    let lastX = 0; let lastY = 0;
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener('pointerdown', (e) => {
      // Focus the whole element, not the canvas — keydown is bound there
      // (see below), the same split city3d.js's own `_onPointerDown` makes.
      this.element.focus({ preventScroll: true });
      dragging = (e.button === 2 || e.shiftKey) ? 'pan' : 'rotate';
      lastX = e.clientX; lastY = e.clientY;
    });
    window.addEventListener('pointerup', () => { dragging = null; });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX; const dy = e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      if (dragging === 'rotate') {
        this.theta -= dx * 0.006;
        this.phi = clamp(this.phi - dy * 0.006, 0.15, 1.5);
      } else {
        // Pan in the camera's own right/forward plane, not world axes —
        // otherwise panning "left" after rotating the view spins it instead.
        const right = new THREE.Vector3(Math.cos(this.theta), 0, -Math.sin(this.theta));
        const fwd = new THREE.Vector3(Math.sin(this.theta), 0, Math.cos(this.theta));
        const scale = this.radius * 0.0022;
        this.target.addScaledVector(right, -dx * scale);
        this.target.addScaledVector(fwd, dy * scale);
      }
      this._applyCamera();
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._zoom(e.deltaY * 0.2);
      this._applyCamera();
    }, { passive: false });
    this.canvas.addEventListener('click', (e) => this._onClick(e));

    // Keyboard on the wrapping element (tabindex="0" above), not the
    // canvas — a Set populated on keydown/keyup and drained once per
    // animation frame in _loop(), exactly city3d.js's own movement-key
    // pattern, not a discrete step fired once per keydown event.
    const MOVE_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_', 'PageUp', 'PageDown'];
    this.element.addEventListener('keydown', (e) => {
      if (!MOVE_KEYS.includes(e.key)) return;
      e.preventDefault();
      this.keys.add(e.key);
    });
    this.element.addEventListener('keyup', (e) => this.keys.delete(e.key));
    this.element.addEventListener('blur', () => this.keys.clear());

    this.ro = new ResizeObserver(() => this._resize());
    this.ro.observe(this.element);
    this.raf = requestAnimationFrame(this._loop);
  }

  _resetView() {
    this.target = new THREE.Vector3(0, 0, 0);
    this.radius = this._fitRadius || 160;
    this.theta = Math.PI / 4;
    this.phi = 1.0;
    this._applyCamera();
  }

  _zoom(delta) {
    this.radius = clamp(this.radius + delta, 20, 700);
  }

  _applyCamera() {
    const x = this.target.x + this.radius * Math.sin(this.phi) * Math.sin(this.theta);
    const y = this.target.y + this.radius * Math.cos(this.phi);
    const z = this.target.z + this.radius * Math.sin(this.phi) * Math.cos(this.theta);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(this.target);
  }

  _resize() {
    const w = this.element.clientWidth, h = this.element.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Drains this.keys once per frame — holding a key moves smoothly, at a speed independent of the actual frame rate. */
  _applyKeys(dt) {
    if (!this.keys.size) return;
    const K = this.keys;
    let moved = false;
    if (K.has('ArrowLeft')) { this.theta += 1.6 * dt; moved = true; }
    if (K.has('ArrowRight')) { this.theta -= 1.6 * dt; moved = true; }
    if (K.has('ArrowUp')) { this.phi = clamp(this.phi - 1.2 * dt, 0.15, 1.5); moved = true; }
    if (K.has('ArrowDown')) { this.phi = clamp(this.phi + 1.2 * dt, 0.15, 1.5); moved = true; }
    if (K.has('+') || K.has('=') || K.has('PageUp')) { this._zoom(-180 * dt); moved = true; }
    if (K.has('-') || K.has('_') || K.has('PageDown')) { this._zoom(180 * dt); moved = true; }
    if (moved) this._applyCamera();
  }

  _loop = () => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this._loop);
    if (!this.element.isConnected || this.element.offsetParent === null) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this._last) / 1000);
    this._last = now;
    this._t += dt;
    this._applyKeys(dt);
    for (const l of this._living) {
      if (l.kind === 'pulse') {
        // Busier (kubectl top) pods pulse faster and a touch bigger — not
        // just coloured by phase, which cannot tell "idle" from "pegged."
        const activity = l.activity || 0;
        const speed = 2 + activity * 5;
        const amp = 0.03 + activity * 0.06;
        const s = 1 + Math.sin(this._t * speed + l.phase) * amp;
        l.mesh.scale.set(s, 1, s);
      } else if (l.kind === 'flash') {
        const b = 0.5 + Math.sin(this._t * 6 + l.phase) * 0.5;
        l.mesh.material.emissiveIntensity = 0.3 + b * 1.1;
      }
    }
    this._updateLabels();
    this.renderer.render(this.scene, this.camera);
  };

  _updateLabels() {
    const r = this.canvas.getBoundingClientRect();
    for (const { element, pos3d } of this._labels) {
      const v = pos3d.clone().project(this.camera);
      const behind = v.z > 1;
      element.style.display = behind ? 'none' : '';
      if (behind) continue;
      element.style.left = `${(v.x * 0.5 + 0.5) * r.width}px`;
      element.style.top = `${(-v.y * 0.5 + 0.5) * r.height}px`;
    }
  }

  /**
   * `kubectl top pods`, fed in from outside (kubebrowser.js polls it while
   * this view is open — the same "poll on a timer, feed metric rows into
   * already-built objects" shape city3d.js's own ProcTraffic uses for
   * local/remote processes, not rebuilt here). Matched by namespace+name,
   * the key every pulsing pod's `_living` entry already carries.
   */
  updateUsage(usage) {
    if (!usage?.pods?.ok) return;
    const milli = (v) => (/m$/.test(v || '') ? parseFloat(v) : parseFloat(v || 0) * 1000) || 0;
    const byKey = new Map(usage.pods.items.map((p) => [`${p.namespace}\u0001${p.name}`, milli(p.cpu)]));
    for (const l of this._living) {
      if (l.kind !== 'pulse' || !l.key) continue;
      const cpu = byKey.get(l.key) || 0;
      // 500m is not a real threshold, only a "this view calls that busy"
      // anchor so the pulse has somewhere to saturate rather than growing
      // without bound.
      l.activity = clamp(cpu / 500, 0, 1);
    }
  }

  /** Dim everything whose name/namespace doesn't match, and fly the camera's own target toward the first hit — leaves it alone for an empty query. */
  _applyFilter(query) {
    this._query = query || '';
    const q = this._query.trim().toLowerCase();
    let first = null;
    for (const [mesh, res] of this._meshToResource) {
      const match = !q || res.name.toLowerCase().includes(q) || (res.namespace || '').toLowerCase().includes(q);
      mesh.material.opacity = match ? 1 : 0.12;
      if (q && match && !first) first = mesh;
    }
    if (q && first) {
      const pos = new THREE.Vector3();
      first.getWorldPosition(pos);
      this.target.set(pos.x, 0, pos.z);
      this._applyCamera();
    }
  }

  _onClick(e) {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.world.children, true)[0];
    const res = hit && this._meshToResource.get(hit.object);
    this.nsMenu.style.display = 'none';
    if (!res) { this.info.style.display = 'none'; this._focus(null); return; }
    this.info.style.display = '';
    const key = `${res.namespace}\u0001${res.kind}/${res.name}`;
    this._focus(key);
    const related = this._links.filter((l) => l.from === key || l.to === key)
      .map((l) => (l.from === key ? `→ ${l.to.split('\u0001')[1]}` : `← ${l.from.split('\u0001')[1]}`));
    const relLine = related.length
      ? el('div', { style: 'margin-top:6px;color:var(--text-dim);white-space:pre-wrap;max-height:120px;overflow:auto', text: related.join('\n') })
      : el('div', { style: 'margin-top:6px;color:var(--muted)', text: this.showLinks ? 'Nothing selects it or is selected by it.' : '' });
    if (res.kind === 'Service') {
      this.info.replaceChildren(
        el('div', { style: 'font-weight:600', text: res.name }),
        el('div', { style: 'color:var(--muted)', text: `${res.namespace} · ${res.detail || 'Service'}` }),
        relLine,
        el('button', { class: 'ghost-btn sm', style: 'margin-top:6px', text: 'Port-forward…', onClick: () => this.onPortForward(res) }),
      );
    } else if (res.kind === 'Deployment') {
      this.info.replaceChildren(
        el('div', { style: 'font-weight:600', text: res.name }),
        el('div', { style: 'color:var(--muted)', text: `${res.namespace} · ${res.ready}/${res.desired} ready` }),
        relLine,
      );
    } else {
      this.info.replaceChildren(
        el('div', { style: 'font-weight:600', text: res.name }),
        el('div', { style: 'color:var(--muted)', text: `${res.namespace} · ${res.phase}${res.restarts ? ` · ${res.restarts} restarts` : ''}`
          + (res.containerNames?.length > 1 ? ` · ${res.containerNames.length} containers` : '') }),
        relLine,
        el('button', {
          class: 'ghost-btn sm', style: 'margin-top:6px', text: 'Exec into it',
          onClick: () => this.onExec(res),
        }),
      );
    }
  }

  /** The namespace checklist: all/none, then one box per namespace in the last scene. */
  _toggleNsMenu() {
    if (this.nsMenu.style.display !== 'none') { this.nsMenu.style.display = 'none'; return; }
    const names = (this._lastScene?.namespaces || []).map((n) => n.name);
    const apply = () => { this.rebuild(this._lastScene); this._toggleNsMenu(); this._toggleNsMenu(); };
    const boxes = names.map((name) => {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = !this.hiddenNs.has(name);
      cb.addEventListener('change', () => { if (cb.checked) this.hiddenNs.delete(name); else this.hiddenNs.add(name); this.rebuild(this._lastScene); this._paintNsBtn(); });
      const count = (this._lastScene.namespaces.find((n) => n.name === name) || {}).podCount || 0;
      return el('label', { style: 'display:flex;gap:6px;align-items:center;padding:2px 0;cursor:pointer;white-space:nowrap' },
        cb, el('span', { text: name }), el('span', { style: 'color:var(--muted)', text: String(count) }));
    });
    this.nsMenu.replaceChildren(
      el('div', { style: 'display:flex;gap:6px;margin-bottom:6px' },
        el('button', { class: 'ghost-btn sm', text: 'All', onClick: () => { this.hiddenNs.clear(); apply(); this._paintNsBtn(); } }),
        el('button', { class: 'ghost-btn sm', text: 'None', onClick: () => { names.forEach((n) => this.hiddenNs.add(n)); apply(); this._paintNsBtn(); } })),
      ...(boxes.length ? boxes : [el('div', { style: 'color:var(--muted)', text: 'No namespaces yet.' })]));
    this.nsMenu.style.display = '';
  }

  _paintNsBtn() {
    const names = (this._lastScene?.namespaces || []).map((n) => n.name);
    const shown = names.filter((n) => !this.hiddenNs.has(n)).length;
    this.nsBtn.textContent = shown === names.length ? 'Namespaces' : `Namespaces (${shown}/${names.length})`;
    this.nsBtn.classList.toggle('active', shown !== names.length);
  }

  /**
   * What is on screen as Mermaid: every resource in the namespaces shown
   * (the kind filter too), and every relationship between them — the
   * arrows' own data, whether or not they are currently drawn.
   */
  async _exportMermaid() {
    const nodes = []; const edges = [];
    const wants = (kind) => this.kindFilter === 'all' || this.kindFilter === kind;
    for (const ns of (this._lastScene?.namespaces || []).filter((n) => !this.hiddenNs.has(n.name))) {
      const have = new Set();
      const node = (kind, name) => {
        if (!wants(kind)) return;
        const id = `${ns.name}/${kind}/${name}`;
        have.add(`${kind}/${name}`);
        nodes.push({ id, kind, name: `${ns.name}/${name}` });
      };
      for (const s of ns.services || []) node('Service', s.name);
      for (const d of ns.deployments || []) node('Deployment', d.name);
      for (const p of ns.pods || []) node('Pod', p.name);
      for (const l of ns.links || []) {
        if (have.has(l.from) && have.has(l.to)) edges.push({ from: `${ns.name}/${l.from}`, to: `${ns.name}/${l.to}`, label: l.from.startsWith('Service/') ? 'selects' : 'owns' });
      }
    }
    const r = await window.api.kube.mermaid({ nodes, edges, title: 'Kubernetes relationships' });
    if (!r?.ok) return;
    await window.api.clipboard.write(r.mermaid);
    const saved = await window.api.dialog.saveText({ text: r.mermaid, defaultPath: 'kube-relationships.mmd', title: 'Save as Mermaid' });
    this._flash(saved ? `Copied, and saved to ${saved.path}` : 'Mermaid copied to the clipboard');
  }

  _flash(text) {
    const n = el('div', {
      style: 'position:absolute;left:50%;bottom:14px;transform:translateX(-50%);background:var(--panel);border:1px solid var(--border);'
        + 'border-radius:6px;padding:5px 10px;font-size:12px;pointer-events:none', text,
    });
    this.element.append(n);
    setTimeout(() => n.remove(), 2600);
  }

  /** Light one resource's arrows and dim the rest; null puts every arrow back. */
  _focus(key) {
    this._focusKey = key;
    for (const l of this._links) {
      const lit = !key || l.from === key || l.to === key;
      l.line.material.opacity = lit ? (key ? 0.95 : 0.55) : 0.06;
      l.cone.material.opacity = lit ? 0.95 : 0.06;
    }
  }

  /** One arrow: a raised arc from `a` to `b`, with a cone near the end pointing along it. */
  _drawLink(a, b, kind, from, to) {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y += 3 + a.distanceTo(b) * 0.35;
    const curve = new THREE.QuadraticBezierCurve3(a, mid, b);
    const color = LINK_COLOR[kind] || 0xffffff;
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(curve.getPoints(24)),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 }));
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.35, 0.9, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }));
    cone.position.copy(curve.getPoint(0.9));
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), curve.getTangent(0.9).normalize());
    this.linkGroup.add(line, cone);
    this._links.push({ line, cone, from, to, kind });
  }

  _disposeLinks() {
    for (const child of [...this.linkGroup.children]) {
      this.linkGroup.remove(child);
      child.geometry?.dispose?.();
      child.material?.dispose?.();
    }
    this._links = [];
  }

  /**
   * Lay out districts (namespaces) in a grid. Within each: pods in a
   * sub-grid in the middle (containers as bands within a pod, unchanged),
   * Deployments as a row of pillars along one edge, Services as a row of
   * beacons along another — three different shapes sharing one tile rather
   * than trying to force them through the same grid. `this.kindFilter`
   * drops whichever of the three isn't wanted before any of this runs, and
   * `this.buildingStyle` picks the geometry pods/Deployments are built
   * from (Services keep their own fixed disc regardless of style — it is
   * a kind marker, not a "building").
   */
  rebuild(scene, { keepView = false } = {}) {
    this._lastScene = scene;
    this._disposeWorldChildren();
    this._disposeLinks();
    // Where each drawn resource's arrow attaches — its top, keyed the way
    // kubescan.js's links name their ends.
    const anchors = new Map();
    this._meshToResource.clear();
    this._living = [];
    for (const l of this._labels) l.element.remove();
    this._labels = [];

    // Only the namespaces chosen are laid out, so the rest close up rather
    // than leaving holes in the grid.
    const namespaces = (scene?.namespaces || []).filter((n) => !this.hiddenNs.has(n.name));
    const cols = Math.max(1, Math.ceil(Math.sqrt(namespaces.length)));
    const districtSize = 34;
    let maxExtent = districtSize;
    const wantPods = this.kindFilter === 'all' || this.kindFilter === 'Pod';
    const wantDeployments = this.kindFilter === 'all' || this.kindFilter === 'Deployment';
    const wantServices = this.kindFilter === 'all' || this.kindFilter === 'Service';

    namespaces.forEach((nsEntry, i) => {
      const gx = (i % cols) - (cols - 1) / 2;
      const gz = Math.floor(i / cols) - (cols - 1) / 2;
      const cx = gx * (districtSize + 10);
      const cz = gz * (districtSize + 10);
      maxExtent = Math.max(maxExtent, Math.abs(cx) + districtSize, Math.abs(cz) + districtSize);

      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(districtSize, 0.6, districtSize),
        new THREE.MeshStandardMaterial({ color: districtColor(i, namespaces.length), roughness: 0.85 }));
      tile.position.set(cx, -0.3, cz);
      this.world.add(tile);

      const label = el('div', {
        style: 'position:absolute;transform:translate(-50%,-100%);font-size:11px;font-weight:600;'
          + 'color:var(--text);background:rgba(0,0,0,.45);padding:1px 6px;border-radius:4px;white-space:nowrap',
        text: `${nsEntry.name} · ${nsEntry.podCount}`,
      });
      this.labelLayer.append(label);
      this._labels.push({ element: label, pos3d: new THREE.Vector3(cx, 8, cz) });

      // Pods keep a margin clear on two edges, for the Deployment/Service rows below.
      const pods = wantPods ? nsEntry.pods : [];
      const podArea = districtSize - 12;
      const podCols = Math.max(1, Math.ceil(Math.sqrt(pods.length)));
      const podSpacing = Math.min(5, podArea / podCols);
      pods.forEach((pod, j) => {
        const px = cx + ((j % podCols) - (podCols - 1) / 2) * podSpacing;
        const pz = cz + (Math.floor(j / podCols) - (podCols - 1) / 2) * podSpacing;
        const containerNames = pod.containers?.length ? pod.containers : [null];
        const totalH = Math.max(1, pod.height || 1);
        const bandH = totalH / containerNames.length;
        const w = Math.min(podSpacing * 0.7, 1 + pod.footprint * 0.4);
        const base = phaseColor(pod.phase);
        const crashing = /error|crash|evict|fail/i.test(pod.phase || '');
        const key = `${nsEntry.name}\u0001${pod.name}`;

        const group = new THREE.Group();
        group.position.set(px, 0, pz);
        containerNames.forEach((_, bandIdx) => {
          // Alternate bands a touch lighter/darker so a multi-container pod
          // visibly has more than one floor, without a second colour scale.
          const tint = new THREE.Color(base).offsetHSL(0, 0, bandIdx % 2 ? -0.05 : 0.04);
          const mat = new THREE.MeshStandardMaterial({
            color: tint, roughness: 0.55, emissive: tint, emissiveIntensity: 0.25, transparent: true, opacity: 1,
          });
          const mesh = new THREE.Mesh(buildingGeometry(this.buildingStyle, w, bandH), mat);
          mesh.position.y = bandH * bandIdx + bandH / 2;
          group.add(mesh);
          this._meshToResource.set(mesh, { kind: 'Pod', ...pod, namespace: nsEntry.name, containerNames });
          if (crashing) this._living.push({ kind: 'flash', mesh, phase: Math.random() * 6 });
        });
        this.world.add(group);
        anchors.set(`${nsEntry.name}\u0001Pod/${pod.name}`, new THREE.Vector3(px, totalH + 0.2, pz));
        if (!crashing && pod.phase === 'Running') this._living.push({ kind: 'pulse', mesh: group, phase: Math.random() * 6, key, activity: 0 });
      });

      // Deployments: pillars along the north edge, coloured by their own
      // ready/desired ratio — a health rollup pods alone can't show (a
      // Deployment stuck at 0/3 and one mid-rollout at 2/3 look identical
      // from their pods alone if some of those pods are merely Pending).
      const deployments = wantDeployments ? (nsEntry.deployments || []) : [];
      const depCols = Math.max(1, deployments.length);
      const depSpacing = Math.min(4, (districtSize - 4) / depCols);
      deployments.forEach((dep, j) => {
        const dx = cx + (j - (depCols - 1) / 2) * depSpacing;
        const dz = cz - districtSize / 2 + 2;
        const h = 2 + Math.min(dep.desired || 0, 8) * 0.7;
        const color = deploymentColor(dep.ready, dep.desired);
        const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, emissive: color, emissiveIntensity: 0.3, transparent: true, opacity: 1 });
        const mesh = new THREE.Mesh(buildingGeometry(this.buildingStyle, 1.6, h), mat);
        mesh.position.set(dx, h / 2, dz);
        this.world.add(mesh);
        anchors.set(`${nsEntry.name}\u0001Deployment/${dep.name}`, new THREE.Vector3(dx, h + 0.2, dz));
        this._meshToResource.set(mesh, { kind: 'Deployment', name: dep.name, namespace: nsEntry.name, ready: dep.ready, desired: dep.desired });
      });

      // Services: beacons along the east edge, fixed colour regardless of
      // namespace hue or building style — "that's a Service" should read
      // at a glance.
      const services = wantServices ? (nsEntry.services || []) : [];
      const svcCols = Math.max(1, services.length);
      const svcSpacing = Math.min(4, (districtSize - 4) / svcCols);
      services.forEach((svc, j) => {
        const sx = cx + districtSize / 2 - 2;
        const sz = cz + (j - (svcCols - 1) / 2) * svcSpacing;
        const mat = new THREE.MeshStandardMaterial({
          color: SERVICE_COLOR, roughness: 0.4, emissive: SERVICE_COLOR, emissiveIntensity: 0.35, transparent: true, opacity: 1,
        });
        const mesh = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.6, 16), mat);
        mesh.position.set(sx, 0.4, sz);
        this.world.add(mesh);
        anchors.set(`${nsEntry.name}\u0001Service/${svc.name}`, new THREE.Vector3(sx, 0.8, sz));
        this._meshToResource.set(mesh, { kind: 'Service', name: svc.name, namespace: nsEntry.name, detail: svc.detail });
      });
    });

    // An arrow is only drawn when both its ends are — the kind filter or a
    // hidden namespace takes the arrow with the thing it pointed at.
    if (this.showLinks) {
      for (const nsEntry of namespaces) {
        for (const link of nsEntry.links || []) {
          const from = `${nsEntry.name}\u0001${link.from}`;
          const to = `${nsEntry.name}\u0001${link.to}`;
          const a = anchors.get(from); const b = anchors.get(to);
          if (a && b) this._drawLink(a, b, link.from.split('/')[0], from, to);
        }
      }
    }
    this._focus(this._focusKey && anchors.has(this._focusKey) ? this._focusKey : null);
    this._paintNsBtn();

    this._fitRadius = Math.max(80, maxExtent * 2.1);
    if (!keepView) this._resetView();
    this._applyFilter(this._query);
  }

  _disposeWorldChildren() {
    for (const child of [...this.world.children]) {
      this.world.remove(child);
      child.traverse?.((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      child.geometry?.dispose?.();
      child.material?.dispose?.();
    }
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this._disposeWorldChildren();
    this._disposeLinks();
    for (const l of this._labels) l.element.remove();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.element.remove();
  }
}
