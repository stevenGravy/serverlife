'use strict';
/**
 * Beams: ephemeral sandbox VMs, as `tsh beams` exposes them.
 *
 * A beam is not a node. It is created on demand, it expires on its own, it has
 * no entry in the cluster's node inventory, and it is reached through its own
 * verbs rather than through `tsh ssh`. So it gets its own module and its own
 * group in the host list rather than being forced into either.
 *
 * What makes the rest of the app work on one unchanged is the pair underneath:
 *
 *   - `tsh beams ssh <name>` is a terminal, exactly as `tsh ssh` is;
 *   - `tsh beams exec <name> -- <command>` runs a command, which means it can
 *     run the remote `sftp-server` and speak SFTP down its stdio.
 *
 * With those two, a beam is just another connection: the file browser, the
 * transfer queue, synchronise, compare and drag-and-drop all ride on it with
 * no idea that it is not a server.
 *
 * Not every cluster has the service. `beams ls` answering at all is the
 * capability probe — a cluster without it replies "unknown service
 * teleport.beams.v1.BeamService" — and the answer is cached per proxy, because
 * whether the service exists does not change between two clicks.
 */

const teleport = require('./teleport');

/** Global tsh flags that have to precede the subcommand. */
function base({ proxy, jumphost } = {}) {
  const args = [];
  if (proxy) args.push('--proxy=' + proxy);
  if (jumphost) args.push('--jumphost=' + jumphost);
  return args;
}

/** `tsh … beams <sub> …`, with the flags tsh insists come first. */
function argsFor(sub, rest = [], opts = {}) {
  return [...base(opts), 'beams', sub, ...rest];
}

function run(args, opts = {}) {
  return teleport.run(args, { timeout: opts.timeout || 60000, home: opts.home });
}

/** tsh colours its errors, and the UI shows them as text. */
function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
}

/**
 * One beam, as this app talks about it.
 *
 * `expires` is the fact that matters most — a beam is temporary, and a list
 * that does not say how temporary is a list of things about to disappear — so
 * it is carried as a timestamp the UI can count down from rather than as the
 * "23 hours from now" the table prints.
 */
function toBeam(b, { proxy, home } = {}) {
  const expires = b?.expires ? Date.parse(b.expires) : null;
  return {
    id: String(b?.id || ''),
    uuid: b?.uuid || '',
    owner: b?.owner || '',
    region: b?.region || '',
    // What was asked for, when the service put it somewhere else.
    requestedRegion: b?.requested_region && b.requested_region !== b?.region
      ? b.requested_region
      : '',
    url: b?.url || '',
    // The Phase it was started from, as `name` or `name@sha256:…`; empty for
    // the standard image, and for a tsh too old to say.
    phase: b?.phase || '',
    expires: Number.isFinite(expires) ? expires : null,
    proxy: proxy || '',
    home: home || null,
  };
}

/**
 * Does this cluster have the beams service?
 *
 * Deliberately the cheapest real call rather than a version check: the service
 * either answers or it does not, and a version number would only let us guess.
 */
async function supported({ proxy, home } = {}) {
  const r = await run(argsFor('ls', ['--format=json'], { proxy }), { home, timeout: 45000 });
  const out = plain(r.stdout);
  if (r.ok && (out.startsWith('[') || out.startsWith('{'))) return { ok: true };
  const error = plain(r.stderr) || out || 'tsh beams ls said nothing';
  return {
    ok: false,
    error,
    // The signature of a cluster that simply does not run the service, as
    // opposed to one that refused for a reason worth showing.
    unsupported: /unknown service teleport\.beams|not implement this feature/i.test(error),
  };
}

