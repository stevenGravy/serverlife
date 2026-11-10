import { state } from './state.js';

/**
 * Pane-close animations: a little theatre for the one moment a terminal
 * pane actually goes away.
 *
 * Pure spectacle, and kept strictly separate from the real teardown. By the
 * time `playCloseAnimation` runs, the session has already ended and the
 * pane has already been dropped from state and from the layout — the real
 * work is done. All this does is hold the pane's own DOM node (xterm's
 * canvas included, exactly as it last rendered) over the top of the
 * already-reflowed layout for one more moment, doing something destructive
 * and a little theatrical to it, before handing back a promise the caller
 * uses to finish disposing of it for real.
 *
 * Every effect here animates the pane *itself* — scale, rotate, clip, fall,
 * fragment — never the surviving panes around it sliding into its place;
 * that reflow already happened instantly, the normal way, underneath.
 */

let overlayRoot = null;
function overlay() {
  if (overlayRoot && overlayRoot.isConnected) return overlayRoot;
  overlayRoot = document.createElement('div');
  overlayRoot.className = 'pane-close-layer';
  document.body.appendChild(overlayRoot);
  return overlayRoot;
}

/** Off in Settings, or the OS asked for less motion: skip the show entirely. */
export function shouldAnimatePaneClose() {
  if (state.settings.paneCloseAnimations === false) return false;
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  } catch { /* no matchMedia: assume motion is fine */ }
  return true;
}

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** A small debris/confetti/shard piece, sized and placed within `rect`. */
function fragment(layer, rect, { w, h, left, top, cls, style } = {}) {
  const f = document.createElement('div');
  f.className = 'pane-close-frag' + (cls ? ' ' + cls : '');
  f.style.left = (rect.left + (left ?? 0)) + 'px';
  f.style.top = (rect.top + (top ?? 0)) + 'px';
  f.style.width = (w ?? 10) + 'px';
  f.style.height = (h ?? 10) + 'px';
  if (style) Object.assign(f.style, style);
  layer.appendChild(f);
  return f;
}

/** Straight-line travel toward a point, as CSS custom properties a keyframe reads. */
function setTravel(el, rect, targetX, targetY) {
  el.style.setProperty('--pc-tx', (targetX - rect.left - rect.width / 2) + 'px');
  el.style.setProperty('--pc-ty', (targetY - rect.top - rect.height / 2) + 'px');
}

/** Bottom-left-ish — there is no literal trash can on screen, so this is it. */
function trashPoint() {
  return { x: rand(24, 64), y: window.innerHeight - rand(24, 64) };
}

/** The plainest case: add a class, declare how long it runs, done. */
function plain(name, cls, duration = 650) {
  return { name, run(el) { el.style.setProperty('--pc-duration', duration + 'ms'); el.classList.add(cls); return duration; } };
}

/** A class plus a travel target the keyframe reads from --pc-tx/--pc-ty. */
function travel(name, cls, duration, targetFn) {
  return {
    name,
    run(el, rect) {
      const t = targetFn(rect);
      setTravel(el, rect, t.x, t.y);
      el.style.setProperty('--pc-duration', duration + 'ms');
      el.classList.add(cls);
      return duration;
    },
  };
}

/** A short-lived jagged "crack" flash over the pane, SVG so the lines stay crisp. */
function crackFlash(layer, rect) {
  const n = Math.floor(rand(5, 8));
  const cx = rand(0.3, 0.7) * rect.width;
  const cy = rand(0.3, 0.7) * rect.height;
  let paths = '';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rand(-0.3, 0.3);
    const len = rand(0.5, 0.9);
    const ex = cx + Math.cos(a) * rect.width * len;
    const ey = cy + Math.sin(a) * rect.height * len;
    const mx = cx + Math.cos(a) * rect.width * len * 0.5 + rand(-20, 20);
    const my = cy + Math.sin(a) * rect.height * len * 0.5 + rand(-20, 20);
    paths += `<path d="M${cx},${cy} L${mx},${my} L${ex},${ey}" stroke="white" stroke-width="${rand(1, 2).toFixed(1)}" fill="none" opacity="0.85"/>`;
  }
  const svg = document.createElement('div');
  svg.className = 'pane-close-crack';
  svg.style.left = rect.left + 'px';
  svg.style.top = rect.top + 'px';
  svg.style.width = rect.width + 'px';
  svg.style.height = rect.height + 'px';
  svg.innerHTML = `<svg width="${rect.width}" height="${rect.height}" style="filter:drop-shadow(0 0 2px rgba(0,0,0,.6))">${paths}</svg>`;
  layer.appendChild(svg);
  return svg;
}

/* ------------------------------------------------------------------ */
/* The registry — over thirty of them, picked at random, never twice   */
/* in a row.                                                           */
/* ------------------------------------------------------------------ */

