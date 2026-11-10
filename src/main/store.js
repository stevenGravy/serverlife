'use strict';
/**
 * Persistent state: saved connection profiles, folders, and settings.
 *
 * Writes are atomic (tmp + rename) so a crash mid-save cannot truncate the
 * user's session list. No secrets are stored — profiles reference SSH config
 * aliases and identity files, never passwords.
 */

const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const HISTORY_LIMIT = 500;

const DEFAULTS = {
  version: 1,
  profiles: [],
  folders: [],
  history: [],
  // Last window layout, offered back on the next launch. `workspace` is the
  // main window and is kept for older builds; `workspaces` holds every window
  // by slot, which is what multi-window restore reads.
  workspace: null,
  workspaces: {},
  // Named layouts the user saved deliberately, plus which one opens by default.
  layouts: [],
  defaultLayoutId: null,
  // Reusable commands, sent into a terminal on demand.
  snippets: [],
  // Access requests saved to be raised again — the same servers, roles and
  // reason, against the cluster they were chosen on.
  requestTemplates: [],
  /**
   * Clusters kept so they can be logged into again.
   *
   * A profile only exists while its certificate does: `tsh logout`, or an
   * expiry old enough to be cleaned up, and the cluster disappears from every
   * list — along with the proxy address, the connector and the user it wanted.
   * These records are what survives that, so logging back in is one click
   * rather than remembering a hostname.
   */
  tshLogins: [],
  /**
   * Files brought down from a server or a bucket, newest first.
   *
   * A download ends with the file somewhere on this machine and the transfer
   * row gone at the next Clear, which leaves "where did that go?" answerable
   * only by guessing at Downloads folders. This is the answer, and it outlives
   * the session because the question usually comes later.
   */
  downloads: [],
  /**
   * Recorded sessions flagged to come back to, with a note.
   *
   * A recording is found by scrolling a list of everything that happened in a
   * date range, which is the wrong shape for "the one where the deploy went
   * wrong" — by the time you want it again you remember the circumstance, not
   * the timestamp or the id. Flagging keeps it findable, and the note is where
   * the circumstance goes. Keyed by session id, and kept whether or not that
   * session is still inside the range the cluster will list.
   */
  sessionNotes: [],
  /**
   * Port forwards worth keeping: `{ id, name, kind, bindPort, bindAddr,
   * destHost, destPort, host, login }`.
   *
   * A tunnel is closed when its session ends, and the interesting ones are the
   * same three or four every day — the database on its private address, the
   * admin UI that only listens on localhost. The host descriptor is stored
   * whole rather than as an id, because a favourite outlives the inventory it
   * was made from: a cluster can be logged out of and back into, and the
   * favourite should still know what to dial.
   */
  forwardFavorites: [],
  /**
   * Saved network-tool requests — chiefly curl calls: `{ id, name, tool,
   * target, opts }`.
   *
   * A POST with three headers and a JSON body is not something anyone wants to
   * retype, and the useful ones are checked again and again: a health
   * endpoint, a webhook, an API that keeps changing its mind.
   */
  netRequests: [],
  /**
   * The last few network-tool runs, whatever the tool: `{ id, tool, target,
   * opts, at, ok, summary }`.
   *
   * Separate from the saved list because they answer different questions.
   * This one is "run that again" — the thing you were doing five minutes ago,
   * before you switched tools to check something else. Capped and unnamed;
   * anything worth keeping gets saved properly.
   */
  netRuns: [],
  /**
   * Multi-exec runs, most recent first: `{ id, command, label, at, hosts,
   * hostIds, ok, failed }`.
   *
   * The results themselves are not kept — they can be long, and they go stale
   * the moment anything changes. What is worth keeping is the *question*: the
   * command and the hosts it was asked on, so it can be asked again after a
   * fix without rebuilding the selection by hand.
   */
  execRuns: [],
  /**
   * Macros the user wrote. The built-in set lives in code so it can improve
   * between releases; only additions live here, plus the ids of any built-ins
   * that have been dismissed.
   */
  macros: [],
  hiddenMacros: [],
  /**
   * Macros promoted to a button in every session's header, in the order the
   * buttons appear: `{ id, icon }`.
   *
   * Kept here rather than as a flag on the macro because a built-in can be
   * pinned too, and those live in code where nothing can be written. The icon
   * is the whole label — a pinned macro is meant to be hit without reading,
   * which a name in a menu is not.
   */
  macroPins: [],
  /**
   * Category names in the order the user wants them listed. Anything not named
   * here falls in behind, so adding a category never needs the order updating.
   */
  macroCategoryOrder: [],
  /**
   * Macro ids in the order they were dragged into, built-ins included. A macro
   * not named here keeps its place behind the ones that are.
   */
  macroOrder: [],
  /**
   * Registered S3 buckets. Secret keys are never written in the clear: a
   * target either reads credentials from the environment, or carries a
   * ciphertext the OS keychain produced.
   */
  s3Targets: [],
  settings: {
    theme: 'dark',            // 'dark' | 'light' | 'auto', or a named theme id (renderer/js/themes.js)
    accent: 'blue',
    // A named palette that overrides both of the above. 'none' is the default
    // dark/light look; the rest are seasonal or just for fun.
    skin: 'none',
    x11: 'off',               // default X11 mode for new sessions
    /**
     * MFA method for per-session-MFA nodes. 'platform' (Touch ID) is the
     * default because tsh's 'auto' can pick a path that fails in a spawned
     * process and consumes the challenge, leaving no working fallback.
     */
    mfaMode: 'platform',
    // Hosts known to require per-session MFA, so they skip the shared-connection
    // path that cannot satisfy it and go straight to tsh.
    mfaHosts: [],
    // Last login that worked for a given host, so it is not rediscovered
    // every time. Keyed by host id.
    hostLogins: {},
    /**
     * The login a host should *always* use, said deliberately rather than
     * learned. Keyed by `uuid:<node uuid>` for a Teleport node and by the host
     * id otherwise.
     *
     * A Teleport node's hostname is a label — it changes when the machine is
     * renamed or rebuilt — while its uuid is what the cluster actually knows
     * it by. Keying on the uuid means a rename does not quietly lose the
     * account you connect as. Takes precedence over hostLogins, which is only
     * ever a record of what worked last.
     */
    hostUsers: {},
    /**
     * Agent forwarding (`ssh -A`, `tsh ssh -A`), decided at three levels: this
     * global preference, an override per cluster, and an override per host.
     * The most specific one that has an opinion wins.
     *
     * Off by default, and deliberately so: forwarding the agent lets anything
     * running as root on that host use your keys while the session is open.
     * It is exactly what a jump host needs and exactly what a shared box
     * should not have, which is why it is worth setting per host at all.
     */
    agentForward: false,
    agentForwardHosts: {},      // host pref key -> bool
    agentForwardClusters: {},   // proxy (or 'ssh') -> bool
    /**
     * Keyword highlighting in the terminal: **off** until it is asked for.
     *
     * Colour in a terminal is the program's to use, and rewriting its output —
     * however carefully — is a decision that should be made rather than
     * arrive. Switched on globally in Settings, or per host from the toggle
     * beside a pane's search box.
     *
     * `highlightRules` holds only what the user added or changed — a built-in
     * that has been edited is saved here under its own id and replaces the
     * original, the same arrangement the macros use, so the shipped set can
     * improve without overwriting anyone's edits.
     */
    highlight: false,
    highlightRules: [],
    hiddenHighlightRules: [],
    /**
     * Per host: `{ on?: bool, off?: [ruleId], extra?: [rule] }`, keyed like
     * the other per-host preferences. The words that matter are not the same
     * everywhere — a mail relay's "deferred" is routine, a build box's is not.
     */
    highlightHosts: {},
    hiddenHosts: [],          // host ids hidden from the sidebar
    showHiddenHosts: false,
    /**
     * Hosts starred to the top of the list, by host id. Order is the order
     * they were starred in, so a list built up over time stays stable.
     */
    starredHosts: [],
    /**
     * Where starred hosts appear: `inline` sorts them to the top of the group
     * they belong to, `group` collects them into a Starred group above
     * everything.
     *
     * Inline by default. A separate group is a second place to look and lists
     * the host twice; sorting it to the top of its own cluster keeps one list
     * and still answers "the ones I actually use".
     */
    starredMode: 'inline',
    /**
     * Manual host order within a group: `{ [groupKey]: [hostId, …] }`.
     *
     * Hosts not named fall in behind, in their natural order, so dragging one
     * host to the top never has to name the other forty.
     */
    hostOrder: {},
    /**
     * Extra OpenSSH config files to read hosts from, beyond `~/.ssh/config`.
     *
     * One config per context is a common arrangement — a work file, a file a
     * cloud tool generates, one kept in a repository — and `Include` only
     * helps when you are willing to edit the main file. Each of these is read
     * as its own root, and a host from one is opened with `ssh -F <that file>`
     * so the file's own options and defaults are what apply.
     */
    sshConfigFiles: [],
    /**
     * A ceiling on transfer speed in KB/s, 0 for none.
     *
     * One number for the whole app rather than per connection: the thing being
     * protected is the link out of this machine, and "2 MB/s each" across three
     * transfers is not a limit anyone meant.
     */
    transferLimitKb: 0,
    /**
     * Where each window was last left, by slot: `{ x, y, width, height,
     * maximized, fullScreen }`.
     *
     * A preference rather than part of the session: someone who sizes the
     * window to their screen means it, and re-doing it at every launch is the
     * kind of small daily friction that makes an app feel unfinished. Checked
     * against the displays that exist at launch before it is used.
     */
    windowBounds: {},
    /**
     * The draggable panel sizes — sidebar width, file panel, dock height —
     * keyed by the resizer's id. Same reasoning.
     */
    panelSizes: {},
    /**
     * Whether a local tab's title names the shell it is running.
     *
     * Off: "local: ~/work" is what anyone needs, and the shell is only
     * interesting when you have deliberately opened a different one — so it is
     * there to be turned on rather than in the way by default.
     */
    showShellInTitle: false,
    /**
     * The network-tools icon on every session's header.
     *
     * On, because "can this host reach that" is asked constantly and the
     * alternative is two clicks and telling the tools which session to use.
     * Off for anyone whose header is busy enough already — the tools are
     * still on ⌘⇧T with a Run on selector.
     */
    showPaneNetIcon: true,
    /**
     * A colour per host, keyed like the other per-host preferences.
     *
     * Not decoration: it is how you tell at a glance that the pane you are
     * typing into is production. The tab, the pane header and the host's row
     * all take it, and a host can be marked *careful* so anything destructive
     * asks first.
     */
    hostColors: {},
    /** Hosts marked as needing care, by the same key. */
    carefulHosts: [],
    /**
     * The sixteen colours the terminal draws output in: 'app' follows the
     * theme, or one of the named palettes (Solarized, Gruvbox, Nord…).
     */
    terminalPalette: 'app',
    /**
     * Folders worth coming back to: `{ id, path, label, scope }`.
     *
     * `scope` is `local` for this machine, `hosts` for every server, or a
     * host's own preference key for one server in particular. Three scopes
     * because the useful set is genuinely mixed: `/var/log` is worth having on
     * every host, `~/Downloads` only here, and an app's deploy directory only
     * on the box it is deployed to.
     */
    folderFavorites: [],
    /**
     * Folders flagged automatically, one path per entry, `~` meaning the home
     * directory of whichever side it applies to.
     *
     * Useful before anyone has starred anything, and configurable because the
     * right set is a matter of what you keep where: a desktop machine has
     * Documents, a build box has `/srv`, a mail relay has `/var/spool`.
     * Entries that do not exist are skipped rather than shown as dead links,
     * and any of them can be hidden individually (hiddenFolderFavorites).
     */
    autoFlagLocal: ['~', '~/Desktop', '~/Documents', '~/Downloads'],
    autoFlagHost: ['~', '~/Desktop', '~/Documents', '~/Downloads', '/var/log', '/etc', '/tmp'],
    // List every Teleport label under each host row, rather than one summary
    // tag. Off by default: it is a lot of ink on a wide inventory.
    showHostTags: false,
    /*
     * How long ago each Teleport node last checked in, on its row. Off by
     * default: on a healthy cluster it is the same answer on every line, and
     * the one row where it is not already says so on its own.
     */
    showHeartbeats: false,
    /*
     * What the host list does with nodes that have gone quiet: 'all' leaves
     * them where they are with their warning, 'hide' drops them, 'only'
     * keeps nothing else. 'all' by default — a node that may be gone is
     * worth seeing before it is worth filing away — and the toolbar button
     * carries their count in every one of the three.
     */
    quietNodeFilter: 'all',
    // Sidebar group order, by group key ('local', 'ssh', 'tp:<proxy>'). Groups
    // not listed keep their natural place behind the arranged ones.
    hostGroupOrder: [],
    /**
     * Folders inside a cluster or an ssh_config, and what is in them.
     *
     * `hostFolders` is the tree — `{id, name, parent, group, rule}` — and
     * `folderMembers` is `{folderId: {in: [...], out: [...]}}`, keyed by the
     * same per-host key as every other preference here, which for a Teleport
     * node is its UUID. A hostname changes on a rename or a rebuild and a
     * filing system that forgets where a machine was because somebody
     * renamed it is not one.
     *
     * `in` is what was dragged in, `out` is what was taken back out of a
     * folder that claims it by rule — without the second, removing a node
     * from a rule folder would be undone by the rule immediately.
     *
     * Portable on purpose: these two keys are the whole of an arrangement,
     * which is what the export writes and the import reads.
     */
    hostFolders: [],
    folderMembers: {},
    /**
     * How many hosts a sidebar group lists before it stops and offers the
     * hosts pane instead.
     *
     * A cluster with three hundred nodes turns the sidebar into a scrollbar
     * with a list attached, and pushes every other group off the bottom. The
     * cap keeps the column readable; the row that says how many are held
     * back is the way into the view that can show them all. 0 lifts it.
     *
     * Twenty: about a screen of rows on a laptop, which is the point at
     * which a second cluster stops being visible below the first.
     */
    sidebarHostLimit: 20,
    // The hosts pane remembers how it was last left: the arrangement or the
    // plain list, rows or tiles.
    hostsPaneView: 'list',
    hostsPaneFolders: true,
    // Off by default — a "Saved" group of every saved profile alongside a
    // cluster's own hosts is extra, not the common case.
    hostsPaneProfiles: false,
    // {mode:'name'|'status'|'label', labelKey} — unset falls back to name.
    hostsPaneSort: null,
    // A filed host is listed in its folder and not loose at the top of its
    // group. Turning this on lists it in both.
    showFiledHosts: false,
    /*
     * An emoji beside a host's name, keyed like every other per-host
     * preference. Separate from its colour because they answer different
     * questions: the colour is "careful", the icon is "which of these is
     * it" — a red 🐧 and a red 🪟 are both production and not the same
     * problem. Any host can carry one, an ssh_config alias included.
     */
    hostIcons: {},
    /*
     * The same two marks a host can carry, for a cluster: keyed by the group
     * key, so they follow the cluster rather than whichever profile row
     * happens to be drawing it.
     */
    /*
     * Clusters whose host list also shows what could be requested. Per
     * cluster rather than global: one may offer three nodes and another
     * three hundred, and the second would bury the list it is added to.
     */
    requestableGroups: {},
    /*
     * Clusters that refused a request for want of a reason. Learned rather
     * than configured: the requirement lives in a role on the cluster and
     * there is no way to ask for it up front, so the first refusal is what
     * teaches it — after which the field is marked required before anything
     * is sent.
     */
    reasonRequired: {},
    /*
     * Roles you have tied to a resource yourself, when nothing else could
     * say which apply: `{ "<resource id>": ["access", "staging-access"] }`.
     * Teleport will not enumerate them for a resource request, and asking
     * it by trying costs a real request — so what is learned, from your own
     * history or from you, is kept.
     */
    resourceRoles: {},
    clusterIcons: {},
    clusterColors: {},
    /**
     * Hosts the user asked to be told about if they disappear, keyed the
     * same way as everything else here and holding the last thing that was
     * known about each: its node id, name, address, labels and cluster, when
     * it was last seen, and when it was first noticed missing.
     *
     * The record is the point. A cluster's list is the truth about what is
     * there, which makes it useless for noticing what is not — the row is
     * simply gone, and with it everything the row knew. After the fact the
     * cluster cannot be asked, so the details are kept while the host is
     * still around to be asked about.
     */
    watchedHosts: {},
    /*
     * Whether a watched host wears a bell in the lists. On by default, and
     * worth being able to turn off: mark thirty machines and the column of
     * names grows thirty bells, which is where a mark stops meaning
     * anything. The watch itself does not depend on it.
     */
    showWatchMark: true,
    /*
     * Requestable resources being watched: what is monitored, how often the
     * search is re-run, and whether the pane was left open.
     */
    requestMonitor: [],
    requestMonitorMinutes: 5,
    requestMonitorOpen: false,
    /*
     * Whether the monitor's pane comes back on its own at startup. Off: a
     * window that opens itself is an interruption, and the monitoring runs
     * whether or not anyone is looking at it.
     */
    requestMonitorAutoOpen: false,
    requestMonitorPos: null,
    // Per cluster and kind: when its search last worked, and last did not.
    requestMonitorStatus: {},
    // What each tab's session is doing: the ripple while output arrives, and
    // the amber a tab turns when something in it is waiting to be answered.
    showTabActivity: true,
    /*
     * Ask before a clicked link opens the browser.
     *
     * On by default, and that default is the point: the text in a terminal is
     * written by whatever is on the other end of the connection, so a link in
     * it is a stranger's suggestion rather than the user's own. The question
     * shows the address and the host before anything leaves the app, and this
     * turns it off for people who would rather have the single click.
     */
    confirmLinkOpen: true,
    /* Esc, ↑, ↓ and Enter buttons under the AI assistant, for answering its menus. */
    aiKeys: true,
    /*
     * Ask before quitting while remote sessions are open — hosts, consoles,
     * screens, tmux. Local shells never trigger it. On by default: Cmd+Q sits
     * one key from Cmd+W, and a dozen logged-in panes is a lot to lose to a
     * slipped finger.
     */
    confirmQuitWithSessions: true,
    /*
     * Whether a session opens inside tmux.
     *
     * Off by default, and per host and per cluster above that: tmux is the
     * difference between a dropped connection costing a reconnect and costing
     * six hours of migration, but it also needs tmux on the far side and
     * changes what a session *is*. The hosts where that trade is obviously
     * worth it are not usually all of them.
     */
    tmuxDefault: false,
    tmuxHosts: {},
    tmuxClusters: {},
    tmuxSessionName: 'serverlife',
    tmuxSessionNames: {},
    /**
     * The scene that plays while a session dials: 'rotate' cycles through the
     * set, 'off' shows none, anything else pins one by id.
     */
    connectAnim: 'rotate',
    /**
     * How many recent connections the New Session dialog offers back. 0 turns
     * the list off; the full session history is kept either way.
     */
    recentLimit: 20,
    /**
     * Addresses typed into Quick connect, newest first, so the next one is a
     * keystroke rather than a retype. Addresses only — never a credential —
     * and cleared with the session history.
     */
    quickConnects: [],
    /**
     * Which version of the guided tour has been seen. A number rather than a
     * flag so a later release can offer the tour again when it has genuinely
     * new steps, without re-showing it for a wording fix. 0 means never.
     */
    tourSeenVersion: 0,
    /**
     * Extra tsh profile directories (TELEPORT_HOME). Empty means the default
     * one alone; every entry adds its clusters to the inventory, and every tsh
     * command for those clusters runs with that directory.
     */
    tshHomes: [],
    /**
     * Where tsh is, when it is somewhere the search does not look. Windows
     * installers rarely put it on PATH, so this is the escape hatch.
     */
    tshPath: '',
    /** Where the OpenSSH client is, when it is not somewhere obvious. */
    sshPath: '',
    /**
     * The local control socket other programs (the bundled MCP server, a
     * script) use to open sessions and read the inventory. Off by default: it
     * is a capability, not a convenience.
     */
    controlSocket: false,
    autoRestoreWorkspace: false,
    explorersVisible: true,
    /*
     * Hosts and clusters that open their sessions with the file browser, or
     * without it, whatever `explorersVisible` says. Keyed the way every other
     * per-host preference is (see hostPrefKey) and by proxy for a cluster.
     *
     * Empty by default: the exceptions are what these hold. A jump box or an
     * appliance with no SFTP subsystem has nothing to show in an explorer,
     * and one global answer cannot be right for it and for the file server on
     * the same cluster.
     */
    openFilesHosts: {},
    openFilesClusters: {},
    explorerPosition: 'left',   // 'left' beside the terminal, 'top' above it
    fontSize: 13,
    fontFamily: 'SFMono-Regular, Menlo, monospace',
    scrollback: 10000,
    cursorBlink: true,
    cursorStyle: 'bar',
    confirmOnClose: true,
    // A little theatre for closing a single pane — one of a few dozen
    // ways, chosen at random, never the same twice in a row. Off skips
    // straight to removing it, same as before this existed.
    paneCloseAnimations: true,
    followTerminalFolder: true,
    // Background file-list refresh, in seconds. 0 disables polling entirely.
    refreshSeconds: 5,
    /**
     * How often the Teleport clusters are re-read, in seconds. 0 turns it off
     * and leaves it to the Refresh button.
     *
     * Two things on the same timer, for the same reason: a cluster's
     * inventory changes while you are looking at it, and so does whether its
     * certificate is still valid. A list that was true at launch is not much
     * use an hour later, and neither is a cluster still shown as logged in
     * after its certificate has lapsed. One `tsh status` and one `tsh ls` per
     * live cluster, only while the window is visible, and the sidebar is
     * redrawn only when something actually differs.
     */
    nodeRefreshSeconds: 10,
    /**
     * Minutes of silence from a Teleport node before its row is marked as
     * having gone quiet. 0 turns the warning off.
     *
     * On by default, because the thing it warns about is otherwise invisible:
     * a node whose agent has died stays in the inventory, looking exactly
     * like a healthy one, until the cluster drops it. Two minutes is past
     * anything a healthy agent does — the ones seen here re-announce inside
     * ninety seconds — and leaves most of the window before the node
     * disappears for the warning to be seen in.
     */
    staleNodeMinutes: 2,
    showHiddenFiles: false,
    /*
     * Folders above files in every listing, or everything sorted together.
     *
     * On by default because it is the convention, and off is genuinely
     * better for the questions a sort is usually asked: "what changed here
     * last" and "what is the biggest thing in this directory" are both
     * answered wrongly by a date or size order that holds the folders above
     * it.
     */
    foldersFirst: true,
    // The 3D button on every file browser. On by default; off takes the
    // button away and closes any city already open, for a machine without the
    // GPU for it or a toolbar that is crowded enough.
    show3dView: true,
    // Permissions and owner as columns in every file list, off by default:
    // most of the time the name, size and date are the whole question.
    showFileDetails: false,
    /**
     * Proxies the user has marked as running beams, and ones they have marked
     * as not.
     *
     * The probe answers this on its own, and is trusted where it does: a
     * cluster that says "unknown service" has no beams. The override exists
     * for the other direction — a cluster that has them but cannot be probed
     * right now (an expired certificate, a proxy that is slow to answer)
     * should still show its group rather than disappearing.
     */
    beamProxies: [],
    // beams.sh / beams.run clusters are beams by name; these were turned off by hand.
    notBeamProxies: [],
    // No commands run on a host by itself (live stats, folder following, free space, re-listing).
    quietRemote: false,
    hiddenBeamProxies: [],
    /**
     * Whether a direct (non-Teleport) SSH host gets probed for an already-
     * running Teleport agent, with a badge and a recommendation to bring it
     * under Teleport properly when it is not. On by default; off removes the
     * probe, the badge and the install wizard's recommendation entirely —
     * it only ever runs against a host already being connected to by hand,
     * never against anything else.
     */
    detectTeleportOnSsh: true,
    /**
     * KubeLife: Kubernetes support. On by default, but genuinely optional —
     * this one flag is checked everywhere a kube tab, a kube host type, a
     * kube quick-connect scheme, a kube row in access requests, or a kube
     * settings panel could appear, so turning it off leaves none of them
     * behind. See GUIDE.md § KubeLife, "Turning it off."
     */
    kubeEnabled: true,
    // Extra kubeconfig files to read contexts from, beyond $KUBECONFIG /
    // ~/.kube/config. Only read/shown when kubeEnabled is true.
    kubeconfigPaths: [],
    // How often KubeLife re-reads a watched cluster's node/pod summary, in
    // seconds. Parallel to nodeRefreshSeconds, but coarser: one `kubectl get`
    // per watched cluster, not per pod.
    kubeRefreshSeconds: 15,
    // Cluster inventory ids (see kubeIds in src/main/teleport.js) being
    // watched for "tell me if this disappears or changes", parallel to
    // watchedHosts in shape and in the "never cry wolf" discipline watch.js
    // documents for hosts.
    watchedKubeClusters: {},
    /**
     * The command that opens a remote file for editing. Empty means "whatever
     * the OS opens this file type with", which is right for most people and
     * wrong for anyone who lives in one editor — `code -w`, `subl -w`, `mate`.
     */
    externalEditor: '',
    /**
     * Applications picked with "Open with…", most recent first.
     *
     * Remembered because the answer is nearly always the same two or three
     * programs, and re-walking /Applications for each one is the slow part of
     * a fast action. Paths, since that is what launching one needs; the name
     * shown in the menu is derived from the path.
     */
    openWithApps: [],
    defaultLocalPath: os.homedir(),
    bellSound: false,
  },
};