async function list({ proxy, home, all = false } = {}) {
  const rest = ['--format=json'];
  if (all) rest.push('--all');
  const r = await run(argsFor('ls', rest, { proxy }), { home, timeout: 45000 });
  const out = plain(r.stdout);
  const at = out.indexOf('[');
  if (at >= 0) {
    try {
      const data = JSON.parse(out.slice(at));
      if (Array.isArray(data)) {
        return { ok: true, beams: data.map((b) => toBeam(b, { proxy, home })) };
      }
    } catch { /* output that is not JSON falls through to the error */ }
  }
  return { ok: false, error: plain(r.stderr) || out || 'Could not read the beam list', beams: [] };
}

/**
 * Start a beam.
 *
 * Never with `--console`: the app opens the session itself, through the same
 * connection machinery as everything else, so that the terminal it lands in
 * carries a file browser and a transfer queue like any other.
 */
async function add({ proxy, home, region, phase, roles } = {}) {
  const rest = ['--format=json'];
  if (region) rest.push('--region=' + region);
  // Each only ever passed when addSupport() said this tsh takes it.
  if (phase) rest.push('--phase=' + phase);
  if (Array.isArray(roles) && roles.length) rest.push('--roles=' + roles.join(','));
  // Creating a sandbox VM is not instant.
  const r = await run(argsFor('add', rest, { proxy }), { home, timeout: 300000 });
  const out = plain(r.stdout);
  const at = out.indexOf('{');
  if (at >= 0) {
    try {
      return { ok: true, beam: toBeam(JSON.parse(out.slice(at)), { proxy, home }) };
    } catch { /* output that is not JSON falls through to the error */ }
  }
  return { ok: false, error: plain(r.stderr) || out || 'tsh beams add returned nothing to read' };
}

/**
 * What this tsh's `beams add` can do beyond a region: start from a Phase — a
 * saved, reusable image — and delegate chosen roles to the beam.
 *
 * Both are newer than beams. v18's tsh lists and starts beams but has neither
 * `tsh phase`, `beams add --phase` nor `beams add --roles`, and offering a
 * choice it cannot act on ends in "unknown flag" after the person has already
 * picked. So each is asked of the binary itself, from its own help, which
 * needs no cluster and no login. Kept per tsh binary, since a different tsh —
 * Settings can point at another — may answer differently.
 */
const addSupportCache = new Map();
async function addSupport({ home, proxy } = {}) {
  // Per binary and per the variables it runs with: TELEPORT_TOOLS_VERSION set
  // for a cluster makes the same tsh another version for that cluster.
  const key = `${teleport.findTsh() || 'tsh'}|${JSON.stringify(teleport.envFor(proxy))}`;
  if (addSupportCache.has(key)) return addSupportCache.get(key);
  // A tsh that cannot be run at all — missing, or too old to know `beams` —
  // answers "no" to everything rather than failing the dialog that asked.
  const ask = (args) => run([...base({ proxy }), ...args], { home, timeout: 60000 }).catch(() => ({ ok: false, stdout: '', stderr: '' }));
  const [addHelp, phaseHelp, phaseAddHelp] = await Promise.all([
    ask(['beams', 'add', '--help']), ask(['phase', '--help']), ask(['phase', 'add', '--help'])]);
  const help = plain((addHelp.stdout || '') + (addHelp.stderr || ''));
  const phaseText = plain((phaseHelp.stdout || '') + (phaseHelp.stderr || ''));
  const phaseAddText = plain((phaseAddHelp.stdout || '') + (phaseAddHelp.stderr || ''));
  const answer = {
    // `--help` exits non-zero on some builds, so read the text rather than the code.
    phases: /--phase[=\s]/.test(help) && /\bls\b/.test(plain((phaseHelp.stdout || '') + (phaseHelp.stderr || '')))
      && !/expected command but got "phase"/.test(plain(phaseHelp.stderr || '')),
    roles: /--roles[=\s]/.test(help),
    // Newer than `tsh phase` itself: a multi-stage phase.yaml, copied files,
    // and starting a build without opening its console.
    apply: /\bphase apply\b/.test(phaseText),
    copy: /--copy[=\s]/.test(phaseAddText),
    noConsole: /--\[no-\]console|--no-console/.test(phaseAddText),
  };
  addSupportCache.set(key, answer);
  return answer;
}