const ANIMATIONS = [
  plain('shrink-fade', 'pc-shrink-fade', 500),
  plain('spin-fade', 'pc-spin-fade', 600),
  plain('drop', 'pc-drop', 700),
  plain('launch', 'pc-launch', 650),
  plain('slide-left', 'pc-slide-left', 600),
  plain('slide-right', 'pc-slide-right', 600),
  plain('iris', 'pc-iris', 550),
  plain('iris-corner', 'pc-iris-corner', 600),
  plain('melt', 'pc-melt', 800),
  plain('vacuum', 'pc-vacuum', 650),
  plain('blackhole', 'pc-blackhole', 750),
  plain('crt-off', 'pc-crt-off', 550),
  plain('glitch', 'pc-glitch', 600),
  plain('static', 'pc-static', 550),
  plain('overexpose', 'pc-overexpose', 500),
  plain('rust', 'pc-rust', 900),
  plain('freeze', 'pc-freeze', 700),
  plain('fold-top', 'pc-fold-top', 600),
  plain('fold-bottom', 'pc-fold-bottom', 650),
  plain('book-close', 'pc-book-close', 600),
  plain('warp', 'pc-warp', 550),
  plain('implode', 'pc-implode', 450),
  plain('sink', 'pc-sink', 700),
  plain('tumble', 'pc-tumble', 700),
  plain('wilt', 'pc-wilt', 900),
  plain('drain', 'pc-drain', 650),
  plain('levitate', 'pc-levitate', 650),
  plain('page-turn', 'pc-page-turn', 600),
  plain('jelly-pop', 'pc-jelly', 650),
  plain('corner-twist', 'pc-corner-twist', 600),
  travel('toss-trash', 'pc-toss-trash', 900, () => { const t = trashPoint(); return t; }),
  travel('spiral-drain', 'pc-spiral-drain', 800, (rect) => ({ x: rect.left + rect.width / 2, y: window.innerHeight + 40 })),
  travel('fly-corner', 'pc-fly-corner', 750, () => pick([
    { x: 24, y: 24 }, { x: window.innerWidth - 24, y: 24 },
    { x: 24, y: window.innerHeight - 24 }, { x: window.innerWidth - 24, y: window.innerHeight - 24 },
  ])),

  /** Crack lines flash, then the pane fractures into shards that fall away. */
  {
    name: 'shatter',
    run(el, rect, extra, layer) {
      const crack = crackFlash(layer, rect);
      extra.push(crack);
      el.style.setProperty('--pc-duration', '220ms');
      el.classList.add('pane-close-dim-flash');
      setTimeout(() => {
        el.style.display = 'none';
        const cols = 4, rows = 3;
        const pw = rect.width / cols, ph = rect.height / rows;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            const f = fragment(layer, rect, {
              w: pw, h: ph, left: c * pw, top: r * ph,
              cls: 'pane-close-shard',
              style: { background: 'var(--panel-2)', border: '1px solid var(--border-soft)' },
            });
            const fall = rand(160, 420);
            const side = rand(-140, 140);
            const rot = rand(-260, 260);
            f.style.setProperty('--pc-fx', side + 'px');
            f.style.setProperty('--pc-fy', fall + 'px');
            f.style.setProperty('--pc-frot', rot + 'deg');
            f.style.animation = `pc-shard-fall ${rand(500, 850)}ms ease-in ${rand(0, 90)}ms forwards`;
            extra.push(f);
          }
        }
      }, 180);
      return 900;
    },
  },

  /** Debris crumbles off the edges while the core shrinks and is tossed away. */
  {
    name: 'crumble-trash',
    run(el, rect, extra, layer) {
      el.style.setProperty('--pc-duration', '950ms');
      const target = trashPoint();
      setTravel(el, rect, target.x, target.y);
      el.classList.add('pc-crumble-core');
      for (let i = 0; i < 18; i++) {
        const edge = pick(['top', 'bottom', 'left', 'right']);
        const w = rand(4, 11), h = rand(4, 11);
        const left = edge === 'left' ? rand(-4, 4) : edge === 'right' ? rect.width - rand(0, 8) : rand(0, rect.width);
        const top = edge === 'top' ? rand(-4, 4) : edge === 'bottom' ? rect.height - rand(0, 8) : rand(0, rect.height);
        const delay = Math.floor(rand(0, 420));
        const f = fragment(layer, rect, {
          w, h, left, top, cls: 'pane-close-crumb',
          style: { background: 'var(--border)' },
        });
        f.style.setProperty('--pc-fx', rand(-60, 60) + 'px');
        f.style.setProperty('--pc-fy', rand(40, 160) + 'px');
        f.style.setProperty('--pc-frot', rand(-300, 300) + 'deg');
        f.style.animation = `pc-crumb-fall ${Math.floor(rand(500, 900))}ms ease-in ${delay}ms forwards`;
        extra.push(f);
      }
      return 950;
    },
  },

  /** Peeled into vertical strips, each falling on its own. */
  {
    name: 'shred',
    run(el, rect, extra, layer) {
      el.style.display = 'none';
      const n = 7;
      const sw = rect.width / n;
      for (let i = 0; i < n; i++) {
        const f = fragment(layer, rect, {
          w: sw - 1, h: rect.height, left: i * sw, top: 0,
          cls: 'pane-close-shred',
          style: { background: 'var(--panel-2)', borderLeft: '1px solid var(--border-soft)', borderRight: '1px solid var(--border-soft)' },
        });
        f.style.setProperty('--pc-fy', rand(260, 420) + 'px');
        f.style.setProperty('--pc-frot', rand(-30, 30) + 'deg');
        f.style.animation = `pc-shred-fall ${rand(550, 800)}ms cubic-bezier(.4,0,1,1) ${i * 35}ms forwards`;
        extra.push(f);
      }
      return 900;
    },
  },

  /** A quick pop, then confetti everywhere. */
  {
    name: 'confetti',
    run(el, rect, extra, layer) {
      el.style.setProperty('--pc-duration', '280ms');
      el.classList.add('pc-implode');
      const colours = ['var(--green)', 'var(--amber)', 'var(--red)', 'var(--text-dim)', 'var(--border)'];
      setTimeout(() => {
        for (let i = 0; i < 22; i++) {
          const f = fragment(layer, rect, {
            w: rand(5, 9), h: rand(5, 9),
            left: rect.width / 2 + rand(-10, 10), top: rect.height / 2 + rand(-10, 10),
            cls: 'pane-close-confetti', style: { background: pick(colours) },
          });
          const a = rand(0, Math.PI * 2);
          const d = rand(60, 220);
          f.style.setProperty('--pc-fx', Math.cos(a) * d + 'px');
          f.style.setProperty('--pc-fy', Math.sin(a) * d + rand(40, 120) + 'px');
          f.style.setProperty('--pc-frot', rand(-400, 400) + 'deg');
          f.style.animation = `pc-confetti-fly ${rand(500, 750)}ms ease-out forwards`;
          extra.push(f);
        }
      }, 240);
      return 850;
    },
  },

  /** Rises and breaks apart into ash as it fades — the opposite of gravity. */
  {
    name: 'ash',
    run(el, rect, extra, layer) {
      el.style.setProperty('--pc-duration', '900ms');
      el.classList.add('pc-ash-base');
      for (let i = 0; i < 26; i++) {
        const f = fragment(layer, rect, {
          w: rand(2, 4), h: rand(2, 4),
          left: rand(0, rect.width), top: rand(0, rect.height),
          cls: 'pane-close-ash', style: { background: 'var(--muted)', animationDelay: Math.floor(rand(0, 400)) + 'ms' },
        });
        f.style.setProperty('--pc-fx', rand(-30, 30) + 'px');
        f.style.setProperty('--pc-fy', rand(-140, -60) + 'px');
        f.style.animation = `pc-ash-rise ${rand(500, 850)}ms ease-out ${f.style.animationDelay} forwards`;
        extra.push(f);
      }
      return 900;
    },
  },
];

