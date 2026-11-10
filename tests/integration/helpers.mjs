/**
 * The two targets every shared test runs against, and the waiting that a real
 * cluster needs and a unit test never does.
 *
 * Nothing here stands in for ServerLife: the modules are the app's own,
 * loaded from src/main exactly as the main process loads them. What changes
 * between the targets is only the host descriptor — the same shape the
 * sidebar hands ConnectionManager.create.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require_ = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const main = (name) => require_(path.join(ROOT, 'src', 'main', name));

export const PROXY = process.env.IT_PROXY || 'proxy:3080';
export const CLUSTER = process.env.IT_CLUSTER || 'sltest';
export const NODE = process.env.IT_NODE || 'node1';
export const LOGIN = 'tester';

/** Poll until `fn` returns something truthy, or fail saying what was awaited. */
export async function waitFor(what, fn, { timeout = 60000, every = 1000 } = {}) {
  const until = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    if (Date.now() > until) {
      const why = last instanceof Error ? `: ${last.message}` : '';
      throw new Error(`timed out after ${timeout / 1000}s waiting for ${what}${why}`);
    }
    await new Promise((r) => setTimeout(r, every));
  }
}

/** The Teleport node as listNodes describes it, once the agent has joined. */
export async function teleportNode() {
  const teleport = main('teleport.js');
  return waitFor(`${NODE} to join ${CLUSTER}`, async () => {
    const r = await teleport.listNodes({ proxy: PROXY, cluster: CLUSTER });
    return r.ok && r.nodes.find((n) => n.hostname === NODE);
  }, { timeout: 90000, every: 2000 });
}

/**
 * Both ways into the node, as sidebar host descriptors.
 *
 * `openssh` is an ssh_config alias (written by runner.sh); `teleport` is the
 * node as `tsh ls` reports it. Each test that applies to both is run once per
 * entry, so a difference between the two is a failure with the target's name
 * on it.
 */
export async function targets() {
  return [
    { name: 'openssh', host: { id: 'ssh:opensshnode', type: 'ssh', alias: 'opensshnode', name: 'opensshnode' } },
    { name: 'teleport', host: await teleportNode(), login: LOGIN },
  ];
}

/** A connected Connection for a target, from a manager the caller shuts down. */
export async function connect(manager, target) {
  const conn = await manager.create(target.host, { login: target.login });
  await conn.connect();
  return conn;
}

/** Resolve when a queued transfer finishes; reject with its error if it fails. */
export function finished(queue, jobId, { timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const check = (view) => {
      const job = view.find((j) => j.id === jobId);
      if (!job) return;
      if (job.status === 'done') { cleanup(); resolve(job); }
      if (['error', 'cancelled'].includes(job.status)) {
        cleanup();
        reject(new Error(`transfer ${job.status}: ${job.error || 'no error given'}`));
      }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('transfer timed out')); }, timeout);
    const cleanup = () => { clearTimeout(timer); queue.off('update', check); };
    queue.on('update', check);
    check(queue.view());
  });
}

/** A unique remote scratch folder under the login's home. */
export function scratch(conn, label) {
  return `${conn.homeDir}/it-${label}-${Date.now().toString(36)}`;
}