function newId(prefix = 'p') {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

class Store extends EventEmitter {
  constructor(dir) {
    super();
    this.dir = dir || path.join(os.homedir(), '.serverlife');
    this.file = path.join(this.dir, 'sessions.json');
    this.data = JSON.parse(JSON.stringify(DEFAULTS));
    this._saveTimer = null;
  }

  async load() {
    try {
      await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const raw = await fsp.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = {
        ...DEFAULTS,
        ...parsed,
        settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) },
        profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
        folders: Array.isArray(parsed.folders) ? parsed.folders : [],
        history: Array.isArray(parsed.history) ? parsed.history : [],
        workspace: parsed.workspace || null,
        // A file written before multi-window has only the single field; lift it
        // into slot w1 so the first launch after upgrading still restores.
        workspaces: (parsed.workspaces && typeof parsed.workspaces === 'object')
          ? parsed.workspaces
          : (parsed.workspace ? { w1: { ...parsed.workspace, slot: 'w1' } } : {}),
        layouts: Array.isArray(parsed.layouts) ? parsed.layouts : [],
        snippets: Array.isArray(parsed.snippets) ? parsed.snippets : [],
        requestTemplates: Array.isArray(parsed.requestTemplates) ? parsed.requestTemplates : [],
        tshLogins: Array.isArray(parsed.tshLogins) ? parsed.tshLogins : [],
        downloads: Array.isArray(parsed.downloads) ? parsed.downloads : [],
        sessionNotes: Array.isArray(parsed.sessionNotes) ? parsed.sessionNotes : [],
        forwardFavorites: Array.isArray(parsed.forwardFavorites) ? parsed.forwardFavorites : [],
        netRequests: Array.isArray(parsed.netRequests) ? parsed.netRequests : [],
        netRuns: Array.isArray(parsed.netRuns) ? parsed.netRuns : [],
        execRuns: Array.isArray(parsed.execRuns) ? parsed.execRuns : [],
        macros: Array.isArray(parsed.macros) ? parsed.macros : [],
        hiddenMacros: Array.isArray(parsed.hiddenMacros) ? parsed.hiddenMacros : [],
        macroPins: Array.isArray(parsed.macroPins) ? parsed.macroPins : [],
        macroCategoryOrder: Array.isArray(parsed.macroCategoryOrder) ? parsed.macroCategoryOrder : [],
        macroOrder: Array.isArray(parsed.macroOrder) ? parsed.macroOrder : [],
        s3Targets: Array.isArray(parsed.s3Targets) ? parsed.s3Targets : [],
        defaultLayoutId: parsed.defaultLayoutId || null,
      };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Keep a copy of anything unreadable rather than silently dropping it.
        try { await fsp.rename(this.file, this.file + '.corrupt-' + Date.now()); } catch { /* a file that cannot be moved aside is overwritten anyway */ }
      }
      this.data = JSON.parse(JSON.stringify(DEFAULTS));
    }
    return this.data;
  }

  /** Debounced atomic save. */
  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { this.saveNow().catch(() => {}); }, 250);
  }

  async saveNow() {
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = this.file + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await fsp.rename(tmp, this.file);
    this.emit('saved');
  }

  get settings() { return this.data.settings; }

  updateSettings(patch) {
    Object.assign(this.data.settings, patch || {});
    this.save();
    this.emit('changed');
    return this.data.settings;
  }

  listProfiles() { return this.data.profiles; }

  getProfile(id) { return this.data.profiles.find((p) => p.id === id) || null; }

  /**
   * Create or update a saved profile. A profile captures everything needed to
   * re-open a session: target, login, start directories and startup command.
   */
  upsertProfile(profile) {
    const now = Date.now();
    if (profile.id) {
      const i = this.data.profiles.findIndex((p) => p.id === profile.id);
      if (i >= 0) {
        this.data.profiles[i] = { ...this.data.profiles[i], ...profile, updatedAt: now };
        this.save();
        this.emit('changed');
        return this.data.profiles[i];
      }
    }
    const rec = {
      id: newId(),
      name: profile.name || profile.alias || profile.node || 'Untitled',
      folderId: profile.folderId || null,
      type: profile.type || 'ssh',
      // ssh
      alias: profile.alias || null,
      hostname: profile.hostname || null,
      user: profile.user || null,
      port: profile.port || null,
      identityFile: profile.identityFile || null,
      /*
       * A bastion for this profile. Passed as `ssh -J`, which layers on top of
       * an ssh_config alias as well as applying to a host defined here — so it
       * is a field of its own rather than only part of `direct`.
       */
      proxyJump: profile.proxyJump || null,
      // `-o Name=value` lines, layered on the host's own options when it opens.
      sshExtraOptions: profile.sshExtraOptions || null,
      // A Kubernetes profile: { spec: {contextName, kubeconfigPaths, teleport…}, namespace, view }.
      kube: profile.kube || null,
      // Connection details for hosts defined in the app, not in ssh_config.
      direct: profile.direct || null,
      // teleport
      proxy: profile.proxy || null,
      cluster: profile.cluster || null,
      // Which tsh home the cluster was chosen from; null means the default.
      home: profile.home || null,
      node: profile.node || null,
      login: profile.login || null,
      /*
       * Consoles and screens.
       *
       * A serial port, a telnet socket, a VNC screen and an RDP session are
       * saved in the same record as an SSH host because they are the same
       * kind of thing to the person using them — something on the list that
       * you open — and because anything else would mean a second list, a
       * second set of folders and a second place to look.
       *
       * `devicePort` rather than `port`: that one already means the SSH port
       * and carries a default of 22, and a VNC screen inheriting 22 from a
       * field it never set is the sort of bug nobody finds until the
       * connection fails.
       */
      path: profile.path || null,
      baudRate: profile.baudRate || null,
      dataBits: profile.dataBits || null,
      parity: profile.parity || null,
      stopBits: profile.stopBits || null,
      rtscts: !!profile.rtscts,
      xon: !!profile.xon,
      xoff: !!profile.xoff,
      host: profile.host || null,
      devicePort: profile.devicePort || null,
      newline: profile.newline || null,
      localEcho: !!profile.localEcho,
      viewOnly: !!profile.viewOnly,
      scaling: profile.scaling || null,
      quality: profile.quality ?? null,
      username: profile.username || null,
      domain: profile.domain || null,
      fullscreen: !!profile.fullscreen,
      width: profile.width || null,
      height: profile.height || null,
      clipboard: profile.clipboard !== false,
      drives: !!profile.drives,
      gateway: profile.gateway || null,
      // behaviour
      color: profile.color || null,
      // Same meaning as a real host's — set from the profile's own "Mark
      // this profile" menu, not the per-host settings map a plain host
      // uses, since a profile is already its own record.
      icon: profile.icon || null,
      tags: profile.tags || [],
      startupCommand: profile.startupCommand || '',
      remoteStartPath: profile.remoteStartPath || '',
      localStartPath: profile.localStartPath || '',
      notes: profile.notes || '',
      createdAt: now,
      updatedAt: now,
      lastUsed: null,
      useCount: 0,
    };
    this.data.profiles.push(rec);
    this.save();
    this.emit('changed');
    return rec;
  }

  deleteProfile(id) {
    const before = this.data.profiles.length;
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
    if (this.data.profiles.length !== before) { this.save(); this.emit('changed'); }
  }

  markUsed(id) {
    const p = this.getProfile(id);
    if (!p) return;
    p.lastUsed = Date.now();
    p.useCount = (p.useCount || 0) + 1;
    this.save();
  }

  /* ---------------- session history ---------------- */

  /**
   * Record that a session opened. Kept locally so the timeline covers plain
   * SSH hosts too, which Teleport's audit log never sees.
   */
  startHistory(entry) {
    const rec = {
      id: newId('h'),
      type: entry.type,               // 'teleport' | 'ssh' | 'local'
      label: entry.label,
      target: entry.target || null,
      cluster: entry.cluster || null,
      proxy: entry.proxy || null,
      node: entry.node || null,
      home: entry.home || null,
      login: entry.login || null,
      user: entry.user || null,
      hostname: entry.hostname || null,
      // Connection details for a host with no ssh_config entry, so it can be
      // reopened as it was dialled. Never a secret: a key path, not a key.
      direct: entry.direct || null,
      startedAt: Date.now(),
      endedAt: null,
      error: null,
    };
    this.data.history.unshift(rec);
    if (this.data.history.length > HISTORY_LIMIT) {
      this.data.history.length = HISTORY_LIMIT;
    }
    this.save();
    return rec;
  }

  endHistory(id, { error } = {}) {
    const rec = this.data.history.find((h) => h.id === id);
    if (!rec || rec.endedAt) return null;
    rec.endedAt = Date.now();
    if (error) rec.error = error;
    this.save();
    return rec;
  }

  listHistory({ limit = 200 } = {}) {
    return this.data.history.slice(0, limit);
  }

  /**
   * The last few distinct places you connected, newest first.
   *
   * Built from the history log rather than kept as a second list: history
   * already records every dial, including the ones that failed, so a machine
   * that has been running for months has a memory the moment this ships. One
   * entry per destination — reconnecting to the same host ten times is one
   * thing you did, not ten.
   */
  listRecent({ limit = 20 } = {}) {
    if (limit <= 0) return [];
    const seen = new Map();
    for (const h of this.data.history) {
      // The port is part of the identity for a host dialled by details: its
      // target string is only `user@host`, so two ports on one machine would
      // otherwise collapse into one entry pointing at whichever was last.
      const key = [h.type, h.cluster || '', h.node || h.target || h.label || '',
        h.login || '', h.home || '', h.direct?.port || ''].join('\u0000');
      if (seen.has(key)) {
        // Keep the newest record, but remember that it has ever worked.
        const rec = seen.get(key);
        if (rec.error && !h.error) { rec.error = null; rec.lastOkAt = h.startedAt; }
        rec.count++;
        continue;
      }
      seen.set(key, {
        key,
        type: h.type,
        label: h.label,
        target: h.target || null,
        cluster: h.cluster || null,
        proxy: h.proxy || null,
        node: h.node || null,
        home: h.home || null,
        login: h.login || null,
        user: h.user || null,
        hostname: h.hostname || null,
        direct: h.direct || null,
        at: h.startedAt,
        lastOkAt: h.error ? null : h.startedAt,
        error: h.error || null,
        count: 1,
      });
      if (seen.size >= limit) break;
    }
    return [...seen.values()];
  }

  clearHistory() {
    this.data.history = [];
    this.save();
    this.emit('changed');
  }

  /* ---------------- saved layout ---------------- */

  /**
   * The set of open sessions and how they were arranged. Stored so the app can
   * offer to put everything back rather than reopening silently — restoring
   * connections is an action with side effects, so it stays opt-in.
   */
  saveWorkspace(ws, slot = 'w1') {
    if (!this.data.workspaces) this.data.workspaces = {};
    if (ws) this.data.workspaces[slot] = { ...ws, slot, savedAt: Date.now() };
    else delete this.data.workspaces[slot];
    // The single-window field is kept in step so an older build downgraded on
    // to the same file still finds the main window's layout.
    if (slot === 'w1') this.data.workspace = this.data.workspaces[slot] || null;
    this.save();
    return this.data.workspaces[slot] || null;
  }

  getWorkspace(slot = 'w1') {
    return (this.data.workspaces && this.data.workspaces[slot]) || null;
  }

  /** Every saved window with something in it, in slot order. */
  listWorkspaces() {
    const all = this.data.workspaces || {};
    return Object.keys(all)
      .filter((k) => all[k] && (all[k].tabs || []).length)
      .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
      .map((k) => all[k]);
  }

  clearWorkspace(slot) {
    if (!this.data.workspaces) this.data.workspaces = {};
    if (slot) delete this.data.workspaces[slot];
    else this.data.workspaces = {};
    if (!slot || slot === 'w1') this.data.workspace = null;
    this.save();
  }

  /* ---------------- named layouts ---------------- */

  listLayouts() {
    return this.data.layouts.map((l) => ({
      ...l,
      isDefault: l.id === this.data.defaultLayoutId,
    }));
  }

  getLayout(id) { return this.data.layouts.find((l) => l.id === id) || null; }

  /** Save (or overwrite by name) a named layout. */
  saveLayout({ id, name, workspace }) {
    const now = Date.now();
    const existing = id
      ? this.data.layouts.find((l) => l.id === id)
      : this.data.layouts.find((l) => l.name.toLowerCase() === String(name).toLowerCase());

    if (existing) {
      existing.name = name || existing.name;
      existing.workspace = workspace;
      existing.updatedAt = now;
      this.save();
      return { ...existing, isDefault: existing.id === this.data.defaultLayoutId };
    }
    const rec = {
      id: newId('l'),
      name: name || 'Layout',
      workspace,
      createdAt: now,
      updatedAt: now,
    };
    this.data.layouts.push(rec);
    this.save();
    return { ...rec, isDefault: false };
  }

  deleteLayout(id) {
    this.data.layouts = this.data.layouts.filter((l) => l.id !== id);
    if (this.data.defaultLayoutId === id) this.data.defaultLayoutId = null;
    this.save();
  }

  setDefaultLayout(id) {
    // Passing null clears the default, so startup falls back to the snapshot.
    this.data.defaultLayoutId = id && this.getLayout(id) ? id : null;
    this.save();
    return this.data.defaultLayoutId;
  }

  getDefaultLayout() {
    return this.data.defaultLayoutId ? this.getLayout(this.data.defaultLayoutId) : null;
  }

  /* ---------------- command snippets ---------------- */

  listSnippets() { return this.data.snippets; }

  upsertSnippet(sn) {
    const now = Date.now();
    if (sn.id) {
      const i = this.data.snippets.findIndex((x) => x.id === sn.id);
      if (i >= 0) {
        this.data.snippets[i] = { ...this.data.snippets[i], ...sn, updatedAt: now };
        this.save();
        return this.data.snippets[i];
      }
    }
    const rec = {
      id: newId('s'),
      name: sn.name || (sn.command || '').split('\n')[0].slice(0, 40) || 'Snippet',
      command: sn.command || '',
      tags: sn.tags || [],
      runOnOpen: !!sn.runOnOpen,
      createdAt: now,
      updatedAt: now,
      useCount: 0,
    };
    this.data.snippets.push(rec);
    this.save();
    return rec;
  }

  deleteSnippet(id) {
    this.data.snippets = this.data.snippets.filter((x) => x.id !== id);
    this.save();
  }

  /* ---------------- macros ---------------- */

  listMacros() {
    return {
      macros: this.data.macros,
      hidden: this.data.hiddenMacros,
      categoryOrder: this.data.macroCategoryOrder,
      order: this.data.macroOrder,
      pins: this.data.macroPins,
    };
  }

  /**
   * Pin a macro as a session-header button, or unpin it.
   *
   * Order is append: a new button lands on the end rather than reshuffling
   * the ones already in muscle memory. Re-pinning something already pinned
   * only changes its icon, and keeps its place for the same reason.
   */
  setMacroPin(id, { pinned = true, icon = '', where } = {}) {
    const key = String(id || '');
    if (!key) return this.data.macroPins;
    /*
     * Where the button belongs: every session including the local shell, host
     * sessions only, or the local shell only. A macro that reads a server's
     * journal has no business on a local prompt, and one that opens a local
     * tool has none on a server — so the scope is part of pinning it.
     *
     * A pin saved before this existed has no scope and keeps the behaviour it
     * had: hosts only.
     */
    const scope = ['all', 'hosts', 'beams', 'local'].includes(where) ? where : undefined;
    const at = this.data.macroPins.findIndex((p) => p.id === key);
    if (!pinned) {
      if (at >= 0) this.data.macroPins.splice(at, 1);
    } else if (at >= 0) {
      this.data.macroPins[at] = {
        ...this.data.macroPins[at],
        icon: String(icon || '').slice(0, 8),
        where: scope || this.data.macroPins[at].where || 'hosts',
      };
    } else {
      this.data.macroPins.push({
        id: key,
        icon: String(icon || '').slice(0, 8),
        where: scope || 'hosts',
      });
    }
    this.save();
    return this.data.macroPins;
  }

  /** Drop the pin when its macro is deleted, so no button points at nothing. */
  _unpinMacro(id) {
    const at = this.data.macroPins.findIndex((p) => p.id === id);
    if (at >= 0) this.data.macroPins.splice(at, 1);
  }

  setMacroCategoryOrder(order) {
    this.data.macroCategoryOrder = (Array.isArray(order) ? order : [])
      .map((c) => String(c))
      .filter((c, i, a) => c && a.indexOf(c) === i);
    this.save();
    return this.data.macroCategoryOrder;
  }

  setMacroOrder(ids) {
    this.data.macroOrder = (Array.isArray(ids) ? ids : [])
      .map((id) => String(id))
      .filter((id, i, a) => id && a.indexOf(id) === i);
    this.save();
    return this.data.macroOrder;
  }

  upsertMacro(m) {
    const now = Date.now();
    if (m.id) {
      const i = this.data.macros.findIndex((x) => x.id === m.id);
      if (i >= 0) {
        this.data.macros[i] = { ...this.data.macros[i], ...m, updatedAt: now };
        this.save();
        return this.data.macros[i];
      }
    }
    const rec = {
      id: newId('m'),
      name: m.name || (m.command || '').split('\n')[0].slice(0, 40) || 'Macro',
      command: m.command || '',
      description: m.description || '',
      category: m.category || 'Custom',
      // Commands that restart things or delete things ask first.
      confirm: !!m.confirm,
      // Does not end on its own; only ever sent to a terminal.
      interactive: !!m.interactive,
      // Pasted at the prompt without a newline, to be finished by hand.
      noEnter: !!m.noEnter,
      /*
       * Where it can run: 'hosts', 'beams', 'local' or 'all'. Kept as written rather
       * than defaulted here — the renderer defaults a macro with no `where`
       * to 'all', which is what every macro saved before this field existed
       * was, and deciding it in two places would eventually disagree.
       */
      where: ['all', 'hosts', 'beams', 'local'].includes(m.where) ? m.where : 'all',
      /*
       * Blanks in the command, as `{{name}}`: `[{ name, default, choices }]`,
       * plus the text they were written as so the editor can show it back
       * exactly as typed.
       */
      variables: Array.isArray(m.variables) ? m.variables : [],
      variableSpec: m.variableSpec || '',
      // Seconds between automatic runs; 0 is the normal "run when asked".
      repeatSeconds: Math.max(0, Math.round(Number(m.repeatSeconds) || 0)),
      createdAt: now,
      updatedAt: now,
      useCount: 0,
    };
    this.data.macros.push(rec);
    this.save();
    return rec;
  }

  deleteMacro(id) {
    this.data.macros = this.data.macros.filter((x) => x.id !== id);
    this._unpinMacro(id);
    this.save();
  }

  /** Dismiss (or restore) one of the built-ins, which cannot be deleted. */
  setMacroHidden(id, hidden) {
    const set = new Set(this.data.hiddenMacros);
    hidden ? set.add(id) : set.delete(id);
    this.data.hiddenMacros = [...set];
    this.save();
    return this.data.hiddenMacros;
  }

  markMacroUsed(id) {
    const m = this.data.macros.find((x) => x.id === id);
    if (m) { m.useCount = (m.useCount || 0) + 1; m.lastUsed = Date.now(); this.save(); }
    return m || null;
  }

  /* ---------------- S3 buckets ---------------- */

  listS3Targets() { return this.data.s3Targets; }

  getS3Target(id) { return this.data.s3Targets.find((t) => t.id === id) || null; }

  upsertS3Target(t) {
    const now = Date.now();
    const i = t.id ? this.data.s3Targets.findIndex((x) => x.id === t.id) : -1;
    const rec = {
      id: t.id || newId('s3'),
      name: t.name || t.bucket || 'S3',
      bucket: t.bucket || '',
      region: t.region || '',
      prefix: t.prefix || '',
      endpoint: t.endpoint || '',
      pathStyle: !!t.pathStyle,
      defaultStorageClass: t.defaultStorageClass || 'STANDARD',
      credentials: t.credentials || { mode: 'env' },
      createdAt: i >= 0 ? this.data.s3Targets[i].createdAt : now,
      updatedAt: now,
    };
    if (i >= 0) this.data.s3Targets[i] = rec;
    else this.data.s3Targets.push(rec);
    this.save();
    this.emit('changed');
    return rec;
  }

  deleteS3Target(id) {
    this.data.s3Targets = this.data.s3Targets.filter((t) => t.id !== id);
    this.save();
    this.emit('changed');
  }

  /* ---------------- saved access requests ---------------- */
  // (helper lives at module scope, below the class)

  /**
   * Saved requests are scoped to the cluster they were built against: a
   * resource id embeds its cluster, so replaying one somewhere else would ask
   * for resources that do not exist there.
   */
  /* ---------------- downloads ---------------- */

  /**
   * Remember a completed download.
   *
   * Capped, because a folder of a thousand files is one gesture and this is a
   * list to be read: past the cap the oldest go. Re-downloading the same file
   * to the same place updates the existing row rather than stacking identical
   * ones, so the list stays a list of *files you have* rather than of attempts.
   */
  addDownload(rec) {
    const now = Date.now();
    const localPath = String(rec?.localPath || '');
    if (!localPath) return null;
    const match = this.data.downloads.findIndex((x) => x.localPath === localPath);
    if (match >= 0) {
      const merged = { ...this.data.downloads[match], ...rec, at: now };
      this.data.downloads.splice(match, 1);
      this.data.downloads.unshift(merged);
      this.save();
      return merged;
    }
    const row = {
      id: newId('dl'),
      localPath,
      name: rec.name || localPath.split(/[\\/]/).pop(),
      // Where it came from: a remote path, or an s3:// key.
      source: rec.source || '',
      from: rec.from || '',          // the host or bucket, as the UI labels it
      kind: rec.kind || 'file',      // 'file' | 'folder'
      bytes: Number(rec.bytes) || 0,
      files: Number(rec.files) || 1,
      at: now,
    };
    this.data.downloads.unshift(row);
    if (this.data.downloads.length > 300) this.data.downloads.length = 300;
    this.save();
    return row;
  }

  listDownloads() {
    return [...this.data.downloads].sort((a, b) => (b.at || 0) - (a.at || 0));
  }

  deleteDownload(id) {
    this.data.downloads = this.data.downloads.filter((x) => x.id !== id);
    this.save();
  }

  clearDownloads() {
    this.data.downloads = [];
    this.save();
  }

  /* ---------------- multi-exec history ---------------- */

  /**
   * Remember a run. The same command on the same hosts replaces its earlier
   * entry rather than filling the list with one command repeated.
   */
  addExecRun(rec) {
    const command = String(rec?.command || '').trim();
    if (!command) return null;
    const hostIds = Array.isArray(rec?.hostIds) ? rec.hostIds.filter(Boolean) : [];
    const key = command + '\u0000' + [...hostIds].sort().join(',');
    const row = {
      id: newId('mx'),
      command,
      label: String(rec?.label || ''),
      runAs: rec?.runAs || null,
      hosts: Array.isArray(rec?.hosts) ? rec.hosts.slice(0, 60) : [],
      hostIds: hostIds.slice(0, 60),
      // A tag run is defined by its query; the host list above is only the
      // set it matched at the time.
      selector: rec?.selector && typeof rec.selector === 'object'
        ? { proxy: rec.selector.proxy || '', query: String(rec.selector.query || '') }
        : null,
      ok: Number(rec?.ok) || 0,
      failed: Number(rec?.failed) || 0,
      at: Date.now(),
    };
    this.data.execRuns = this.data.execRuns
      .filter((x) => (x.command + '\u0000' + [...(x.hostIds || [])].sort().join(',')) !== key);
    this.data.execRuns.unshift(row);
    if (this.data.execRuns.length > 40) this.data.execRuns.length = 40;
    this.save();
    return row;
  }

  listExecRuns() { return [...this.data.execRuns]; }

  deleteExecRun(id) {
    this.data.execRuns = this.data.execRuns.filter((x) => x.id !== id);
    this.save();
  }

  clearExecRuns() { this.data.execRuns = []; this.save(); }

  /* ---------------- network tools ---------------- */

  listNetRequests() {
    return [...this.data.netRequests].sort((a, b) => (b.lastRunAt || b.savedAt || 0) - (a.lastRunAt || a.savedAt || 0));
  }

  /** Save (or update) a named request. */
  saveNetRequest(rec) {
    const id = rec?.id || newId('req');
    const row = {
      id,
      name: String(rec?.name || '').trim() || String(rec?.target || 'Request'),
      tool: rec?.tool || 'curl',
      target: String(rec?.target || ''),
      opts: rec?.opts && typeof rec.opts === 'object' ? rec.opts : {},
      /*
       * Which host it was run from, by host rather than by connection: an id
       * is gone by tomorrow, and "that request, from that server" is what was
       * saved. Null means this machine.
       */
      on: rec?.on && typeof rec.on === 'object'
        ? { hostId: rec.on.hostId || null, label: String(rec.on.label || ''), type: rec.on.type || 'ssh' }
        : null,
      savedAt: Date.now(),
      lastRunAt: rec?.lastRunAt || null,
    };
    const at = this.data.netRequests.findIndex((x) => x.id === id);
    if (at >= 0) row.savedAt = this.data.netRequests[at].savedAt || row.savedAt;
    if (at >= 0) this.data.netRequests[at] = row; else this.data.netRequests.push(row);
    this.save();
    return row;
  }

  deleteNetRequest(id) {
    this.data.netRequests = this.data.netRequests.filter((x) => x.id !== id);
    this.save();
  }

  /**
   * Remember a run. The same tool against the same target replaces its
   * previous entry rather than filling the list with one host.
   */
  addNetRun(rec) {
    const key = `${rec?.tool || ''}\u0000${rec?.target || ''}\u0000${rec?.on?.hostId || rec?.on?.label || ''}`;
    const row = {
      id: newId('run'),
      tool: rec?.tool || '',
      target: String(rec?.target || ''),
      opts: rec?.opts && typeof rec.opts === 'object' ? rec.opts : {},
      ok: rec?.ok !== false,
      summary: String(rec?.summary || '').slice(0, 160),
      on: rec?.on && typeof rec.on === 'object'
        ? { hostId: rec.on.hostId || null, label: String(rec.on.label || ''), type: rec.on.type || 'ssh' }
        : null,
      at: Date.now(),
    };
    this.data.netRuns = this.data.netRuns
      .filter((x) => `${x.tool || ''}\u0000${x.target || ''}\u0000${x.on?.hostId || x.on?.label || ''}` !== key);
    this.data.netRuns.unshift(row);
    if (this.data.netRuns.length > 25) this.data.netRuns.length = 25;
    this.save();
    return row;
  }

  listNetRuns() { return [...this.data.netRuns]; }

  clearNetRuns() { this.data.netRuns = []; this.save(); }

  /* ---------------- favourite port forwards ---------------- */

  listForwardFavorites() {
    return [...this.data.forwardFavorites];
  }

  /**
   * Keep a forward. An existing favourite for the same host and the same
   * listen port is updated rather than duplicated — starring the same tunnel
   * twice is the same intention said twice.
   */
  addForwardFavorite(rec) {
    const kind = ['L', 'R', 'D'].includes(rec?.kind) ? rec.kind : 'L';
    const bindPort = Number(rec?.bindPort) || 0;
    if (!bindPort) throw new Error('A favourite needs a listen port');
    const host = rec.host && typeof rec.host === 'object' ? rec.host : null;
    if (!host) throw new Error('A favourite needs the host to open it on');
    const row = {
      id: newId('fwd'),
      name: String(rec.name || '').trim(),
      kind,
      bindPort,
      bindAddr: String(rec.bindAddr || '').trim(),
      destHost: kind === 'D' ? '' : String(rec.destHost || '').trim(),
      destPort: kind === 'D' ? 0 : (Number(rec.destPort) || 0),
      host,
      login: rec.login || null,
      createdAt: Date.now(),
      lastUsedAt: null,
    };
    const at = this.data.forwardFavorites.findIndex((f) => f.host?.id === host.id
      && f.bindPort === row.bindPort && f.kind === row.kind);
    if (at >= 0) {
      row.id = this.data.forwardFavorites[at].id;
      row.createdAt = this.data.forwardFavorites[at].createdAt || row.createdAt;
      row.lastUsedAt = this.data.forwardFavorites[at].lastUsedAt || null;
      this.data.forwardFavorites[at] = row;
    } else {
      this.data.forwardFavorites.push(row);
    }
    this.save();
    return row;
  }

  updateForwardFavorite(id, patch) {
    const at = this.data.forwardFavorites.findIndex((f) => f.id === id);
    if (at < 0) return null;
    const row = { ...this.data.forwardFavorites[at], ...patch, id };
    this.data.forwardFavorites[at] = row;
    this.save();
    return row;
  }

  markForwardFavoriteUsed(id) {
    return this.updateForwardFavorite(id, { lastUsedAt: Date.now() });
  }

  deleteForwardFavorite(id) {
    this.data.forwardFavorites = this.data.forwardFavorites.filter((f) => f.id !== id);
    this.save();
  }

  /* ---------------- flagged sessions and notes ---------------- */

  listSessionNotes() {
    return [...this.data.sessionNotes]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /**
   * Flag a session, note it, or both.
   *
   * The session's own details are copied in beside the note — node, user,
   * when — because the point is to find it again later, and "later" may be
   * after the cluster has stopped listing it. A record with neither a flag
   * nor a note is deleted rather than kept as an empty row.
   */
  upsertSessionNote(rec) {
    const sid = String(rec?.sid || '');
    if (!sid) return null;
    const at = this.data.sessionNotes.findIndex((x) => x.sid === sid);
    const note = String(rec.note ?? (at >= 0 ? this.data.sessionNotes[at].note : '') ?? '');
    const flagged = rec.flagged === undefined
      ? (at >= 0 ? !!this.data.sessionNotes[at].flagged : false)
      : !!rec.flagged;

    if (!flagged && !note.trim()) {
      if (at >= 0) { this.data.sessionNotes.splice(at, 1); this.save(); }
      return null;
    }

    const base = at >= 0 ? this.data.sessionNotes[at] : { sid, createdAt: Date.now() };
    const next = {
      ...base,
      sid,
      flagged,
      note,
      cluster: rec.cluster ?? base.cluster ?? '',
      proxy: rec.proxy ?? base.proxy ?? '',
      home: rec.home ?? base.home ?? null,
      node: rec.node ?? base.node ?? '',
      user: rec.user ?? base.user ?? '',
      login: rec.login ?? base.login ?? '',
      startedAt: rec.startedAt ?? base.startedAt ?? null,
      durationMs: rec.durationMs ?? base.durationMs ?? null,
      playable: rec.playable ?? base.playable ?? true,
      updatedAt: Date.now(),
    };
    if (at >= 0) this.data.sessionNotes[at] = next;
    else this.data.sessionNotes.push(next);
    this.save();
    return next;
  }

  deleteSessionNote(sid) {
    this.data.sessionNotes = this.data.sessionNotes.filter((x) => x.sid !== sid);
    this.save();
    return this.listSessionNotes();
  }

  /* ---------------- saved cluster logins ---------------- */

  listTshLogins() {
    return [...this.data.tshLogins]
      .sort((a, b) => (b.lastUsed || b.updatedAt || 0) - (a.lastUsed || a.updatedAt || 0));
  }

  upsertTshLogin(t) {
    const now = Date.now();
    // One record per proxy-and-user: saving the same cluster twice is an
    // update, not a second entry to choose between.
    const match = t.id
      ? this.data.tshLogins.findIndex((x) => x.id === t.id)
      : this.data.tshLogins.findIndex((x) => x.proxy === t.proxy
          && (x.user || '') === (t.user || '')
          && (x.home || '') === (t.home || ''));
    if (match >= 0) {
      this.data.tshLogins[match] = { ...this.data.tshLogins[match], ...t, updatedAt: now };
      this.save();
      return this.data.tshLogins[match];
    }
    const rec = {
      id: newId('tl'),
      name: t.name || t.cluster || t.proxy || 'Cluster',
      proxy: t.proxy || '',
      cluster: t.cluster || '',
      user: t.user || '',
      authConnector: t.authConnector || '',
      // Which tsh home the certificate belongs in; '' is the default one.
      home: t.home || '',
      ttl: t.ttl || '',
      mfaMode: t.mfaMode || '',
      /*
       * Log this cluster in when the app starts, if its certificate has gone.
       *
       * Off unless asked for, per cluster rather than globally: a login can
       * open a browser for SSO and can prompt for a hardware key, and doing
       * that unbidden to four clusters at launch would be its own problem.
       */
      autoLogin: !!t.autoLogin,
      /*
       * Keep a group for it on the Hosts tab when `tsh status` no longer
       * lists it — after a logout, or before the first login — so its
       * watched hosts and its login buttons stay where they are looked for.
       */
      showInHosts: !!t.showInHosts,
      createdAt: now,
      updatedAt: now,
      lastUsed: 0,
      useCount: 0,
    };
    this.data.tshLogins.push(rec);
    this.save();
    return rec;
  }

  deleteTshLogin(id) {
    this.data.tshLogins = this.data.tshLogins.filter((x) => x.id !== id);
    this.save();
  }

  markTshLoginUsed(id) {
    const rec = this.data.tshLogins.find((x) => x.id === id);
    if (!rec) return null;
    rec.lastUsed = Date.now();
    rec.useCount = (rec.useCount || 0) + 1;
    this.save();
    return rec;
  }

  listRequestTemplates({ proxy, cluster } = {}) {
    let out = this.data.requestTemplates;
    if (proxy || cluster) {
      // Match on either key. A proxy is recorded with its port
      // ("corp.example.com:443") and that spelling can change between logins,
      // so the cluster name is the one that survives; keeping both means a
      // saved request is never orphaned by a re-login.
      out = out.filter((t) => (proxy && t.proxy === proxy) || (cluster && t.cluster === cluster));
    }
    return [...out].sort((a, b) => (b.lastUsed || b.updatedAt || 0) - (a.lastUsed || a.updatedAt || 0));
  }

  upsertRequestTemplate(t) {
    const now = Date.now();
    if (Array.isArray(t.resources)) t = { ...t, resources: trimRequestResources(t.resources) };
    if (t.id) {
      const i = this.data.requestTemplates.findIndex((x) => x.id === t.id);
      if (i >= 0) {
        this.data.requestTemplates[i] = { ...this.data.requestTemplates[i], ...t, updatedAt: now };
        this.save();
        return this.data.requestTemplates[i];
      }
    }
    const rec = {
      id: newId('rq'),
      name: t.name || 'Saved request',
      proxy: t.proxy || '',
      cluster: t.cluster || '',
      roles: Array.isArray(t.roles) ? t.roles : [],
      resources: trimRequestResources(t.resources),
      reason: t.reason || '',
      reviewers: Array.isArray(t.reviewers) ? t.reviewers : [],
      // Durations, not instants: a saved request is replayed later, so the
      // absolute times the original resolved to mean nothing second time round.
      requestTtl: t.requestTtl || '',
      maxDuration: t.maxDuration || '',
      sessionTtl: t.sessionTtl || '',
      createdAt: now,
      updatedAt: now,
      useCount: 0,
    };
    this.data.requestTemplates.push(rec);
    this.save();
    return rec;
  }

  deleteRequestTemplate(id) {
    this.data.requestTemplates = this.data.requestTemplates.filter((x) => x.id !== id);
    this.save();
  }

  markRequestTemplateUsed(id) {
    const t = this.data.requestTemplates.find((x) => x.id === id);
    if (t) { t.useCount = (t.useCount || 0) + 1; t.lastUsed = Date.now(); this.save(); }
    return t || null;
  }

  markSnippetUsed(id) {
    const s2 = this.data.snippets.find((x) => x.id === id);
    if (s2) { s2.useCount = (s2.useCount || 0) + 1; s2.lastUsed = Date.now(); this.save(); }
  }

  listFolders() { return this.data.folders; }

  upsertFolder(folder) {
    if (folder.id) {
      const i = this.data.folders.findIndex((f) => f.id === folder.id);
      if (i >= 0) {
        this.data.folders[i] = { ...this.data.folders[i], ...folder };
        this.save(); this.emit('changed');
        return this.data.folders[i];
      }
    }
    const rec = { id: newId('f'), name: folder.name || 'New folder', parentId: folder.parentId || null };
    this.data.folders.push(rec);
    this.save(); this.emit('changed');
    return rec;
  }

  deleteFolder(id) {
    this.data.folders = this.data.folders.filter((f) => f.id !== id);
    for (const p of this.data.profiles) if (p.folderId === id) p.folderId = null;
    this.save(); this.emit('changed');
  }
}

