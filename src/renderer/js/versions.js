import { el } from './util.js';
import { modal } from './ui.js';
import { parseChangelog } from './changelog.js';
import CHANGELOG from '../../../CHANGELOG.md';

/**
 * Version history, shown in-app from the About box.
 *
 * Read from CHANGELOG.md, bundled as text at build time (see changelog.js),
 * so every release the changelog records is here without a second copy to
 * keep. The early releases below were written out by hand with a title each;
 * their titles are kept, and their entries stand in for the changelog's only
 * where the changelog has none.
 */
const CURATED = [
  {
    version: '0.1.16',
    date: '2026-09-15',
    title: 'Prefixed release tags',
    summary: 'Releases are tagged serverlife-v<version>, and the release workflow checks the tag against package.json.',
    sections: [
      {
        name: 'Changed',
        items: [
          'Releases are tagged serverlife-v<version>, so a tag says what it is releasing.',
          'The release workflow refuses a tag that disagrees with package.json, which would otherwise name every asset after a different version.',
        ],
      },
      {
        name: 'Fixed',
        items: [
          'The macOS install helper printed an empty signature line for certificate-signed builds; it now names the signing authority.',
        ],
      },
    ],
  },
  {
    version: '0.1.15',
    date: '2026-09-15',
    title: 'Driven by an agent',
    summary: 'A bundled MCP server lets Claude Code and friends open a set of sessions, manage layouts and read cluster state \u2014 without ever being handed a shell. Plus the Windows download fix and install instructions that match what macOS actually does.',
    sections: [
      {
        name: 'Automation',
        items: [
          'Settings \u2192 Local automation (MCP) turns on a local socket, and the bundled MCP server gives an agent 13 tools: list hosts, open a set of sessions in one call, close them, save and load layouts, read Teleport clusters, get a tsh login line, run your saved macros.',
          'Off until you turn it on. Socket in your own runtime directory at mode 0600, token-authenticated, and every accepted call shows in the status bar.',
          'No verb runs a command of the caller\u2019s choosing \u2014 run_macro runs a macro you wrote and can read, and nothing types into a session or moves files.',
        ],
      },
      {
        name: 'Fixed',
        items: [
          'Downloading a file into the root of a Windows drive failed: the parent of C:\\file.txt is C:\\, and creating a drive root raises EPERM even when asked not to complain. Local directory creation now knows which paths cannot be created.',
        ],
      },
      {
        name: 'Documentation',
        items: [
          'The macOS install steps recommended Control-click \u2192 Open, which Apple removed in macOS 15. Install now describes the real dialog, both routes that work, and how to recover if the app has been trashed.',
          'tools/install-mac.sh installs a DMG in one command and ships as a release asset. UNINSTALL.md covers removing everything the app wrote; MCP.md documents the automation interface.',
        ],
      },
    ],
  },
  {
    version: '0.1.14',
    date: '2026-09-15',
    title: 'No ssh? Use tsh',
    summary: 'Where there is no OpenSSH client \u2014 a normal state on Windows \u2014 Teleport nodes open over tsh ssh instead of failing. Plus per-cluster logout, and clusters you can save to log back into.',
    sections: [
      {
        name: 'Sessions',
        items: [
          'With no ssh client, a Teleport node opens over tsh ssh: tsh dials it, carries its own MFA and serves the file browser through the same channel. Multi-exec follows the same route.',
          'A plain ssh_config host explains that it needs OpenSSH rather than dying on a spawn error \u2014 with the Windows optional-feature instructions.',
          'ssh is looked for in System32\\OpenSSH, Program Files, Git for Windows and wherever `where ssh` points, and its directory is put on the environment of anything spawned.',
        ],
      },
      {
        name: 'Teleport',
        items: [
          'Log out of one cluster \u2014 tsh logout --proxy=\u2026 \u2014 from its profile row or from the cluster\u2019s right-click menu, leaving every other profile alone.',
          'Save a cluster for logging back into. Logging out takes the proxy address with it, so a saved record (proxy, cluster, user, connector, tsh home) is what makes the next login a click. Offered on the login and logout dialogs, listed under Saved clusters.',
        ],
      },
      {
        name: 'Fixed',
        items: [
          'A stray \u201Cnull\u201D above Additional flags in the tsh login dialog when no tsh homes were configured.',
          'Every ssh_config host vanished on a machine without ssh, since the aliases are resolved with `ssh -G`. The config file is now read directly instead, wildcard Host blocks included.',
          'Correcting the tsh or ssh path takes effect on the next refresh rather than needing a restart.',
        ],
      },
    ],
  },
  {
    version: '0.1.13',
    date: '2026-09-15',
    title: 'Teleport on Windows',
    summary: 'Windows never found tsh, so no cluster was ever listed \u2014 every path searched was a macOS one. Plus releases that cannot be blocked by the artifact quota.',
    sections: [
      {
        name: 'Fixed',
        items: [
          'Windows now finds tsh where the installers actually put it: Teleport Connect\u2019s resources directory, Program Files, chocolatey, scoop, or wherever `where tsh` says. Nothing could be listed before, because nothing could be run \u2014 which also meant C:\\Users\\<you>\\.tsh was never read.',
          'The PATH given to tsh is built with the platform\u2019s own separator, instead of appending POSIX directories onto a Windows PATH and corrupting its last entry.',
          'A missing tsh says so, in red, instead of claiming you are not logged in.',
        ],
      },
      {
        name: 'Teleport',
        items: [
          'Locate tsh\u2026 \u2014 point the app at the binary yourself, with a file picker and a list of everywhere it looked.',
        ],
      },
      {
        name: 'Build',
        items: [
          'Each platform uploads its builds straight to the release rather than parking a second copy as an Actions artifact. 0.1.12 built on all four platforms and shipped nothing when that quota filled; this path cannot be blocked the same way.',
        ],
      },
    ],
  },
  {
    version: '0.1.12',
    date: '2026-09-15',
    title: 'More than one tsh home',
    summary: 'Teleport clusters can be read from several tsh profile directories at once, and every command runs in the one its cluster came from. Plus a copy button for the tsh login itself.',
    sections: [
      {
        name: 'Teleport',
        items: [
          'Settings \u2192 Teleport homes takes a list of TELEPORT_HOME directories. Every one is read for clusters, each profile remembers where it came from, and order is precedence when two homes offer the same proxy.',
          'Every tsh command runs with its own home \u2014 inventory, requests, recordings, scp, proxy aws, play \u2014 and so do the plain ssh processes, which reach a Teleport node through tsh proxy ssh.',
          'The same cluster in two homes is two groups in the sidebar, each badged with its home. Nodes from a non-default home carry it in their id, so your hidden hosts, remembered logins and MFA list are untouched.',
          'Copy login cmd, on each profile row, on an expired cluster and in the login dialog: the exact tsh login to paste into a terminal, with TELEPORT_HOME where it matters \u2014 for the logins that only complete in a real terminal.',
          'The login dialog asks which home to log into when there is more than one.',
        ],
      },
    ],
  },
  {
    version: '0.1.11',
    date: '2026-09-14',
    title: 'A memory, and a bit of flair',
    summary: 'New session opens with the places you have been, panes can be moved around, folders can be asked what they hold, macros can run on a timer — and something crosses the wire while a session dials.',
    sections: [
      {
        name: 'Sessions',
        items: [
          'New session lists your recent connections at the top \u2014 newest first, one per destination, with the login you used and how long ago. Built from the session history, so the memory is already there. Keep 5, 10, 20 or 50 of them, or none.',
          'Thirty little scenes rotate while a session dials: robots, pneumatic tubes, a carrier pigeon, a satellite relay, snail mail, a hamster-powered link. Pin one or turn them off in Settings.',
          'Panes can be moved inside a tab \u2014 right-click \u2192 Move this pane, or \u2318\u21E7 with an arrow. At the edge it becomes the whole edge, turning a stack into a side-by-side.',
          'Open files only now offers a new tab, a split right or a split down, so a file browser can sit beside the shell you are in.',
        ],
      },
      {
        name: 'Sidebar',
        items: [
          'Drag a group heading to rearrange the sidebar \u2014 Local, SSH config and each Teleport cluster \u2014 or use the heading\u2019s right-click menu. A cluster you log into later falls in behind what you arranged.',
        ],
      },
      {
        name: 'Files',
        items: [
          'Get info on a folder: type, permissions, owner, timestamps and what is inside. The recursive total is a button, not a surprise \u2014 du on a server, a walk here, a prefix count in a bucket.',
        ],
      },
      {
        name: 'Macros',
        items: [
          'A macro can repeat every so many seconds or minutes, retyping itself into the session until stopped. Only commands that finish qualify; the run button glows while one is ticking, and closing the pane stops it.',
          'tsh status is now a built-in macro \u2014 cluster, user, roles and certificate life.',
        ],
      },
      {
        name: 'Fixed',
        items: [
          'Dropping a file into a bucket did nothing: a bucket\u2019s root prefix is the empty string, which the drop handler read as \u201cno destination\u201d. Finder drops into a bucket work now too.',
          'Server-to-bucket transfers produced nothing: a queued download was chained into an upload, and a queued transfer returns when the job is registered, not when the bytes land. Server and bucket transfers relay inside the main process now, where the transfer is properly awaited.',
          'Switching a pane to a bucket left the previous directory in the path bar while it loaded, reading as though the bucket contained it.',
        ],
      },
    ],
  },
  {
    version: '0.1.10',
    date: '2026-09-14',
    title: 'Files between everywhere',
    summary: 'Move files between buckets, servers and this machine, and open a local pane beside any of them.',
    sections: [
      {
        name: 'Files',
        items: [
          'Drag between two file panes, or right-click objects \u2192 Copy to another pane\u2026, to move files with a bucket on either side.',
          'Local and a bucket is one hop. A server and a bucket cannot reach each other, so those relay through this machine \u2014 and say so rather than looking direct. Bucket to bucket relays the same way.',
          'The Local shell row now has a right-click menu: open it, split it beside or below the current pane, or show local files inside that pane \u2014 so a bucket and your own disk can be browsed together.',
        ],
      },
    ],
  },
  {
    version: '0.1.9',
    date: '2026-09-14',
    title: 'S3',
    summary: 'Buckets as another place files live, with credentials from Teleport or from the AWS access this machine already has.',
    sections: [
      {
        name: 'S3',
        items: [
          'Register buckets under Saved \u2192 S3; each becomes a source in every file explorer, beside your sessions and the local machine.',
          'Credentials from Teleport (tsh proxy aws \u2014 per-session, audited, nothing stored), an AWS profile in ~/.aws (SSO, assumed roles, credential_process, static keys), environment variables, or a stored key sealed with the OS keychain.',
          'Browse the buckets the credentials can see and pick one; the region is detected, and a bucket in another region corrects itself from the header S3 sends back.',
          'Download, upload, delete, copy a key, and re-tier an object.',
          'Uploads choose a storage class \u2014 Standard through Deep Archive \u2014 defaulting to the bucket\u2019s.',
          'Signature V4 is implemented directly rather than pulling in the AWS SDK, and is checked against AWS\u2019s published test vectors.',
        ],
      },
      {
        name: 'Sessions',
        items: [
          'Open a server as files only, with no terminal \u2014 right-click a host \u2192 Open files only. The same single ControlMaster; the file browser becomes the whole tab.',
        ],
      },
    ],
  },
  {
    version: '0.1.8',
    date: '2026-09-14',
    title: 'Multiple windows',
    summary: 'As many windows as you want, each remembered on its own, plus a file browser that fits its column.',
    sections: [
      {
        name: 'Windows',
        items: [
          'Session \u2192 New Window (\u2318\u2325N), or the button on the start page. Each window has its own tabs, panes, sidebar and file browsers.',
          'Connections are shared, so a host already dialled is not dialled twice.',
          'Every window\u2019s layout is remembered separately, and reopening offers them all back at once \u2014 one answer restores the lot, each into its own window.',
          'A window you closed on purpose does not come back.',
          'Windows are named after what is open in them, so the Window menu lists web-01, db-02 rather than ServerLife three times.',
        ],
      },
      {
        name: 'File browser',
        items: [
          'File names survive much longer before being cut: the name column has a floor, and the size and date give up their space first.',
          'Dates line up. fmtDate pads every value to the same width, but the column collapsed that padding, so nothing aligned.',
          'Sort by name, size or date from the explorer toolbar, with the active key marked and a click to reverse. Each explorer remembers its own.',
        ],
      },
      {
        name: 'Interface',
        items: [
          'The four start-page buttons carry icons.',
        ],
      },
    ],
  },
  {
    version: '0.1.7',
    date: '2026-09-14',
    title: 'Export, import and skins',
    summary: 'Move your whole setup between machines, dress the app up, and a pile of macro polish.',
    sections: [
      {
        name: 'Settings',
        items: [
          'Export all… writes profiles, folders, macros, snippets, saved access requests, layouts and preferences to one JSON file.',
          'Import… reads it back on another machine, shows what the file holds, and asks: merge adds what is new (matched on id, so repeating it changes nothing) or replace makes this machine match the file.',
          'Macros alone can be exported from the Macros tab.',
          'Nothing secret travels: the store holds aliases, key paths and cluster names, never passwords or keys.',
        ],
      },
      {
        name: 'Skins',
        items: [
          'Nine palettes over the top of theme and accent: Party, Halloween, Christmas, Winter, Valentine, Shamrock, Fireworks, Synthwave and Matrix.',
          'Terminals read their colours back out of the CSS tokens, so a skin dresses the terminal too.',
        ],
      },
      {
        name: 'Macros',
        items: [
          'The \u25B6 button is on every pane, local shells included.',
          'Categories are free text, and each heading has arrows to move it, so your own can sit above the built-ins.',
          'A macro can be marked to paste without pressing Enter, for the ones you finish by hand. The default still runs.',
        ],
      },
      {
        name: 'Fixed',
        items: [
          'Hiding a file explorer hid every one of them. \u2318E and the toolbar button now act on the focused pane; the tab-wide and app-wide sweeps are on the button\u2019s right-click menu.',
        ],
      },
    ],
  },
  {
    version: '0.1.6',
    date: '2026-09-14',
    title: 'Macros and network tools',
    summary: 'Commands aimed at a host, with a starter set of sixteen, and a general network diagnostics panel.',
    sections: [
      {
        name: 'Macros',
        items: [
          'Saved → Macros: commands aimed at a host, with a Profiles / Macros selector above the filter box.',
          'Sixteen built in — Teleport service status, follow the agent log, errors in the last hour, version, config, restart; plus disk, memory, processes, ports, errors, logins, network, OS and pending reboot.',
          'Built-ins live in code so they improve between releases; hide the ones you do not want and restore them later.',
          'Double-click sends to the focused terminal; with nothing focused a macro offers to run on a host you pick and shows the output.',
          'Macros that change something ask first. Ones that follow a log never run headless.',
          'Multi-exec has Command and Macros tabs, so a macro can run across every selected host.',
          'Every session pane has a ▶ button that drops down the macro list and runs one on that host (⌘⇧R).',
        ],
      },
      {
        name: 'Network tools',
        items: [
          '⌘⇧T, or the sidebar and start page: one target and nine tools against it.',
          'Ping, traceroute, DNS, port check, TLS certificate, HTTP, whois, Teleport cluster and this machine.',
          'The port check is one host with a 32-port ceiling — a reachability check, not a scanner.',
          'TLS reports what a server presents even when the chain does not validate; HTTP shows status, timing, redirects and headers.',
          'Teleport cluster reads a proxy’s /webapi/ping — version, edition, auth connector and listeners — and needs no login.',
          'Nothing runs through a shell: external commands get an argument array and every target is validated first.',
        ],
      },
    ],
  },
  {
    version: '0.1.4',
    date: '2026-09-13',
    title: 'Request timing and reviewers',
    summary: 'Say when access starts and how long it lasts, suggest reviewers, and copy a request into a new one. Carries 0.1.3, which was tagged but never published.',
    sections: [
      {
        name: 'Access requests',
        items: [
          'Timing: takes effect, request expires, access lasts, session expires — instead of silently taking the cluster defaults.',
          'The start time defaults to now and is only sent once moved into the future, since immediate is Teleport’s own default.',
          'Suggested reviewers, optional and comma separated.',
          'The exact tsh command is shown back, folded away behind a disclosure, with Copy that works without expanding.',
          'Copy to new request prefills the form from an existing one, turning its absolute timings back into durations.',
        ],
      },
      {
        name: 'Fixed',
        items: [
          'A request’s expiry never displayed: it was read from metadata.expires, which Teleport does not set. All four timings live on the spec.',
        ],
      },
    ],
  },
  {
    version: '0.1.3',
    date: '2026-09-13',
    title: 'Reusable access requests',
    summary: 'Copy a request you already made into a saved one, ready to raise again.',
    sections: [
      {
        name: 'Access requests',
        items: [
          'Save as reusable… on any request — pending, approved or expired — keeps its resources, roles and reason under a name you choose.',
          'The name defaults to the original reason.',
          'Resources are stored under the names they resolved to, so the entry is still readable a month later, though it is the id that gets raised.',
        ],
      },
    ],
  },
  {
    version: '0.1.2',
    date: '2026-09-13',
    title: 'Access requests by name',
    summary: 'Browse what can be requested, see resources by name rather than UUID, and save a request to raise again.',
    sections: [
      {
        name: 'Access requests',
        items: [
          'Browse… lists everything tsh request search reports — servers, apps, databases, Kubernetes, desktops — by name and label, filterable as you type.',
          'That is a different set from the sidebar on purpose: a request is for a resource you cannot see yet.',
          'Requests show node/web-3 instead of node/d68f45ed-…, with the raw id in the tooltip.',
          'Requestable roles are offered as a checklist instead of typed from memory.',
          'Save a set of resources, roles and reason against its cluster, and load it back from Saved… to raise again.',
        ],
      },
      {
        name: 'Fixed',
        items: [
          'A request for more than one resource failed: ids were comma-joined into one --resource flag, which tsh read as a single malformed id. Each is now its own flag.',
          'Submitting appeared to fail: tsh request create waits for a reviewer, so the dialog timed out and reported an error for a request that had been created. It now passes --nowait.',
        ],
      },
    ],
  },
  {
    version: '0.1.1',
    date: '2026-09-13',
    title: 'Teleport tags',
    summary: 'See every label a Teleport node carries, and filter the inventory by them.',
    sections: [
      {
        name: 'Tags',
        items: [
          'Every label on a Teleport node — static ones and dynamic command labels alike — shown in the sidebar.',
          '“Show tags” lists them under each host as key = value chips; with it off, the row summarises the most telling one.',
          'Hover a host for the full set, or right-click → Tags… for a list including Teleport’s internal labels.',
          'Click a tag to filter by it, and click it again to remove it.',
          'Teleport labels also appear in the Server profile dialog.',
        ],
      },
      {
        name: 'Searching',
        items: [
          'env=prod matches exactly, env:pro matches part of a value, env=prod* is a glob, env: means “has that label”.',
          'env=prod,staging matches either — a label holds one value, so a second can only mean “or”.',
          'tag:gpu searches every key and value at once; -env=dev excludes; terms combine with AND.',
          'A key written without its prefix still finds it: location=east matches aws/location.',
          'Non-label fields work too: cluster=, name=, host=, addr=, proxy=, type=, tunnel=.',
          'Tags… browses every label in the inventory grouped by key, with a count per value.',
          'The filter box autocompletes known key=value pairs and reports how many hosts matched.',
        ],
      },
    ],
  },
  {
    version: '0.1.0',
    date: '2026-09-13',
    title: 'First release',
    summary: 'Teleport and plain SSH in one desktop interface: terminals, SFTP, multi-exec, tunnels, keys and recordings.',
    sections: [
      {
        name: 'Connections',
        items: [
          'Teleport nodes from every logged-in tsh profile, plus every Host in ~/.ssh/config.',
          'One authentication per host — terminals, files, tunnels and multi-exec share a single connection.',
          'Password, key-passphrase and Teleport MFA prompts answered in the UI.',
          'Tabs and splits, including splitting with a different host so two servers sit side by side or stacked.',
          'Broadcast typing to every pane in a tab.',
          'Agent forwarding, compression, and X11 forwarding for graphical programs.',
          'Session logging to a file, and a saved layout offered back on next launch.',
        ],
      },
      {
        name: 'Files',
        items: [
          'Native SFTP over the multiplexed connection.',
          'Expandable +/- directory tree with keyboard navigation.',
          'Two explorers at once, each targeting local or any open session, stacked or side by side.',
          'Drag files directly between two servers — direct within a Teleport cluster, relayed otherwise.',
          'Drag from Finder to upload; transfer queue with rates and a status-bar confirmation on completion.',
          'Rename, recursive delete, chmod, inline editor.',
        ],
      },
      {
        name: 'Fleet',
        items: [
          'Multi-exec across many hosts with per-host output and exit codes.',
          'Save and load runs as YAML; export results as YAML.',
          'Export a multi-exec selection as a runnable Ansible bundle.',
          'Local, remote and dynamic SOCKS port forwarding.',
        ],
      },
      {
        name: 'Teleport',
        items: [
          'Multiple profiles with expiry and switching.',
          'Full tsh login dialog: proxy, user, auth connector, cluster, TTL, MFA mode.',
          'Access requests: list, create, assume and drop.',
          'Recorded sessions: replay in a tab or open in the web UI.',
          'Connection history that also covers plain SSH.',
        ],
      },
      {
        name: 'Keys and hosts',
        items: [
          'List keypairs with fingerprints and flag unsafe private-key permissions.',
          'Generate keys and install a public key on a connected server.',
          'Forget a stale host key after a rebuild.',
        ],
      },
      {
        name: 'Interface',
        items: [
          'Saved profiles with folders, startup commands and start directories.',
          'Light, dark and automatic themes with seven accent colours.',
          'Hide hosts you never use.',
          'Server profile: distribution, kernel, CPU, memory, disk, package manager.',
        ],
      },
    ],
  },
];

