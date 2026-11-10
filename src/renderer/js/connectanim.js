import { el } from './util.js';
import { state } from './state.js';

/**
 * The little scene that plays while a session dials.
 *
 * Connecting is dead time — a few seconds of a spinner and a log. These fill it
 * with something to look at: a courier of some kind crossing from this machine
 * to the server, over a link drawn as a pipe, a wire, rails or waves. Thirty of
 * them rotate, so the same one rarely comes up twice in a sitting.
 *
 * The two machines are drawn; the traveller is a glyph. That split keeps the
 * scene consistent while letting the cast be as silly as it likes.
 */

/**
 * `motion` is how the traveller crosses, `trail` is what it crosses over, and
 * `cast` is who is doing the crossing — the second and third entries follow
 * behind when the motion carries a convoy.
 */
export const CONNECT_ANIMS = [
  { id: 'robots', name: 'Robots shaking hands', cast: ['🤖', '🦾'], motion: 'march', trail: 'dots' },
  { id: 'tubes', name: 'Pneumatic tubes', cast: ['📦'], motion: 'shoot', trail: 'pipe' },
  { id: 'rocket', name: 'Rocket post', cast: ['🚀'], motion: 'slide', trail: 'beam' },
  { id: 'pigeon', name: 'Carrier pigeon', cast: ['🐦'], motion: 'flap', trail: 'none' },
  { id: 'satellite', name: 'Satellite relay', cast: ['🛰️'], motion: 'arc', trail: 'arc' },
  { id: 'train', name: 'Freight train', cast: ['🚂', '🚃', '🚃'], motion: 'convoy', trail: 'rails' },
  { id: 'submarine', name: 'Undersea cable', cast: ['🚢'], motion: 'bob', trail: 'waves' },
  { id: 'plane', name: 'Paper plane', cast: ['✈️'], motion: 'glide', trail: 'dash' },
  { id: 'ants', name: 'Ants with packets', cast: ['🐜', '🐜', '🐜'], motion: 'convoy', trail: 'wire' },
  { id: 'laser', name: 'Laser link', cast: ['✨'], motion: 'zip', trail: 'beam' },
  { id: 'conveyor', name: 'Conveyor belt', cast: ['📦', '📦'], motion: 'convoy', trail: 'belt' },
  { id: 'hamster', name: 'Hamster-powered', cast: ['🐹'], motion: 'roll', trail: 'wire' },
  { id: 'lightning', name: 'Lightning link', cast: ['⚡'], motion: 'zip', trail: 'bolt' },
  { id: 'teleport', name: 'Teleporter', cast: ['🫠'], motion: 'beamup', trail: 'portal' },
  { id: 'snail', name: 'Snail mail', cast: ['🐌'], motion: 'crawl', trail: 'slime' },
  { id: 'balloon', name: 'Hot air balloon', cast: ['🎈'], motion: 'drift', trail: 'none' },
  { id: 'bucket', name: 'Bucket brigade', cast: ['🪣', '🪣'], motion: 'convoy', trail: 'wire' },
  { id: 'zipline', name: 'Zip line', cast: ['🧗'], motion: 'shoot', trail: 'wire' },
  { id: 'morse', name: 'Morse code', cast: ['•', '—', '•'], motion: 'convoy', trail: 'dash' },
  { id: 'tincan', name: 'Tin can telephone', cast: ['🥫'], motion: 'slide', trail: 'wire' },
  { id: 'drone', name: 'Drone delivery', cast: ['🛸'], motion: 'hover', trail: 'dots' },
  { id: 'cat', name: 'Cat chasing a packet', cast: ['🐈', '🧶'], motion: 'chase', trail: 'none' },
  { id: 'wormhole', name: 'Wormhole', cast: ['🌀'], motion: 'beamup', trail: 'portal' },
  { id: 'bridge', name: 'Bridge builder', cast: ['🔨'], motion: 'build', trail: 'planks' },
  { id: 'bees', name: 'Busy bees', cast: ['🐝', '🐝'], motion: 'flap', trail: 'dots' },
  { id: 'traffic', name: 'Rush hour', cast: ['🚚', '🚗'], motion: 'convoy', trail: 'road' },
  { id: 'radio', name: 'Radio waves', cast: ['📡'], motion: 'pulse', trail: 'ripple' },
  { id: 'dolphin', name: 'Dolphin express', cast: ['🐬'], motion: 'bob', trail: 'waves' },
  { id: 'ghost', name: 'Friendly packet ghost', cast: ['👻'], motion: 'drift', trail: 'none' },
  { id: 'scooter', name: 'Courier scooter', cast: ['🛵'], motion: 'slide', trail: 'road' },
];

