import { state } from './state.js';
import { el, $ } from './util.js';
import { modal } from './ui.js';

/**
 * The guided tour.
 *
 * A first run of this app shows an empty terminal area and a list of hosts,
 * which says nothing about the things that make it worth using: that a session
 * is one authentication for every panel, that the file browser is attached to
 * the terminal beside it, that a command can be sent to forty machines at once.
 * Those are discoverable only by clicking everything.
 *
 * So the tour points at the real interface rather than describing it in a
 * document. Each step spotlights the actual element and says what it does and
 * how to use it; the app underneath is untouched, so nothing has to be undone
 * afterwards and the tour can be left at any point.
 *
 * It is offered once, on a first run, and lives in Help afterwards.
 */

/*
 * Bumped when the tour gains steps worth showing to someone who has already
 * seen it. Stored rather than a boolean so that "seen" can mean "seen this
 * much" — a returning user is not re-toured for a typo fix.
 */
export const TOUR_VERSION = 6;

/**
 * The script.
 *
 * `target` is a selector resolved when the step is shown; a step whose target
 * is missing or hidden still runs, centred and without a spotlight, because
 * the interface legitimately differs — no Teleport profile, a collapsed
 * sidebar, a platform without multiplexing.
 */
const STEPS = [
  {
    title: 'ServerLife in one minute',
    body: 'Teleport nodes, plain SSH hosts and Kubernetes clusters, treated as the '
      + 'same thing: tabbed terminals, a real file browser, fleet-wide commands, '
      + 'port forwarding, and a full Kubernetes browser with Helm and a 3D cluster '
      + 'view, in one window.\n\nThis tour points at each part and says what it is '
      + 'for. Nothing you see here changes anything — leave whenever you like.',
  },
  {
    title: 'Search everything',
    target: '#global-search',
    body: 'The box at the top right finds anything in ServerLife by name: hosts (by '
      + 'name, address, label or uuid), saved profiles, clusters, beams, open tabs, macros, '
      + 'snippets, layouts, past multi-exec runs, saved AI prompts and responses, every '
      + 'menu action — and settings, which opens Settings at the one you meant.\n\n'
      + '⌘P puts you in it from anywhere. Type, Enter for the first result, the arrows '
      + 'for the rest, Escape to go back to your session.',
  },
  {
    title: 'Every host in one list',
    target: '#sidebar',
    body: 'Teleport nodes from every cluster you are logged in to, grouped by cluster '
      + 'with their labels, and every Host in ~/.ssh/config below them. Nothing has to '
      + 'be registered with the app first.\n\nDouble-click a host to open a session. '
      + 'Right-click for the rest: open as another user, files only, beside the current '
      + 'pane, port forward, run one command.\n\nThe star on a row keeps that host in a '
      + 'Starred group at the top, and the \u27F3 on a cluster heading re-reads just that '
      + 'cluster instead of the whole inventory. More than one ssh_config file can be '
      + 'read — each gets its own group, in Settings.',
  },
  {
    title: 'What a host remembers about itself',
    target: '#sidebar',
    body: 'Two things are worth setting per host, both on its right-click menu.\n\n'
      + '"Preferred username" pins the account it always connects as — kept against a '
      + 'Teleport node\u2019s uuid, so renaming the machine does not lose it.\n\n'
      + '"Agent forwarding" decides whether your keys are reachable from that host: on, '
      + 'off, or follow the cluster, which itself can follow the global setting. What a '
      + 'jump host needs and a shared box should not have.',
  },
  {
    title: 'Leaf clusters and beams',
    target: '#sidebar',
    body: 'A root cluster that trusts others shows a leaf badge on its heading; clicking '
      + 'it switches between the root and any leaf, with labels, and a search box once '
      + 'there are more than ten.\n\nBeams \u2014 ephemeral sandbox VMs \u2014 are listed '
      + 'inside their cluster under their own heading, with a region and a countdown to '
      + 'expiry. Everything the app does to a server it does to a beam: a terminal, the '
      + 'file browser, synchronise, drag and drop. Publishing a service takes the place '
      + 'of port forwards, which a beam does not have.',
  },
  {
    title: 'Find a host by name or label',
    target: '#host-filter',
    body: 'Text matches anywhere. Labels are searchable too: env=prod for an exact '
      + 'value, env:pro for a partial one, env=a,b for either, -env=dev to exclude, '
      + 'env=pre* as a glob. Terms combine, so "web env=prod" means both.\n\n'
      + 'There is more when you need it: and, or, not and brackets, and ~ for a '
      + 'regular expression — name~^(web|api)-\\d+$. The same language writes a '
      + 'folder’s rule and picks multi-exec targets.',
  },
  {
    title: 'Folders, and a pane for the fleet',
    target: '#btn-folders',
    body: 'A cluster’s list is whatever tsh ls returns, in whatever order. Folders '
      + 'are the other way round: make one on a cluster heading, drag hosts in, and '
      + 'they stay — kept by the node’s uuid, so a rename cannot empty a folder. '
      + 'A filed host is listed inside its folder and nowhere else.\n\nA folder can '
      + 'also fill itself from a rule — env=prod and (role:web or role:api) and not '
      + 'name~canary — re-asked every time the inventory changes. Folders nest, take '
      + 'an emoji and a colour, and the whole arrangement exports to a file a colleague '
      + 'can import.\n\nThe Folders button opens the big view. A cluster heading will '
      + 'also open its hosts in a pane of the window, with folders on or off and rows '
      + 'or tiles — which is where a list of three hundred nodes belongs. The '
      + 'sidebar itself stops at twenty per group and offers that pane for the rest.',
  },
  {
    title: 'Starting a session',
    target: '#tab-add',
    body: '⌘N opens the picker — recent connections first, then every host, '
      + 'searchable, Enter to connect.\n\n⌘⌥C is Quick connect, for a server that is '
      + 'in no list yet: type ubuntu@10.0.0.5, or paste a whole ssh command line. It '
      + 'can test the connection or run a single command without opening a terminal, '
      + 'and saves nothing unless you ask it to.',
  },
  {
    title: 'One authentication per host',
    // The title bar rather than #tabstrip: the strip is empty and therefore
    // zero-width until a session exists, which is exactly the first-run case.
    target: '#titlebar',
    body: 'Opening a session creates a single SSH ControlMaster. Every terminal, file '
      + 'operation, tunnel and remote command after that rides the same connection — so '
      + 'you tap your MFA key once, not once per panel, and ten terminals to one host is '
      + 'one Teleport session.\n\nSessions are tabs. ⌘1–⌘9 jump between them, ⌘D '
      + 'duplicates one, ⌘W closes a pane.\n\nEach tab says what its session is '
      + 'doing, not just what it is connected to: three bars ripple while output is '
      + 'arriving, and an amber ? appears when something in there is waiting to be '
      + 'answered — a password, a yes/no, or a coding agent asking permission.',
  },
  {
    title: 'Two servers side by side',
    target: '#panes',
    body: 'Any tab splits into panes. ⌘⇧D and ⌘⇧E split with the same host; ⌘⌥D and '
      + '⌘⌥E split with a different one, so two servers sit next to each other.\n\n'
      + '⌘⇧B turns on broadcast typing: what you type goes to every pane in the tab at '
      + 'once — the "same command on four servers" trick, without scripting it.',
  },
  {
    title: 'The file browser is part of the session',
    target: '#titlebar-actions [data-action="toggle-files"]',
    body: 'It appears the moment a session connects, because it is riding the '
      + 'connection that is already open — no second authentication, no separate SFTP '
      + 'app.\n\n⌘E shows and hides it. Drag files in from Finder to upload, drag them '
      + 'out to download, or press the 💻 button in the explorer to put your local '
      + 'files underneath and drag between the two. ⌕ filters by name, and the arrow '
      + 'keys walk the matches.\n\nThe \u2261 button adds permissions and owner beside '
      + 'size and date, and "Get info" explains what a mode actually grants. \u21C4 '
      + 'compares two folders; \u21C6 synchronises them, showing every action with a tick '
      + 'beside it before anything moves. "Edit in my editor" opens a remote file in '
      + 'whatever you actually edit in and uploads every save.',
  },
  {
    title: 'Words worth seeing',
    target: '#panes',
    body: 'Beside each pane\u2019s search box is a highlighting toggle. Switch it on and '
      + 'errors, warnings and good news are coloured in the output as it arrives, so '
      + '"error" is visible without searching for it. It is off until you ask for it, '
      + 'here or in Settings.\n\nRight-click that button to add your own words, or '
      + 'to set it per host \u2014 a mail relay\u2019s "deferred" is routine, a build '
      + 'box\u2019s is not. It stands aside while vim, less or htop is drawing its own '
      + 'screen.',
  },
  {
    title: 'One command, every host',
    target: '#titlebar-actions [data-action="toggle-multiexec"]',
    body: 'Tick hosts in the sidebar, then ⌘⇧M and type a command. It runs on all of '
      + 'them in parallel, with each result in its own collapsible card — exit code, '
      + 'duration, stdout and stderr.\n\nUseful for the questions that are not worth a '
      + 'session each: which of these is out of disk, which kernel is everyone on.\n\n'
      + 'Advanced has a staged rollout and retries for a host that fails. Schedule… '
      + 'runs it later, or every so often — the Scheduled tab keeps the list.',
  },
  {
    title: 'An AI assistant beside your sessions',
    target: '#titlebar-actions [data-action="toggle-ai"]',
    body: '✦ opens Claude Code, Codex, GitHub Copilot CLI, Gemini CLI, OpenCode or Pi '
      + 'in a panel on the right — the vendor’s own tool, signed in the way it '
      + 'always is, and given ServerLife’s tools so it can list your hosts, open '
      + 'sessions and read what a terminal shows.\n\nRight-click selected output, or a '
      + 'host, and "Ask the AI about this" puts it into the assistant with where it came '
      + 'from, for you to add the question. Prompts keeps the questions you ask often; '
      + 'Save keeps an answer worth having, as a file you can find again here or in '
      + 'Finder. "Pick up a past conversation" carries on where one left off, a tab can '
      + 'be named by double-clicking it, and a tab turns yellow when its assistant is '
      + 'waiting on you.\n\nDouble-click the AI row in the host list to start one with a '
      + 'question already typed.',
  },
  {
    title: 'Transfers, tunnels and the log',
    target: '#titlebar-actions [data-action="toggle-transfers"]',
    body: '⌘J opens the dock. Transfers shows progress and rate for every upload and '
      + 'download, including server-to-server ones. Tunnels lists your port forwards '
      + '— local, remote and SOCKS — and the connection log is every line the ssh or '
      + 'tsh process printed, which is where to look when something refuses you.\n\n'
      + 'A tunnel worth having again can be starred into Favourites, which reopens it '
      + '(dialling the host first if needed). Downloads answers "where did that file '
      + 'go", and Watch lists the folders being kept up to date.',
  },
  {
    title: 'Teleport',
    target: '.sb-tab[data-tab="teleport"]',
    body: 'Clusters you are logged in to, with their proxies and your roles; log in '
      + 'and out per cluster; request access and assume approved requests; monitor '
      + 'whether the resources you expect to be able to request are still offered; and play '
      + 'back recorded sessions, or search their transcripts for a word across a date '
      + 'range.\n\nPer-session-MFA nodes are handled too — those open over tsh, since a '
      + 'shared connection cannot satisfy an MFA challenge per session.\n\nRecordings '
      + 'list the interactive ones by default \u2014 the rest have nothing to replay \u2014 '
      + 'a session id pasted into the filter is recognised even when it is outside the '
      + 'dates loaded, and the \u2606 keeps one with a note. "Add to ssh config" writes '
      + 'a cluster\u2019s tsh config block into ~/.ssh/config, so scp, rsync and Ansible '
      + 'reach its nodes too. A node\u2019s menu will also measure latency to it, both '
      + 'halves of the path.',
  },
  {
    title: 'Kubernetes clusters, the same way',
    target: '#sb-kind-filter',
    body: 'K8s here switches the Resources list to just Kubernetes clusters — reached '
      + 'through Teleport’s own kube proxy or a plain kubeconfig, listed beside your '
      + 'SSH hosts rather than off in a tab of their own.\n\n'
      + 'Click a cluster to expand its namespaces, then a namespace for its pods. '
      + 'Click a pod to exec straight in beside the pane you’re already looking at '
      + '(double-click for a tab of its own); right-click for logs (including a '
      + 'crashed container’s own previous logs), YAML, delete, and port-forwarding.\n\n'
      + 'Any port-forwards running on that cluster show the moment it’s expanded — no '
      + 'need to open anything else just to see what’s live, or to stop it.\n\n'
      + 'All of KubeLife is one setting to turn off entirely — Settings → '
      + 'KubeLife — for anyone who only needs SSH.',
  },
  {
    title: 'The full cluster browser',
    body: 'The ⤢ button on a cluster row (or its right-click menu) opens every resource '
      + 'kind that cluster actually has — kubectl api-resources is asked, not a fixed '
      + 'list, so a CRD installed yesterday needs no app update to browse today.\n\n'
      + 'Overview leads with node/namespace counts, pods by phase, and kubectl top’s '
      + 'own numbers — not a blank list waiting to be told what to show. Every list '
      + 'sorts (click a header) and resizes (drag its edge, remembered after); a '
      + 'Namespace row’s name is a link that scopes everything above it and jumps to '
      + 'that namespace’s Pods.\n\n'
      + '"My access" answers "what can I actually do here" — who the cluster sees you '
      + 'as, and a can-i grid across what people actually touch. YAML is viewable, '
      + 'editable (the diff is a checkbox, not forced on you) and exportable. "+ New" '
      + 'applies a blank manifest, or builds one from a short form — a namespace, or a '
      + 'disposable test pod (name, namespace, image, optional port) — without having '
      + 'to hand-write YAML for the common case.',
  },
  {
    title: 'Helm releases',
    body: 'A fixed entry in the cluster browser’s own list — Helm releases never show '
      + 'up in kubectl api-resources, so this isn’t left for the regular kind list to '
      + 'happen to discover.\n\n'
      + 'Every release, sortable and resizable like everything else, with Values, '
      + 'History (each revision a Rollback away), Uninstall, and Export. "Install '
      + 'release…" takes a repo chart (the repo gets added for you) or a local chart '
      + 'path, with an optional values file and a dry-run checkbox that defaults on.\n\n'
      + 'Reachable in one click from a cluster’s own right-click menu too — "Manage '
      + 'Helm releases…" opens the browser straight on this list.',
  },
  {
    title: 'Port-forwarding, and knowing it’s running',
    body: 'Right-click a Pod, Service, Deployment, StatefulSet or DaemonSet — in the '
      + 'sidebar, the full browser’s rows, or the 3D view’s own Service popup — for '
      + '"Port-forward…": a remote port and an optional local one, blank for kubectl '
      + 'to pick an open one itself.\n\n'
      + 'Once it’s running, it’s visible wherever you’d look for it, not just wherever '
      + 'you started it: a badge on the cluster row in the sidebar (even collapsed), '
      + 'the inline list once it’s expanded, and a count button in the full browser’s '
      + 'own toolbar — all three with Stop right there. Stopping one always asks for '
      + 'confirmation first: it’s live traffic something may depend on mid-click, not '
      + 'a free action to undo.',
  },
  {
    title: 'The 3D view',
    body: 'A cluster, as a city: namespaces are districts, pods are buildings that '
      + 'breathe while running — faster and a touch bigger the busier kubectl top says '
      + 'they are — and flash red when crashing. Deployments are pillars coloured by '
      + 'their own ready/desired ratio; Services are fixed-colour beacons.\n\n'
      + 'Opened from "🧊 3D view" in the cluster browser’s own list (or a cluster’s '
      + 'right-click menu) — never a popup, which is also why the controls actually '
      + 'work here: drag to rotate/pan, scroll or +/- to zoom, and the arrow keys '
      + 'rotate/tilt the moment it opens, no click needed first.\n\n'
      + 'A search box finds a specific pod or service by name; a kind filter narrows '
      + 'to just one; a building-style picker changes the look, never what colour or '
      + 'height mean. The namespace selector above scopes it the same as everything '
      + 'else in the browser.',
  },
  {
    title: 'When a node goes quiet, or goes away',
    target: '#btn-heartbeats',
    body: 'A Teleport node stays in the inventory for ten or fifteen minutes after its '
      + 'agent stops heartbeating — same row, same labels, still offering a session '
      + 'that will hang on a tunnel with nobody on the far end. Past a couple of '
      + 'minutes of silence its row says ⚠ and how long it has been quiet. '
      + 'Heartbeats puts the figure on every row.\n\nThe button beside it gathers '
      + 'them: all nodes, the quiet ones hidden, or only the quiet ones — which is '
      + 'the list to have open when something has taken a rack with it.\n\nAnd for a '
      + 'machine you would want to hear about: right-click → "Tell me if this host '
      + 'disappears". Its node id and last known details are kept, so when it stops '
      + 'being listed at all the row stays, struck through, with how long it has been '
      + 'gone — instead of the host quietly ceasing to exist.',
  },
  {
    title: 'Your keys, and what the agent holds',
    target: '.sb-item[data-tour="keys"]',
    body: 'Every keypair in ~/.ssh with its fingerprint, type, whether it has a '
      + 'passphrase, and which ssh_config hosts use it — plus what ssh-agent is '
      + 'currently holding.\n\nGenerate a key, add one to the agent, or install a '
      + 'public key on a server you are already connected to, which is ssh-copy-id '
      + 'without the second authentication.',
  },
  {
    title: 'When a host will not answer',
    target: '.sb-item[data-tour="nettools"]',
    body: 'Ping, traceroute, DNS, port checks, TLS certificates and HTTP probes, in '
      + 'the same window as the session that is failing (⌘⇧T). Answers "is it me, the '
      + 'network, or the server" without leaving for a terminal.\n\nThere is a full curl '
      + 'in there as well \u2014 method, headers, body, bearer or basic auth \u2014 with '
      + 'the command shown as it will run, the response formatted, and the call keepable '
      + 'to run again. Examples fills in the typical shapes for every tool, Recent '
      + 'reruns what you just did, and any output can be saved to a file.\n\nIt also '
      + 'works out subnets and takes apart an SSH certificate, a JWT or a SPIFFE SVID \u2014 '
      + 'right-click a selection in a terminal \u2192 Decode.',
  },
  {
    title: 'Where the rest lives',
    body: 'Macros and snippets keep commands you retype. Every session\u2019s \u25B6 '
      + 'button runs one on that host, and the last entries in that menu write a new one '
      + 'or record one: run the commands as usual, stop, and what you ran is the macro. '
      + 'A macro can be pinned as a button in the session header \u2014 with an icon, and '
      + 'a choice of every session, hosts only, or the local shell only.\n\nLayouts save '
      + 'an arrangement of sessions and bring it back (⌘⇧S, ⌘⇧O), and the last one is '
      + 'offered on launch. S3 buckets can be browsed and copied to and from servers '
      + 'directly. An agent can drive the app through the bundled MCP server \u2014 open '
      + 'sessions, run a macro you wrote, preview and apply a folder synchronisation '
      + '\u2014 and it is off until you turn it on.\n\nSettings (⌘,) has the theme, font, '
      + 'accent, keyword highlighting, agent forwarding, the extra ssh_config files, and '
      + 'the hidden-files and follow-the-terminal toggles. Every shortcut is in the '
      + 'menus, and the README has the full list.\n\nThis tour is in Help whenever you '
      + 'want it again.',
  },
];

