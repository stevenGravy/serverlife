/**
 * What a renderer module needs to exist outside the window.
 *
 * The modules under test are the real ones — nothing is reimplemented here —
 * so the few things they reach for have to be present: a settings store that
 * answers like the IPC one, and a clock that can be moved. Anything that
 * touches the DOM is out of scope for these tests by design; the pure logic
 * is where the bugs that matter have actually been.
 */

/**
 * A stand-in for `window.api.settings`, backed by a plain object.
 *
 * The real one merges a patch into the stored settings and hands the whole
 * lot back, and every caller assigns the result to `state.settings` — so
 * that is exactly what this does. Anything else and the tests would pass
 * against a contract the app does not have.
 */
export function fakeSettings(initial = {}) {
  const store = { ...initial };
  globalThis.window = globalThis.window || {};
  globalThis.window.api = {
    ...(globalThis.window.api || {}),
    settings: {
      get: async () => ({ ...store }),
      set: async (patch) => Object.assign(store, patch),
    },
  };
  return store;
}

/** Run `fn` with `Date.now()` moved on by `ms`, then put the clock back. */
export async function withClock(ms, fn) {
  const real = Date.now;
  const base = real();
  Date.now = () => base + ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

/** A Teleport node, as `listNodes` shapes one. */
export function node(name, labels = {}, extra = {}) {
  return {
    id: `tsh:c1:${name}`,
    type: 'teleport',
    name,
    hostname: name,
    uuid: `uuid-${name}`,
    cluster: 'c1',
    proxy: 'proxy.example:443',
    home: null,
    addr: '',
    tunnel: true,
    labels,
    ...extra,
  };
}

/** A host read from an ssh_config. */
export function sshHost(alias, extra = {}) {
  return {
    id: `ssh:${alias}`,
    type: 'ssh',
    alias,
    name: alias,
    hostname: `${alias}.example`,
    user: 'root',
    port: 22,
    ...extra,
  };
}
