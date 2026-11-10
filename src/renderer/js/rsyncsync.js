import { state } from './state.js';
import { el, clear, uid } from './util.js';
import { modal, toast, status, checkbox, contextMenu } from './ui.js';

/**
 * Synchronising a folder with rsync, from the file browser's own menu.
 *
 * The browser already has a synchronise of its own: it walks both folders
 * over SFTP and copies what differs. That is the right answer for a handful
 * of files and the wrong one for a tree — it compares by listing, moves
 * whole files, and pays a round trip per entry. rsync compares by rolling
 * checksum and sends only the blocks that changed, which for "make this 4GB
 * directory look like that one" is not a little faster but a different
 * order of magnitude.
 *
 * Three things this has to get right, in order:
 *
 *   It must not surprise you. A sync with `--delete` can empty a directory,
 *   so the dialog opens on a dry run, and the real thing is a second,
 *   separate press with the plan already on screen.
 *
 *   It must reuse the connection. rsync runs itself on the far side over a
 *   shell of our choosing, which means it can ride the ControlMaster the
 *   session is already holding: no second authentication, no second
 *   Teleport session.
 *
 *   It must say what it is about to run. The command line is on screen,
 *   selectable, and is exactly what gets executed — no hidden flags.
 */

/* ------------------------------------------------------------------ */
/* What can be synced, and from where                                  */
/* ------------------------------------------------------------------ */

/** A side of the sync: a local path, or a path on a connected host. */
function sideOf(explorer) {
  if (!explorer) return null;
  const kind = explorer.source?.kind;
  if (kind === 'local') {
    return { kind: 'local', path: explorer.view?.path || '', label: 'this machine', explorer };
  }
  if (kind === 'remote' && explorer.connId) {
    const conn = state.getConnection(explorer.connId);
    return {
      kind: 'remote',
      connId: explorer.connId,
      path: explorer.view?.path || '',
      label: conn?.label || conn?.target || 'the server',
      explorer,
    };
  }
  // S3 has no shell to run rsync on, and no ssh to reach it with.
  return { kind: kind || 'other', unsupported: true, label: kind === 's3' ? 'a bucket' : 'this pane' };
}

/** The other file pane, if there is exactly one worth syncing with. */
function otherSide(explorer, explorers) {
  const others = [...explorers.values()].filter((e) => e !== explorer && e.element?.isConnected);
  const usable = others.filter((e) => ['local', 'remote'].includes(e.source?.kind));
  return usable[0] ? sideOf(usable[0]) : null;
}

/**
 * The starred folders, as somewhere to sync to or from.
 *
 * Stars already mean "a folder I keep coming back to", which is very nearly
 * the same list as "a folder I keep copying". Offering them here saves
 * retyping `/var/log/app` for the fourth time, and — more to the point — a
 * path you picked from a list is a path you have not fat-fingered into a
 * `--delete`.
 */
export function starredFolders(side) {
  const favs = state.settings.folderFavorites || [];
  const wantLocal = side?.kind === 'local';
  return favs
    .filter((f) => (f.kind || 'dir') === 'dir')
    .filter((f) => (wantLocal ? f.scope === 'local' : f.scope !== 'local'))
    .map((f) => ({ path: f.path, label: f.label || f.path }));
}

/**
 * The list as the pane itself would show it — the saved stars *and* the
 * defaults a host always offers, like the home directory and /var/log.
 * Reading it from the pane rather than from settings is what makes the
 * picker useful on a machine nobody has starred anything on yet.
 */
async function starsFor(side) {
  try {
    const fromPane = await side?.explorer?.favoriteFolders?.();
    if (fromPane?.length) return fromPane.map((f) => ({ path: f.path, label: f.label || f.path }));
  } catch { /* no pane favourites: fall back to the saved ones */ }
  return starredFolders(side);
}

/* ------------------------------------------------------------------ */
/* The command                                                         */
/* ------------------------------------------------------------------ */

/**
 * A path as rsync wants it: a trailing slash means "the contents of this
 * directory", and no trailing slash means "this directory, inside the
 * destination". Every rsync surprise starts here, so it is made explicit in
 * the dialog rather than inferred.
 */
export function endpoint(side, path, { contents = true } = {}) {
  const p = String(path || '').replace(/\/+$/, '') + (contents ? '/' : '');
  if (side.kind === 'local') return p;
  return `${side.target || side.label}:${p}`;
}

/**
 * Build the argument list. Pure, and the part worth testing: everything the
 * user ticked has to land as a flag, nothing else may, and the two paths go
 * last in the order the direction says.
 */