/* ------------------------------------------------------------------ */

let active = null;

/** Is the element there and actually on screen? */
function usable(node) {
  if (!node) return false;
  const r = node.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return false;
  const style = getComputedStyle(node);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

export function tourRunning() { return !!active; }

/** Start the tour. Safe to call twice; the second call is ignored. */
export function startTour() {
  if (active) return;

  let i = 0;
  const ring = el('div', { class: 'tour-ring' });
  const card = el('div', { class: 'tour-card' });
  const root = el('div', { class: 'tour-root' }, ring, card);

  const end = () => {
    if (!active) return;
    active = null;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    root.remove();
    markSeen();
  };

  const go = (n) => {
    i = Math.max(0, Math.min(STEPS.length - 1, n));
    draw();
  };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); }
    else if (e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      if (i === STEPS.length - 1) end(); else go(i + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault(); e.stopPropagation();
      go(i - 1);
    }
  };

  /** Position the spotlight and the card for the current step. */
  function place() {
    const step = STEPS[i];
    const node = step.target ? $(step.target) : null;
    const target = usable(node) ? node : null;

    if (!target) {
      // No anchor: centre the card and darken the whole window.
      ring.classList.add('hidden');
      root.classList.add('centred');
      card.style.left = card.style.top = '';
      return;
    }

    root.classList.remove('centred');
    ring.classList.remove('hidden');
    const r = target.getBoundingClientRect();
    const pad = 4;
    ring.style.left = `${r.left - pad}px`;
    ring.style.top = `${r.top - pad}px`;
    ring.style.width = `${r.width + pad * 2}px`;
    ring.style.height = `${r.height + pad * 2}px`;

    // Place the card on whichever side has room, preferring below/right.
    const cr = card.getBoundingClientRect();
    const gap = 14;
    let left = r.left;
    let top = r.bottom + gap;
    if (top + cr.height > window.innerHeight - 8) {
      top = r.top - cr.height - gap;                 // above instead
      if (top < 8) top = Math.min(r.bottom + gap, window.innerHeight - cr.height - 8);
    }
    if (left + cr.width > window.innerWidth - 8) left = window.innerWidth - cr.width - 8;
    // A wide target (the whole sidebar) reads better with the card beside it.
    if (r.width > window.innerWidth * 0.5 && r.height > window.innerHeight * 0.5) {
      left = Math.min(r.right + gap, window.innerWidth - cr.width - 8);
      top = Math.max(8, Math.min(r.top, window.innerHeight - cr.height - 8));
    }
    card.style.left = `${Math.max(8, left)}px`;
    card.style.top = `${Math.max(8, top)}px`;
  }

  function draw() {
    const step = STEPS[i];
    const last = i === STEPS.length - 1;
    card.replaceChildren(
      el('div', { class: 'tour-step', text: `${i + 1} of ${STEPS.length}` }),
      el('h3', { text: step.title }),
      // Paragraphs rather than one block: these are two or three distinct
      // points each and run together otherwise.
      ...step.body.split('\n\n').map((p) => el('p', { text: p })),
      el('div', { class: 'tour-dots' },
        ...STEPS.map((_, n) => el('button', {
          class: 'tour-dot' + (n === i ? ' on' : ''),
          title: STEPS[n].title,
          onClick: () => go(n),
        }))),
      el('div', { class: 'tour-actions' },
        el('button', { class: 'ghost-btn sm', text: 'Skip tour', onClick: end }),
        el('div', { style: 'flex:1' }),
        i > 0 ? el('button', { class: 'ghost-btn sm', text: 'Back', onClick: () => go(i - 1) }) : null,
        el('button', {
          class: 'primary-btn sm',
          text: last ? 'Done' : 'Next',
          onClick: () => (last ? end() : go(i + 1)),
        })));
    place();
    // The card's height is only known once it is laid out, and the placement
    // depends on it, so position twice rather than guess.
    requestAnimationFrame(place);
  }

  active = { end };
  $('#modal-root').append(root);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  draw();
}