/**
 * Keep only what replaying a request needs: the id it is raised with, and the
 * name that makes the saved entry readable a month later. Labels are dropped —
 * they go stale (many are uptime counters) and nothing replays them.
 */
function trimRequestResources(resources) {
  return (Array.isArray(resources) ? resources : []).map((r) => ({
    id: r.id, kind: r.kind, name: r.name || '', cluster: r.cluster || '',
  })).filter((r) => r.id);
}

/**
 * The key a per-host preference is stored under.
 *
 * A Teleport node is keyed by its **uuid**: the hostname in the inventory is a
 * label that changes when the machine is renamed or rebuilt, and a preference
 * that evaporates on a rename is worse than no preference at all. Everything
 * else is keyed by its host id, which for an ssh_config host already includes
 * the alias and, for an extra config file, the file it came from.
 *
 * The renderer has the same function (sidebar.js) so the UI and the connection
 * agree on which key they are reading; if this changes, both change.
 */
function hostPrefKey(host) {
  if (!host) return '';
  if (host.uuid) return 'uuid:' + host.uuid;
  if (host.type === 'teleport' && host.name) return `tsh:${host.cluster || ''}:${host.name}`;
  return host.id || (host.alias ? 'ssh:' + host.alias : '');
}

/** The key a per-cluster preference is stored under: a proxy, or plain SSH. */
function clusterPrefKey(host) {
  if (!host) return '';
  if (host.type === 'teleport' || host.type === 'beam') return host.proxy || host.cluster || '';
  return 'ssh';
}

module.exports = { Store, DEFAULTS, hostPrefKey, clusterPrefKey };