export function buildArgs(opts) {
  const {
    from, to, archive = true, compress = true, del = false, dryRun = true,
    excludes = [], extra = '', features = {}, checksum = false, times = true,
  } = opts;

  const args = [];
  if (archive) args.push('-a');
  else if (times) args.push('-rt');
  if (compress) args.push('-z');
  args.push('-h');                                   // human-readable sizes
  if (checksum) args.push('-c');
  if (del) args.push('--delete');
  if (dryRun) args.push('-n');
  // A progress meter the caller can actually read, where the binary has it.
  args.push(features.infoProgress ? '--info=progress2,stats2' : '--progress');
  args.push('-v');
  // Paths with spaces survive the remote shell without the caller quoting.
  if (features.protectArgs) args.push('-s');
  for (const x of excludes) {
    const v = String(x).trim();
    if (v) args.push('--exclude', v);
  }
  for (const x of String(extra || '').split(/\s+/)) {
    if (x) args.push(x);
  }
  if (opts.shellArg) args.push('-e', opts.shellArg);
  args.push(from, to);
  return args;
}

/** The command as a line of text, for the dialog to show and for the log. */
export function commandLine(args) {
  return ['rsync', ...args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(' ');
}

/* ------------------------------------------------------------------ */
/* The dialog                                                          */
/* ------------------------------------------------------------------ */

let wired = false;
const listeners = new Map();   // run id -> { out, done }

function wireOnce() {
  if (wired) return;
  wired = true;
  window.api.rsync.onOut((m) => listeners.get(m.id)?.out?.(m));
  window.api.rsync.onDone((m) => listeners.get(m.id)?.done?.(m));
}

/**
 * Open the sync dialog for one explorer's current folder.
 *
 * `explorers` is passed in rather than imported to keep this module off the
 * explorer's import path — it is opened from a menu, and nothing else needs
 * to know it exists.
 */
export async function openRsyncDialog(explorer, explorers) {
  wireOnce();

  const check = await window.api.rsync.check();
  if (!check.ok) return toast(check.error, 'error', 9000);

  const here = sideOf(explorer);
  const there = otherSide(explorer, explorers);
  if (here?.unsupported) return toast(`rsync cannot run against ${here.label}.`, 'error');
  if (!there) return toast('Open a second file pane — rsync copies between two places', 'error');
  if (there.unsupported) return toast(`rsync cannot run against ${there.label}.`, 'error');
  if (here.kind === 'remote' && there.kind === 'remote') {
    /*
     * Not a rule of this app's making: rsync refuses two remote endpoints
     * outright — "The source and destination cannot both be remote" —
     * before it opens a connection to either. There is no flag for it, and
     * the workarounds all amount to two transfers through this machine,
     * which is exactly what Copy to another server already does.
     */
    return toast('rsync will not copy server to server \u2014 it refuses two remote ends outright. '
      + 'Select the files and use Copy to another server\u2026, or sync each side against this machine.',
    'error', 11000);
  }

  // The ssh the remote side will be reached through, and its refusal if it
  // cannot be: a per-session-MFA node, a beam, a session not yet connected.
  const remoteSide = here.kind === 'remote' ? here : there.kind === 'remote' ? there : null;
  let transport = null;
  if (remoteSide) {
    transport = await window.api.rsync.transport(remoteSide.connId);
    if (!transport.ok) return toast(transport.reason, 'error', 10000);
    remoteSide.target = transport.target;
  }

  let reversed = false;          // false: here → there
  let dryRun = true;
  const state0 = {
    archive: true, compress: true, del: false, checksum: false, contents: true,
    excludes: '', extra: '',
  };
  const paths = { here: here.path, there: there.path };

  const srcIn = el('input', { class: 'nt-in', value: paths.here, spellcheck: 'false' });
  const dstIn = el('input', { class: 'nt-in', value: paths.there, spellcheck: 'false' });
  const srcLabel = el('span', { class: 'rs-side' });
  const dstLabel = el('span', { class: 'rs-side' });

  const sides = () => (reversed ? [there, here] : [here, there]);
  const cmdLine = el('div', { class: 'rs-cmd' });
  const out = el('pre', { class: 'rs-out' });
  const foot = el('div', { class: 'rs-foot' });

  const argsNow = () => {
    const [src, dst] = sides();
    return buildArgs({
      from: endpoint(src, srcIn.value, { contents: state0.contents }),
      to: endpoint(dst, dstIn.value, { contents: false }),
      archive: state0.archive,
      compress: state0.compress,
      del: state0.del,
      checksum: state0.checksum,
      dryRun,
      excludes: state0.excludes.split(/[\n,]/),
      extra: state0.extra,
      features: check.features,
      shellArg: transport ? transport.shell : '',
    });
  };

  const paint = () => {
    const [src, dst] = sides();
    srcLabel.textContent = `from ${src.label}`;
    dstLabel.textContent = `to ${dst.label}`;
    cmdLine.textContent = commandLine(argsNow());
  };

  /** Star picker for one field: the folders you already keep coming back to. */
  const starBtn = (input, whichSide) => el('button', {
    class: 'ghost-btn sm', text: '☆',
    title: 'Pick one of your starred folders',
    onClick: async (e) => {
      const side = whichSide();
      const favs = await starsFor(side);
      if (!favs.length) return toast('No starred folders for that side yet', 'error');
      contextMenu(e.clientX, e.clientY, [
        { heading: true, label: `Starred on ${side.label}` },
        ...favs.map((f) => ({
          label: f.label, title: f.path,
          onClick: () => { input.value = f.path; paint(); },
        })),
      ]);
    },
  });

  const row = (label, input, whichSide) => el('div', { class: 'rs-row' },
    el('div', { class: 'rs-lab' }, el('strong', { text: label }), whichSide === null ? null : (label === 'Source' ? srcLabel : dstLabel)),
    el('div', { class: 'rs-field' }, input, starBtn(input, whichSide)));

  const swap = el('button', {
    class: 'ghost-btn sm', text: '⇅ Swap direction',
    onClick: () => {
      reversed = !reversed;
      const a = srcIn.value; srcIn.value = dstIn.value; dstIn.value = a;
      paint();
    },
  });

  const boxes = [
    ['archive', 'Archive (-a) — recurse, and keep times, links and permissions'],
    ['compress', 'Compress in flight (-z)'],
    ['del', 'Delete what is not in the source (--delete)'],
    ['checksum', 'Compare by checksum rather than size and time (-c)'],
    ['contents', 'Copy the contents of the source folder, not the folder itself'],
  ].map(([key, label]) => {
    const c = checkbox(label, state0[key]);
    c.input.addEventListener('change', () => { state0[key] = c.input.checked; paint(); });
    if (key === 'del') c.classList.add('rs-danger');
    return c;
  });

  const exIn = el('input', {
    class: 'nt-in', placeholder: '.git, node_modules, *.tmp', spellcheck: 'false',
    onInput: (e) => { state0.excludes = e.target.value; paint(); },
  });
  const extraIn = el('input', {
    class: 'nt-in', placeholder: '--bwlimit=8M --partial', spellcheck: 'false',
    onInput: (e) => { state0.extra = e.target.value; paint(); },
  });

  for (const i of [srcIn, dstIn]) i.addEventListener('input', paint);

  let runId = null;
  let lastWasDry = true;

  const setFoot = (...kids) => { clear(foot); foot.append(...kids.filter(Boolean)); };

  const start = async (real) => {
    dryRun = !real;
    paint();
    const id = uid('rsync');
    runId = id;
    lastWasDry = !real;
    out.textContent = '';
    setFoot(el('span', { class: 'rs-run', text: real ? 'Copying…' : 'Dry run…' }),
      el('button', {
        class: 'ghost-btn sm', text: 'Stop',
        onClick: () => window.api.rsync.cancel(id),
      }));

    listeners.set(id, {
      out: (m) => {
        out.append(document.createTextNode(m.text));
        out.scrollTop = out.scrollHeight;
      },
      done: (m) => {
        listeners.delete(id);
        runId = null;
        const ok = m.code === 0;
        out.append(document.createTextNode('\n' + (m.error || m.message) + '\n'));
        out.scrollTop = out.scrollHeight;
        setFoot(
          el('span', { class: 'rs-run' + (ok ? ' ok' : ' bad'), text: m.error || m.message }),
          ok && lastWasDry
            ? el('button', {
                class: 'primary-btn sm', text: 'Run it for real',
                title: 'Everything above, without -n',
                onClick: () => start(true),
              })
            : null,
          el('button', { class: 'ghost-btn sm', text: lastWasDry ? 'Dry run again' : 'Run again', onClick: () => start(!lastWasDry) }));
        if (ok && !lastWasDry) {
          status('rsync finished');
          for (const e of [here.explorer, there.explorer]) e?.refresh?.();
        }
      },
    });

    try {
      await window.api.rsync.run(id, argsNow());
    } catch (e) {
      listeners.delete(id);
      runId = null;
      setFoot(el('span', { class: 'rs-run bad', text: e.message }));
    }
  };

  paint();

  await modal({
    title: 'Synchronise with rsync',
    subtitle: check.version,
    width: 'min(760px, 96vw)',
    render: (body) => {
      body.append(
        el('div', { class: 'rs-head' }, swap,
          el('span', { class: 'hint', text: 'Opens on a dry run: nothing moves until you say so.' })),
        row('Source', srcIn, () => sides()[0]),
        row('Destination', dstIn, () => sides()[1]),
        el('div', { class: 'rs-boxes' }, ...boxes),
        el('div', { class: 'rs-row' },
          el('div', { class: 'rs-lab' }, el('strong', { text: 'Exclude' })),
          el('div', { class: 'rs-field' }, exIn)),
        el('div', { class: 'rs-row' },
          el('div', { class: 'rs-lab' }, el('strong', { text: 'Extra flags' })),
          el('div', { class: 'rs-field' }, extraIn)),
        cmdLine,
        out,
        foot);
      setFoot(el('span', { class: 'hint', text: 'Ready.' }));
    },
    buttons: [
      { label: 'Close', value: null },
      { label: 'Dry run', onClick: () => start(false) },
      { label: 'Copy the command', onClick: () => {
        window.api.clipboard.write(commandLine(argsNow()));
        status('Command copied');
      } },
    ],
  });

  // Closing the dialog stops the run: an rsync nobody is watching, with no
  // way left to stop it, is not something to leave behind.
  if (runId) {
    window.api.rsync.cancel(runId);
    listeners.delete(runId);
  }
}