/** The Phases this login can start a beam from: `tsh phase ls`. */
async function phases({ proxy, home } = {}) {
  let r;
  try {
    r = await run([...base({ proxy }), 'phase', 'ls', '--format=json'], { home, timeout: 45000 });
  } catch (e) {
    return { ok: false, error: e.message || 'tsh phase ls could not be run', phases: [] };
  }
  const out = plain(r.stdout);
  const at = out.indexOf('[');
  if (at >= 0) {
    try {
      const data = JSON.parse(out.slice(at));
      if (Array.isArray(data)) {
        return {
          ok: true,
          phases: data.map((p) => ({
            name: p.name || '',
            state: p.state || '',
            parent: p.parent || '',
            region: p.region || '',
            digest: p.image_digest || '',
            owner: p.owner || '',
            strategy: p.strategy || '',
            roles: Array.isArray(p.roles) ? p.roles : [],
            publishedAt: p.published_at ? Date.parse(p.published_at) || null : null,
            nextBuild: p.next_build ? Date.parse(p.next_build) || null : null,
            // Why a build failed, and how to look inside what it left.
            lastError: p.last_error || '',
            // The build Beam of a build still running: where to save it from.
            buildBeam: p.build_beam || '',
          })).filter((p) => p.name),
        };
      }
    } catch { /* output that is not JSON falls through to the error */ }
  }
  return { ok: false, error: plain(r.stderr) || out || 'Could not read the Phase list', phases: [] };
}

/** Builds that failed, and the snapshot each left: `tsh phase ls-failed`. */
async function failedPhases({ proxy, home } = {}) {
  let r;
  try {
    r = await run([...base({ proxy }), 'phase', 'ls-failed', '--format=json'], { home, timeout: 45000 });
  } catch (e) {
    return { ok: false, error: e.message || 'tsh phase ls-failed could not be run', failed: [] };
  }
  const out = plain(r.stdout);
  const at = out.indexOf('[');
  if (at >= 0) {
    try {
      const data = JSON.parse(out.slice(at));
      if (Array.isArray(data)) {
        return {
          ok: true,
          failed: data.map((f) => ({
            phase: f.phase || '',
            digest: f.digest || '',
            at: f.timestamp ? Date.parse(f.timestamp) || null : null,
            expires: f.expiration ? Date.parse(f.expiration) || null : null,
          })).filter((f) => f.phase),
        };
      }
    } catch { /* output that is not JSON falls through to the error */ }
  }
  return { ok: false, error: plain(r.stderr) || out || 'Could not read the failed builds', failed: [] };
}

/**
 * A Phase build: `tsh phase add`, or `tsh phase edit` for one that exists.
 *
 * Both open an interactive build console — a shell on a build beam, where
 * you install what the image should have and finish with
 * `tsh phase snapshot --final` — so they are run in a terminal tab, not here;
 * this only says what to run. `from` builds on another Phase as the base
 * image; `forkFrom` starts from another Phase's last saved files (the two
 * are different requests to tsh, so never both); `roles` limits what the
 * builds may act as, and is otherwise inherited.
 */
function phaseAddArgs({ proxy, name, from, forkFrom, commandsFile, copies, noConsole, roles, region } = {}) {
  if (from && forkFrom) throw new Error('Build on a Phase or fork one — not both');
  // A fork starts from saved files; a command file is a recipe run on a base.
  if (forkFrom && commandsFile) throw new Error('A fork starts from saved files — it takes no command file');
  const copyArgs = copyFlags(copies);
  if (copyArgs.length && (commandsFile || forkFrom)) throw new Error('Copied files make a Phase of their own — not with a command file or a fork');
  const args = [...base({ proxy }), 'phase', 'add'];
  if (name) args.push(String(name));
  if (from) args.push('--from=' + from);
  if (forkFrom) args.push('--fork-from=' + forkFrom);
  // Instead of an interactive console: the build runs the file and streams its log.
  if (commandsFile) args.push('--commands-file=' + commandsFile);
  args.push(...copyArgs);
  if (noConsole) args.push('--no-console');
  if (Array.isArray(roles) && roles.length) args.push('--roles=' + roles.join(','));
  if (region) args.push('--region=' + region);
  return args;
}