async function markSeen() {
  if (state.settings?.tourSeenVersion === TOUR_VERSION) return;
  try {
    state.settings = await window.api.settings.set({ tourSeenVersion: TOUR_VERSION });
  } catch { /* the tour having run is not worth an error message */ }
}

/**
 * Offer the tour on a first run.
 *
 * An offer rather than an automatic start: someone who has used this kind of
 * app before should not have to dismiss thirteen steps, and someone who says no
 * is not asked again. Either answer counts as seen.
 */
export async function offerTourOnFirstRun() {
  if (state.settings?.tourSeenVersion === TOUR_VERSION) return;
  /*
   * Not now, but not "seen" either: someone who arrives with sessions already
   * restored, or in a second window, should not be interrupted — and should
   * still be offered the tour the next time they start clean. Marking it seen
   * here would spend the one-time offer on a launch that never showed it.
   */
  if (state.tabs.length || (state.windowInfo?.count || 1) > 1) return;

  const yes = await modal({
    title: 'First time here?',
    render: (body) => {
      body.append(
        el('div', { style: 'font-size:13px;margin-bottom:8px',
          text: 'ServerLife puts terminals, a file browser, fleet-wide commands and '
            + 'port forwarding for Teleport and SSH hosts — and a full Kubernetes '
            + 'browser alongside them — in one window.' }),
        el('div', { style: 'font-size:12px;color:var(--text-dim)',
          text: 'A short tour points at each part and says what it is for — about a '
            + 'minute, and you can leave at any point. It stays in the Help menu '
            + 'either way.' }));
    },
    buttons: [
      { label: 'Not now', value: false },
      { label: 'Take the tour', class: 'primary-btn', value: true },
    ],
  });
  // Only an explicit answer settles it. Escape or a click on the backdrop
  // resolves undefined, which is a dismissal rather than a decision — ask again
  // next launch rather than silently spending the offer.
  if (yes === true) startTour();
  else if (yes === false) markSeen();
}