let lastIndex = -1;
function pickAnimation() {
  let i;
  do { i = Math.floor(Math.random() * ANIMATIONS.length); } while (ANIMATIONS.length > 1 && i === lastIndex);
  lastIndex = i;
  return ANIMATIONS[i];
}

/**
 * Plays one of the registry's effects on `el` and resolves once it is safe
 * to actually dispose of it. `el` must still be in the document when this
 * is called — it is moved into the overlay layer as-is, frozen at `rect`,
 * so whatever was last drawn into it (xterm's own canvas included) is what
 * animates. Nothing here is undone afterward: `el` is discarded either way.
 */
export function playCloseAnimation(el, rect) {
  const anim = pickAnimation();
  const layer = overlay();
  const extra = [];

  el.classList.add('pane-closing');
  Object.assign(el.style, {
    position: 'absolute',
    left: rect.left + 'px', top: rect.top + 'px',
    width: rect.width + 'px', height: rect.height + 'px',
    margin: '0',
  });
  layer.appendChild(el);

  let duration = 650;
  try { duration = anim.run(el, rect, extra, layer) || duration; } catch { /* fall through to the default removal */ }

  return new Promise((resolve) => {
    setTimeout(() => {
      el.remove();
      for (const n of extra) n.remove();
      if (layer.childElementCount === 0) layer.remove();
      resolve();
    }, duration + 60);
  });
}

/** The registry's own names, for "there really are at least thirty" and "no two are named alike". */
export function animationNames() { return ANIMATIONS.map((a) => a.name); }