/**
 * `--copy=<destination>:<local source>`, once per file: tsh writes the
 * destination first, which reads backwards next to everything else, so the
 * callers pass { from, to } and this spells it.
 */
function copyFlags(copies) {
  if (!Array.isArray(copies)) return [];
  return copies.filter((c) => c && (c.from || c.to)).map((c) => {
    const to = String(c.to || '').trim();
    const from = String(c.from || '').trim();
    if (!to.startsWith('/')) throw new Error(`Where in the Beam should ${from || 'it'} go? An absolute path, outside /home`);
    if (to === '/home' || to.startsWith('/home/')) throw new Error(`${to}: copied files go outside /home`);
    if (!from) throw new Error(`Which local file goes to ${to}?`);
    return `--copy=${to}:${from}`;
  });
}

/**
 * `tsh phase edit`: a build console on its saved files, or — for a Phase
 * built from commands or copied files — those replaced: a new command file,
 * or the files copied again.
 */
function phaseEditArgs({ proxy, name, from, commandsFile, copies, noConsole, region } = {}) {
  if (!name) throw new Error('Which Phase?');
  const copyArgs = copyFlags(copies);
  if (commandsFile && copyArgs.length) throw new Error('A command file or copied files — not both');
  if (from && (commandsFile || copyArgs.length)) throw new Error('Editing from another Phase takes no command file or copies');
  const args = [...base({ proxy }), 'phase', 'edit', String(name)];
  if (from) args.push('--from=' + from);
  if (commandsFile) args.push('--commands-file=' + commandsFile);
  args.push(...copyArgs);
  if (noConsole) args.push('--no-console');
  if (region) args.push('--region=' + region);
  return args;
}

/**
 * `tsh phase apply -f`: every stage of a phase.yaml, in order. It opens no
 * console — it streams each stage's log and returns when the last is saved
 * (or one fails) — so it still runs in a terminal tab, for the log.
 */
function phaseApplyArgs({ proxy, file, noConsole, region } = {}) {
  if (!file) throw new Error('Which phase.yaml?');
  const args = [...base({ proxy }), 'phase', 'apply', '--file=' + file];
  if (noConsole) args.push('--no-console');
  if (region) args.push('--region=' + region);
  return args;
}

/**
 * Save a running build: `tsh phase snapshot` inside its build Beam, run there
 * through `beams exec` — the snapshot is taken by the builder in that Beam,
 * so it has to be asked from inside. `final` ends the build once saved;
 * `force` leaves out changes outside /home instead of refusing them.
 */
async function phaseSnapshot({ beam, proxy, home, final = false, force = false } = {}) {
  if (!beam) throw new Error('Which build Beam?');
  const cmd = ['tsh', 'phase', 'snapshot', force ? '--force' : '', final ? '--final' : ''].filter(Boolean).join(' ');
  let r;
  try {
    r = await run(argsFor('exec', [beam, '--', cmd], { proxy }), { home, timeout: 15 * 60000 });
  } catch (e) {
    return { ok: false, output: e.message || 'tsh beams exec could not be run' };
  }
  const output = plain((r.stdout || '') + '\n' + (r.stderr || '')).trim();
  // --final ends the Beam it ran in, which can cut the exec off before it
  // reports: the Phase list says whether it was saved, not this exit code.
  return { ok: !!r.ok, output };
}

/**
 * The services beam-init runs in a Beam — what a Phase's services: became —
 * from `beamctl --json list` inside it.
 */