const byId = new Map(CONNECT_ANIMS.map((a) => [a.id, a]));

/** Where the rotation is up to. Per machine, not per session — it should move. */
const ROTATE_KEY = 'serverlife.connectAnim';

function nextInRotation() {
  let i = 0;
  try { i = parseInt(localStorage.getItem(ROTATE_KEY) || '0', 10) || 0; } catch { /* blocked storage starts the rotation at the first one */ }
  const anim = CONNECT_ANIMS[((i % CONNECT_ANIMS.length) + CONNECT_ANIMS.length) % CONNECT_ANIMS.length];
  try { localStorage.setItem(ROTATE_KEY, String((i + 1) % CONNECT_ANIMS.length)); } catch { /* blocked storage only means the rotation does not advance */ }
  return anim;
}

/** The setting, resolved: nothing when off, the pinned one, or the next up. */
export function pickConnectAnim() {
  const pref = state.settings?.connectAnim ?? 'rotate';
  if (pref === 'off') return null;
  if (pref !== 'rotate' && byId.has(pref)) return byId.get(pref);
  return nextInRotation();
}

/* ------------------------------------------------------------------ */
/* Drawing                                                             */
/* ------------------------------------------------------------------ */

function svg(viewBox, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', viewBox);
  node.append(...children);
  return node;
}

function shape(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** This machine: a laptop, lid open. */
function deskMachine() {
  return svg('0 0 40 32',
    shape('rect', { x: 7, y: 4, width: 26, height: 17, rx: 2, class: 'body' }),
    shape('rect', { x: 10, y: 7, width: 20, height: 11, rx: 1, class: 'screen' }),
    shape('path', { d: 'M3 24h34l-2 4H5z', class: 'body' }),
    shape('circle', { cx: 13, cy: 12.5, r: 1.4, class: 'led' }));
}

/** The far end: a rack, lights blinking out of step with ours. */
function rackMachine() {
  return svg('0 0 40 32',
    shape('rect', { x: 8, y: 2, width: 24, height: 28, rx: 2.5, class: 'body' }),
    shape('rect', { x: 11, y: 6, width: 18, height: 5, rx: 1, class: 'screen' }),
    shape('rect', { x: 11, y: 14, width: 18, height: 5, rx: 1, class: 'screen' }),
    shape('rect', { x: 11, y: 22, width: 18, height: 5, rx: 1, class: 'screen' }),
    shape('circle', { cx: 14, cy: 8.5, r: 1.3, class: 'led' }),
    shape('circle', { cx: 14, cy: 16.5, r: 1.3, class: 'led b' }),
    shape('circle', { cx: 14, cy: 24.5, r: 1.3, class: 'led' }));
}

/**
 * Build the scene for one animation. It is pure CSS once it is on the page —
 * no timers, nothing to tear down but the element itself.
 */
export function buildConnectAnim(anim) {
  const a = typeof anim === 'string' ? byId.get(anim) : anim;
  if (!a) return null;

  const track = el('div', { class: 'canim-track' });
  a.cast.forEach((glyph, i) => {
    const actor = el('span', { class: 'canim-actor', text: glyph });
    // Followers leave later, so a convoy strings out instead of stacking up.
    actor.style.animationDelay = `${i * 0.55}s`;
    track.append(actor);
  });

  const stage = el('div', { class: `canim canim-${a.motion} trail-${a.trail}` },
    el('div', { class: 'canim-end left' }, deskMachine()),
    track,
    el('div', { class: 'canim-end right' }, rackMachine()));

  return el('div', { class: 'canim-wrap' },
    stage,
    el('div', { class: 'canim-name', text: a.name }));
}

/** The scene for whatever the preference says, or nothing when it says off. */
export function connectScene() {
  const a = pickConnectAnim();
  return a ? buildConnectAnim(a) : null;
}