const curatedByVersion = new Map(CURATED.map((r) => [r.version, r]));

/** Every release, newest first: the changelog's, with the hand-written titles. */
export const RELEASES = (() => {
  const parsed = parseChangelog(CHANGELOG).map((r) => {
    const curated = curatedByVersion.get(r.version);
    return curated ? { ...r, title: curated.title || r.title } : r;
  });
  const seen = new Set(parsed.map((r) => r.version));
  return [...parsed, ...CURATED.filter((r) => !seen.has(r.version))];
})();

export function openVersionHistory() {
  return modal({
    title: 'Version history',
    subtitle: `${RELEASES.length} release${RELEASES.length === 1 ? '' : 's'}`,
    width: 'min(680px, 94vw)',
    render: (body) => {
      for (const r of RELEASES) {
        const head = el('div', {
          style: 'display:flex;align-items:baseline;gap:10px;margin-bottom:4px',
        },
          el('span', { style: 'font-size:15px;font-weight:600', text: 'v' + r.version }),
          el('span', { class: 'tag', text: r.date }),
          r.title ? el('span', { style: 'color:var(--muted);font-size:12px', text: r.title }) : null);

        const block = el('div', {
          style: 'margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border-soft)',
        }, head,
          r.summary ? el('div', { style: 'color:var(--text-dim);font-size:12px;margin-bottom:12px', text: r.summary }) : null);

        for (const s of r.sections) {
          block.append(el('div', {
            style: 'font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;'
              + 'color:var(--muted);margin:12px 0 5px',
            text: s.name,
          }));
          const ul = el('ul', { style: 'margin:0;padding-left:18px;font-size:12px;line-height:1.65' });
          for (const it of s.items) ul.append(el('li', { text: it }));
          block.append(ul);
        }
        body.append(block);
      }
    },
    buttons: [{ label: 'Close', class: 'primary-btn', value: null }],
  });
}