async function beamServices({ name, proxy, home } = {}) {
  if (!name) throw new Error('Which beam?');
  const r = await run(argsFor('exec', [name, '--', 'beamctl --json list'], { proxy }), { home, timeout: 60000 }).catch((e) => ({ ok: false, stdout: '', stderr: e.message }));
  const out = plain(r.stdout || '');
  const at = out.search(/[[{]/);
  if (r.ok && at >= 0) {
    try {
      const data = JSON.parse(out.slice(at));
      return { ok: true, services: servicesFrom(data) };
    } catch { /* falls through */ }
  }
  return { ok: false, error: plain(r.stderr || '') || out || 'beamctl list said nothing', services: [] };
}

/**
 * `beamctl --json list` is a map of name to its one state —
 * { "web": { "running": { "main_pid": 165 } }, "init": { "exited": { "code": 0 } } }
 * — said here as a name and a few words.
 */
function servicesFrom(data) {
  if (Array.isArray(data)) return data.map((s) => ({ name: s.name || '', status: s.status || s.state || '' }));
  return Object.entries(data || {}).map(([name, st]) => {
    const [state, detail] = Object.entries(st || {})[0] || ['unknown', {}];
    let status = state;
    if (state === 'running' && detail?.main_pid) status = `running (pid ${detail.main_pid})`;
    else if (state === 'exited' && detail && 'code' in detail) status = detail.code === 0 ? 'finished' : `exited with ${detail.code}`;
    else if (detail?.reason) status = `${state}: ${detail.reason}`;
    return { name, status, state };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** One service's log so far: `beamctl logs <service>` inside the Beam. */
async function beamServiceLogs({ name, service, proxy, home } = {}) {
  if (!name || !service) throw new Error('Which beam and service?');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(service)) throw new Error('Not a service name');
  const r = await run(argsFor('exec', [name, '--', `beamctl logs ${service}`], { proxy }), { home, timeout: 60000 }).catch((e) => ({ ok: false, stdout: '', stderr: e.message }));
  return { ok: !!r.ok, output: plain((r.stdout || '') + (r.ok ? '' : '\n' + (r.stderr || ''))).trim() };
}

/**
 * Delete a Phase: `tsh phase rm`, which asks nothing of its own — the app
 * asks first. Beams already started from it keep running; it is the image
 * that goes, and what is built from it next.
 */
async function removePhase({ name, proxy, home } = {}) {
  if (!name) throw new Error('Which Phase?');
  let r;
  try {
    r = await run([...base({ proxy }), 'phase', 'rm', name], { home, timeout: 120000 });
  } catch (e) {
    return { ok: false, output: e.message || 'tsh phase rm could not be run' };
  }
  const output = plain((r.stdout || '') + '\n' + (r.stderr || ''));
  return { ok: !!r.ok, output };
}

/**
 * Delete a beam, retrying the one failure that asks to be retried.
 *
 * The service uses optimistic concurrency, so deleting a beam that was
 * created moments ago — or that something else touched at the same instant —
 * comes back with "condition failed … please reload the current state and try
 * again". That is a race, not a refusal: the same call a moment later
 * succeeds. Anything else is reported as it stands.
 */
async function remove({ name, proxy, home } = {}) {
  if (!name) throw new Error('Which beam?');
  const retryable = /condition failed|reload the current state|try again/i;
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 700 * attempt));
    const r = await run(argsFor('rm', [name], { proxy }), { home, timeout: 120000 });
    const output = plain(r.stdout + '\n' + r.stderr);
    if (r.ok) return { ok: true, output, attempts: attempt + 1 };
    last = { ok: false, output, attempts: attempt + 1 };
    // "Does not exist" means someone else got there first, which is the
    // outcome the caller wanted.
    if (/does not exist/i.test(output)) return { ok: true, output, gone: true, attempts: attempt + 1 };
    if (!retryable.test(output)) break;
  }
  return last || { ok: false, output: 'tsh beams rm said nothing' };
}

/**
 * Whether the cluster still lists a beam.
 *
 * `rm` returning is not the same as the beam being gone from `ls`, so a
 * caller that wants to report "deleted" honestly has to look.
 */
async function stillListed({ name, proxy, home } = {}) {
  const r = await list({ proxy, home });
  if (!r.ok) return null;                 // cannot tell
  return r.beams.some((b) => b.id === name || b.uuid === name);
}

/** Run one command in a beam and capture its output. */
async function exec({ name, proxy, home, command, timeout } = {}) {
  if (!name) throw new Error('Which beam?');
  if (!command) throw new Error('No command');
  const r = await run(argsFor('exec', [name, '--', command], { proxy }), {
    home, timeout: timeout || 120000,
  });
  return { ok: r.ok, output: plain(r.stdout), error: plain(r.stderr) };
}

/**
 * Publish a service running inside a beam, so it can be reached from outside.
 *
 * The beams answer to a port forward: HTTP by default, TCP with the flag. The
 * address comes back in the output, which is the only thing the caller wants.
 */
async function publish({ name, proxy, home, tcp = false } = {}) {
  if (!name) throw new Error('Which beam?');
  const rest = [];
  if (tcp) rest.push('--tcp');
  rest.push(name);
  const r = await run(argsFor('publish', rest, { proxy }), { home, timeout: 120000 });
  const text = plain(r.stdout + '\n' + r.stderr);
  // Whatever it printed that looks like where the service now lives.
  const url = (text.match(/https?:\/\/\S+/) || [])[0]
    || (text.match(/\b[\w.-]+\.[a-z]{2,}(?::\d+)?\b/i) || [])[0]
    || '';
  return { ok: r.ok, output: text, url };
}

async function unpublish({ name, proxy, home } = {}) {
  if (!name) throw new Error('Which beam?');
  const r = await run(argsFor('unpublish', [name], { proxy }), { home, timeout: 120000 });
  return { ok: r.ok, output: plain(r.stdout + '\n' + r.stderr) };
}

/**
 * `tsh beams scp`, for the cases the file browser cannot serve.
 *
 * The browser speaks SFTP over `beams exec` and is the better tool for
 * anything interactive; this exists because it is part of the command set, it
 * is what a script would use, and a whole-directory copy is one call here
 * against a walk there. Paths are `beam:path` on the beam side, exactly as tsh
 * spells them.
 */
async function scp({ src, dest, proxy, home, recursive = false, quiet = true } = {}) {
  if (!src || !dest) throw new Error('scp needs a source and a destination');
  const rest = [];
  if (recursive) rest.push('--recursive');
  if (quiet) rest.push('--quiet');
  rest.push(src, dest);
  const r = await run(argsFor('scp', rest, { proxy }), { home, timeout: 600000 });
  return { ok: r.ok, output: plain(r.stdout + '\n' + r.stderr) };
}

/* ------------------------------------------------------------------ */
/* Transport argv                                                      */
/* ------------------------------------------------------------------ */

/**
 * The argv a connection spawns for a terminal in a beam.
 *
 * `beams ssh` takes the beam's name and nothing else — no login, no port, no
 * host — which is why a beam connection carries a name rather than a target.
 */
function sshArgs({ name, proxy, jumphost } = {}, extra = []) {
  return [...argsFor('ssh', [], { proxy, jumphost }), ...extra, name];
}

/** The same for a command, which is how SFTP gets a channel. */
function execArgs({ name, proxy, jumphost } = {}, command = null) {
  const rest = [name];
  if (command) rest.push('--', command);
  return argsFor('exec', rest, { proxy, jumphost });
}

module.exports = {
  supported, list, add, remove, stillListed, exec, publish, unpublish, scp, addSupport, phases, removePhase, phaseAddArgs, phaseEditArgs, failedPhases,
  phaseApplyArgs, phaseSnapshot, beamServices, beamServiceLogs, copyFlags, servicesFrom,
  sshArgs, execArgs, toBeam,
};
