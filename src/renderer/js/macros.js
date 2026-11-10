import { state } from './state.js';
import { el } from './util.js';
import { modal, toast, status, confirm, field, textInput, select, checkbox, contextMenu } from './ui.js';

/**
 * Macros: commands you run *on a host*, rather than text you paste.
 *
 * Snippets already send text into a terminal. A macro is the same idea aimed
 * at a specific job — "is the agent running", "what is filling the disk" — so
 * it ships with a starter set, carries a description of what it answers, and
 * can be run without a terminal open by showing its output in a dialog.
 *
 * The built-ins live here rather than being seeded into the store, so they
 * improve between releases instead of freezing at whatever shipped first.
 */

export const BUILTIN_MACROS = [
  /* ---- Teleport ---- */
  {
    id: 'b:tp-status',
    category: 'Teleport',
    name: 'Teleport service status',
    description: 'Is the agent running, and since when.',
    command: 'sudo systemctl status teleport --no-pager || sudo service teleport status',
  },
  /*
   * Running is not the same as connected: the unit can be up for a week while
   * the agent has been failing to reach its proxy the whole time.
   */
  {
    id: 'b:tp-readyz',
    category: 'Teleport',
    name: 'Teleport agent health',
    description: 'Whether the agent is actually connected and ready, not just running. Newer agents only (the debug service).',
    command: 'sudo teleport debug readyz',
  },
  {
    id: 'b:tp-journal',
    category: 'Teleport',
    name: 'Follow Teleport logs',
    description: 'Live agent log. Ctrl-C to stop.',
    command: 'sudo journalctl -fu teleport',
    // Never useful headless: it does not end.
    interactive: true,
  },
  {
    id: 'b:tp-journal-recent',
    category: 'Teleport',
    name: 'Teleport errors, last hour',
    description: 'Recent agent problems without following the log.',
    command: 'sudo journalctl -u teleport --since "1 hour ago" -p warning --no-pager | tail -n 80',
  },
  // The next question when a node drops out of the cluster: can it get there?
  {
    id: 'b:tp-reach',
    category: 'Teleport',
    name: 'Can the agent reach its proxy?',
    description: 'Reads the proxy address from /etc/teleport.yaml and pings it: DNS, firewall and TLS in one go.',
    command: 'f=/etc/teleport.yaml; '
      + 'a=$(sudo awk \'/^[[:space:]]*(proxy_server|auth_server):/ { print $2; exit } '
      + '/^[[:space:]]*auth_servers:/ { getline; sub(/^[[:space:]]*-[[:space:]]*/, ""); print; exit }\' $f | tr -d \'"\'); '
      + 'echo "configured: ${a:-nothing found in $f}"; '
      + '[ -n "$a" ] && curl -sS --max-time 5 "https://$a/webapi/ping" | head -c 600; echo',
  },
  /*
   * Certificates carry a validity window, so a clock that has drifted reads
   * as "not yet valid" or "expired" — one of the commoner reasons a join or a
   * login fails, and nothing else on the list points at it.
   */
  {
    id: 'b:tp-clock',
    category: 'Teleport',
    name: 'Clock sync',
    description: 'Is this host\'s clock synchronised? Drift breaks certificate checks.',
    command: 'timedatectl 2>/dev/null || date -u',
  },
  {
    id: 'b:tp-version',
    category: 'Teleport',
    name: 'Teleport version',
    description: 'Agent build on this host.',
    command: 'teleport version; tsh version 2>/dev/null | head -1',
  },
  {
    id: 'b:tp-status-session',
    category: 'Teleport',
    name: 'Teleport session status',
    description: 'Who this host is logged in as: cluster, user, roles and how long the certificate lasts.',
    command: 'tsh status',
  },
  /*
   * The other side of the same question: not who the host is logged in as,
   * but what this session is — its id, the cluster and node it landed on,
   * and the address it came from. Only answers inside a Teleport SSH
   * session, which is where it is asked.
   */
  {
    id: 'b:tp-session-info',
    category: 'Teleport',
    name: 'Teleport ssh session status',
    description: 'This SSH session as Teleport sees it: session id, cluster, host UUID and where you connected from.',
    command: 'teleport status',
  },
  /*
   * The client commands, which run here rather than on a server.
   *
   * `tsh` is the thing on your own machine that talks to the cluster, so
   * these are marked for the local shell: `tsh ssh` typed into a session you
   * reached *with* `tsh ssh` is not the thing anyone means.
   */
  {
    id: 'b:tsh-ls',
    category: 'Teleport',
    name: 'tsh ls',
    description: 'Every node the current cluster will let you see, with its labels.',
    command: 'tsh ls',
    where: 'local',
  },
  {
    id: 'b:tsh-ssh',
    category: 'Teleport',
    name: 'tsh ssh…',
    description: 'Pasted at the prompt without Enter, to finish by hand: add `user@node`, '
      + 'then Enter. `tsh ssh --cluster=leaf user@node` for a leaf.',
    command: 'tsh ssh ',
    // The point is to finish the line yourself — the target is the part that
    // changes every time, and it is not worth a variable prompt to type it.
    noEnter: true,
    where: 'local',
  },
  {
    id: 'b:tsh-scp',
    category: 'Teleport',
    name: 'tsh scp…',
    description: 'Pasted without Enter, to finish by hand: `./file user@node:/tmp/`, '
      + 'or `-r` for a directory. Either side can be the remote one.',
    command: 'tsh scp ',
    noEnter: true,
    where: 'local',
  },
  /*
   * Headless auth has no persisted profile to fall back on — the whole
   * point is a one-off login approved from a second device — so `--proxy`
   * and `--user` are never optional the way they are for an ordinary `tsh
   * ssh` with a profile already active. Both are asked for explicitly
   * rather than guessed at.
   */
  {
    id: 'b:tsh-headless-ssh',
    category: 'Teleport',
    name: 'Headless SSH…',
    description: 'tsh ssh with no local session — approved from another device (tsh running there, or the web UI). '
      + 'For a CI box or a terminal with no browser of its own.',
    command: 'tsh ssh --headless --proxy={{proxy}} --user={{user}} {{host}}',
    variables: [
      // Not a fixed `choices` list (a bare dropdown would refuse a proxy or
      // user not already logged in from this machine) — suggested from
      // profiles already logged into here, but still freely typed.
      { name: 'proxy', choices: null, default: '', suggest: 'proxy' },
      { name: 'user', choices: null, default: '', suggest: 'user' },
      { name: 'host', choices: null, default: '' },
    ],
    where: 'local',
  },
  {
    id: 'b:tsh-headless-kube',
    category: 'Teleport',
    name: 'Headless kubectl…',
    description: 'Same headless login, for a Kubernetes cluster: approves from another device, then points kubectl at it.',
    command: 'tsh kube login --headless --proxy={{proxy}} --user={{user}} {{kubeCluster}} && kubectl get pods',
    variables: [
      { name: 'proxy', choices: null, default: '', suggest: 'proxy' },
      { name: 'user', choices: null, default: '', suggest: 'user' },
      { name: 'kubeCluster', choices: null, default: '' },
    ],
    where: 'local',
  },
  {
    id: 'b:tp-config',
    category: 'Teleport',
    name: 'Teleport config',
    description: 'The agent’s teleport.yaml.',
    command: 'sudo cat /etc/teleport.yaml',
  },
  {
    id: 'b:tp-restart',
    category: 'Teleport',
    name: 'Restart Teleport',
    description: 'Restarts the agent — drops this host’s tunnel briefly.',
    command: 'sudo systemctl restart teleport && sleep 2 && sudo systemctl status teleport --no-pager',
    confirm: true,
  },

  /*
   * ---- Kubernetes ----
   *
   * Only offered inside a kube exec session (macroKindOf reads
   * pane.kubeExec), and nothing else gets these: `kubectl` run from inside
   * the container it would be managing is not a thing anyone means, and a
   * container this minimal usually has no `kubectl` to run anyway. Every
   * command here is plain POSIX sh with a fallback chain — many images
   * ship nothing but BusyBox, some ship nothing but the application
   * itself, and a macro that only works on Debian answers for little of
   * what KubeLife actually connects to.
   */
  {
    id: 'b:kube-identity',
    category: 'Kubernetes',
    where: 'kube',
    name: 'Container identity',
    description: 'Hostname, OS, and architecture — what this container actually is.',
    command: 'hostname; echo; cat /etc/os-release 2>/dev/null || cat /etc/alpine-release 2>/dev/null '
      + '|| uname -a',
  },
  {
    id: 'b:kube-env',
    category: 'Kubernetes',
    where: 'kube',
    name: 'Environment variables',
    description: 'Everything the pod spec, ConfigMaps and Secrets injected — sorted.',
    command: 'env | sort',
  },
  {
    id: 'b:kube-serviceaccount',
    category: 'Kubernetes',
    where: 'kube',
    name: 'Service account',
    description: 'Whether this pod can talk to the Kubernetes API as itself, and as whom.',
    command: 'd=/var/run/secrets/kubernetes.io/serviceaccount; '
      + 'if [ -f "$d/token" ]; then echo "namespace: $(cat "$d/namespace" 2>/dev/null)"; '
      + 'echo "token: $(wc -c < "$d/token") bytes mounted"; else echo "No service account token mounted."; fi',
  },
  {
    id: 'b:kube-api-reach',
    category: 'Kubernetes',
    where: 'kube',
    name: 'Can this pod reach the API server?',
    description: 'Hits https://kubernetes.default.svc/healthz — DNS, network policy and RBAC all have to let this through.',
    command: 'curl -sS -k --max-time 5 https://kubernetes.default.svc/healthz 2>/dev/null '
      + '|| wget -q -O- --no-check-certificate --timeout=5 https://kubernetes.default.svc/healthz 2>/dev/null '
      + '|| echo "no curl or wget in this image"; echo',
  },
  {
    id: 'b:kube-dns',
    category: 'Kubernetes',
    where: 'kube',
    name: 'Cluster DNS',
    description: 'Resolves kubernetes.default — the first thing to doubt when a pod "can\'t reach" another service.',
    command: 'getent hosts kubernetes.default 2>/dev/null || nslookup kubernetes.default 2>/dev/null '
      + '|| echo "no getent or nslookup; resolv.conf:"; cat /etc/resolv.conf 2>/dev/null',
  },
  {
    id: 'b:kube-limits',
    category: 'Kubernetes',
    where: 'kube',
    name: 'Resource limits, from inside',
    description: 'The memory and CPU limits this container actually sees — cgroup v2 first, v1 fallback.',
    command: 'echo "memory.max: $(cat /sys/fs/cgroup/memory.max 2>/dev/null '
      + '|| cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null || echo unknown)"; '
      + 'echo "cpu.max: $(cat /sys/fs/cgroup/cpu.max 2>/dev/null '
      + '|| cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null || echo unknown)"',
  },
  {
    id: 'b:kube-mounts',
    category: 'Kubernetes',
    where: 'kube',
    name: 'Mounted volumes',
    description: 'What is actually mounted — ConfigMaps, Secrets, PVCs — with the container-runtime plumbing filtered out.',
    command: 'mount 2>/dev/null | grep -Ev "^(overlay|proc|tmpfs|shm|devpts|sysfs|cgroup|mqueue) " ; echo; df -h 2>/dev/null',
  },
  {
    id: 'b:kube-listening',
    category: 'Kubernetes',
    where: 'kube',
    name: 'Listening ports',
    description: 'What this container has bound, and on which interface.',
    command: 'ss -tulpn 2>/dev/null || netstat -tulpn 2>/dev/null '
      + '|| (echo "no ss or netstat; /proc/net/tcp:"; cat /proc/net/tcp 2>/dev/null)',
  },

  /* ---- System ---- */
  {
    id: 'b:disk',
    category: 'System',
    name: 'Disk usage',
    description: 'Filesystems, and inodes when a disk is "full" but is not.',
    command: 'df -h; echo; df -i | head -n 20',
    // df is df everywhere, so this one is useful in the local shell too.
    where: 'all',
  },
  {
    id: 'b:big-files',
    category: 'System',
    name: 'Largest directories in /var',
    description: 'What is filling the disk.',
    command: 'sudo du -xh /var --max-depth=2 2>/dev/null | sort -rh | head -n 20',
  },
  {
    id: 'b:memory',
    category: 'System',
    name: 'Memory and load',
    description: 'Free memory, swap, uptime and load average.',
    command: 'free -h; echo; uptime',
  },
  {
    id: 'b:top-procs',
    category: 'System',
    name: 'Top processes',
    description: 'The heaviest processes by memory, then CPU.',
    command: 'ps aux --sort=-%mem | head -n 12; echo; ps aux --sort=-%cpu | head -n 12',
  },
  {
    id: 'b:listening',
    category: 'System',
    name: 'Listening ports',
    description: 'What is bound, and which process owns it.',
    command: 'sudo ss -tulpn 2>/dev/null || sudo netstat -tulpn',
  },
  {
    id: 'b:errors',
    category: 'System',
    name: 'Recent system errors',
    description: 'Priority error and above from the journal.',
    command: 'sudo journalctl -p err -n 60 --no-pager',
  },
  {
    id: 'b:who',
    category: 'System',
    name: 'Who is logged in',
    description: 'Current sessions and recent logins.',
    command: 'who -a; echo; last -n 15',
  },
  {
    id: 'b:net',
    category: 'System',
    name: 'Network addresses and routes',
    description: 'Interfaces, addresses and the default route.',
    command: 'ip -brief address 2>/dev/null || ifconfig; echo; ip route 2>/dev/null || netstat -rn',
    // Already written to fall back to the BSD tools, so it answers on a Mac.
    where: 'all',
  },
  {
    id: 'b:os',
    category: 'System',
    name: 'OS and kernel',
    description: 'Distribution, kernel and architecture.',
    command: 'cat /etc/os-release 2>/dev/null | head -n 5; echo; uname -a',
    where: 'all',
  },
  {
    id: 'b:reboot',
    category: 'System',
    name: 'Pending reboot / updates',
    description: 'Whether the box is waiting on a restart.',
    command: '[ -f /var/run/reboot-required ] && cat /var/run/reboot-required || echo "no reboot required"; '
      + 'echo; (sudo needs-restarting -r 2>/dev/null || true)',
  },
  /* ---- Beams ---- */
  /*
   * For a beam — Teleport's sandbox VM — and offered only in a beam's
   * session. A beam runs its long-lived processes under `beamctl`, its own
   * service manager, rather than systemd; it can publish one app, on port
   * 8080; it reaches the cluster's LLM gateways through environment it is
   * given; and it comes with examples in ~/examples. Everything here is
   * what the beam's own motd and ~/AGENTS.md point at.
   */
  {
    id: 'b:beam-services', category: 'Beams', where: 'beams',
    name: 'Services (beamctl list)',
    description: 'The services beamctl is running in this beam, and their state.',
    // beamctl prints nothing at all with no services; say so.
    command: 'beamctl list | grep . || echo "(no services running under beamctl)"',
  },
  {
    id: 'b:beam-service-show', category: 'Beams', where: 'beams',
    name: 'Show a service',
    description: 'Everything beamctl knows about one service: its command, state and liveness.',
    command: 'beamctl show {{service}}',
  },
  {
    id: 'b:beam-service-logs', category: 'Beams', where: 'beams',
    name: 'Service logs',
    description: 'What a service has printed so far.',
    command: 'beamctl logs {{service}} | tail -n 200',
  },
  {
    id: 'b:beam-service-follow', category: 'Beams', where: 'beams',
    name: 'Follow service logs',
    description: 'A service\u2019s output as it happens. Ctrl-C to stop.',
    command: 'beamctl logs --follow {{service}}',
    interactive: true,
  },
  {
    id: 'b:beam-service-start', category: 'Beams', where: 'beams',
    name: 'Start a service on 8080',
    description: 'Run a command under beamctl as a named service — it keeps running after the session ends. 8080 is the port a beam can publish.',
    command: 'beamctl start --name {{service}} --liveness-port 8080 -- {{command}}',
    variables: [
      { name: 'service', choices: null, default: 'app' },
      { name: 'command', choices: null, default: 'python3 -m http.server 8080' },
    ],
    confirm: true,
  },
  {
    id: 'b:beam-service-restart', category: 'Beams', where: 'beams',
    name: 'Restart a service',
    description: 'Stop a service if it is running, and start it again.',
    command: 'beamctl restart {{service}}',
    confirm: true,
  },
  {
    id: 'b:beam-service-stop', category: 'Beams', where: 'beams',
    name: 'Stop a service',
    description: 'Stop one of the beam\u2019s services.',
    command: 'beamctl stop {{service}}',
    confirm: true,
  },
  {
    id: 'b:beam-service-remove', category: 'Beams', where: 'beams',
    name: 'Stop and remove a service',
    description: 'Stop it and take it off beamctl’s list, so it is not there to restart.',
    command: 'beamctl stop --prune {{service}}',
    confirm: true,
  },
  /*
   * Freezing pauses every process in the service where it stands, without
   * stopping it: memory and open connections are kept, and thawing carries on
   * from the same instruction. Cheaper than a restart for "hold that a moment".
   */
  {
    id: 'b:beam-service-freeze', category: 'Beams', where: 'beams',
    name: 'Freeze a service',
    description: 'Pause all of a service’s processes where they are, without stopping it.',
    command: 'beamctl freeze {{service}}',
    confirm: true,
  },
  {
    id: 'b:beam-service-thaw', category: 'Beams', where: 'beams',
    name: 'Thaw a service',
    description: 'Resume a frozen service from where it was paused.',
    command: 'beamctl thaw {{service}}',
  },
  {
    id: 'b:beam-service-attach', category: 'Beams', where: 'beams',
    name: 'Attach to a service',
    description: 'Its terminal, live — for a service started with --pty.',
    command: 'beamctl attach {{service}}',
    interactive: true,
  },
  {
    id: 'b:beam-service-wait', category: 'Beams', where: 'beams',
    name: 'Wait for a service state',
    description: 'Return once a service reaches a state — running after a start, stopped after a stop — or give up after the timeout.',
    command: 'beamctl wait --state {{state}} --timeout {{seconds}} {{service}}',
    variables: [
      { name: 'service', choices: null, default: 'app' },
      { name: 'state', choices: ['running', 'stopped', 'exited', 'frozen', 'stopping'], default: 'running' },
      { name: 'seconds', choices: null, default: '60' },
    ],
  },
  {
    id: 'b:beam-publish', category: 'Beams', where: 'beams',
    name: 'Publish the app on 8080',
    description: 'Make what listens on port 8080 a Teleport app — https://<name>.<cluster>. One app at a time.',
    command: 'tsh beams publish "$BEAM_ALIAS"',
    confirm: true,
  },
  {
    id: 'b:beam-publish-tcp', category: 'Beams', where: 'beams',
    name: 'Publish port 8080 as TCP',
    description: 'The same, for a TCP service rather than HTTP.',
    command: 'tsh beams publish --tcp "$BEAM_ALIAS"',
    confirm: true,
  },
  {
    id: 'b:beam-unpublish', category: 'Beams', where: 'beams',
    name: 'Unpublish the app',
    description: 'Take the published app down again; what listens on 8080 keeps running.',
    command: 'tsh beams unpublish "$BEAM_ALIAS"',
    confirm: true,
  },
  {
    id: 'b:beam-identity', category: 'Beams', where: 'beams',
    name: 'Who this beam is',
    description: 'Its alias, id, cluster and Teleport identity.',
    command: 'echo "beam:    $BEAM_ALIAS ($BEAM_ID)"; echo "cluster: $TELEPORT_CLUSTER"; echo; tsh status',
  },
  {
    id: 'b:beam-resources', category: 'Beams', where: 'beams',
    name: 'What it can reach',
    description: 'The apps, databases, GitHub orgs, SSH nodes and Kubernetes clusters this beam\u2019s identity is allowed.',
    command: 'echo "== apps"; tsh apps ls; echo; echo "== databases"; tsh db ls; echo; echo "== GitHub orgs"; tsh git ls 2>&1; '
      + 'echo; echo "== SSH nodes"; tsh ls; echo; echo "== Kubernetes"; tsh kube ls',
  },
  {
    id: 'b:beam-ai-env', category: 'Beams', where: 'beams',
    name: 'AI gateway settings',
    description: 'The Anthropic and OpenAI addresses this beam is given — the cluster\u2019s gateways, not the public APIs. Keys are hidden.',
    command: 'env | grep -E "^(ANTHROPIC|OPENAI)_" | sed -E "s/^([A-Z_]*(KEY|TOKEN))=.*/\\1=<set>/" | sort',
  },
  {
    id: 'b:beam-ai-hello', category: 'Beams', where: 'beams',
    name: 'Try the AI gateway',
    description: 'Runs the beam\u2019s own hello-world against Anthropic, through the gateway.',
    command: 'cd ~/examples && sh anthropic_hello.sh',
  },
  {
    id: 'b:beam-examples', category: 'Beams', where: 'beams',
    name: 'Examples and guide',
    description: 'What came with the beam: ~/AGENTS.md and the examples folder.',
    command: 'cat ~/AGENTS.md; echo; ls ~/examples',
  },
  /*
   * Inside a build beam — the console `tsh phase add` and `tsh phase edit`
   * open — where the beam's own tsh saves the image. Offered in every beam's
   * session; outside a build tsh says there is no build to save.
   */
  {
    id: 'b:beam-phase-add', category: 'Beams', where: 'beams',
    name: 'Start a new Phase build',
    description: 'tsh phase add: a new Phase, built in a console on a new build beam — install what it needs, then save and end the build.',
    command: 'tsh phase add {{name}}',
    variables: [{ name: 'name', choices: null, default: '' }],
    confirm: true,
    warning: 'This starts a new Phase build on the cluster: a build beam is created, and this terminal '
      + 'becomes its console until the build is saved and ended.',
  },
  {
    id: 'b:beam-phase-snapshot', category: 'Beams', where: 'beams',
    name: 'Save this build (Phase snapshot)',
    description: 'In a Phase build console: save the files so far to the Phase and keep working.',
    command: 'tsh phase snapshot',
  },
  {
    id: 'b:beam-phase-final', category: 'Beams', where: 'beams',
    name: 'Save and end this build',
    description: 'In a Phase build console: save the snapshot and end the build. Changes after it are discarded.',
    command: 'tsh phase snapshot --final',
    confirm: true,
    warning: 'This saves the snapshot and ends the build: the build console closes, and anything changed '
      + 'after this snapshot is discarded.',
  },
  {
    id: 'b:beam-phase-fork', category: 'Beams', where: 'beams',
    name: 'Fork this build into a new Phase',
    description: 'In a Phase build console: start a new Phase from this build beam\u2019s files as they are now.',
    command: 'tsh phase add {{name}} --fork',
    variables: [{ name: 'name', choices: null, default: '' }],
    confirm: true,
    warning: 'This creates a new Phase on the cluster from this build beam\u2019s files as they are now.',
  },
  {
    id: 'b:beam-version', category: 'Beams', where: 'beams',
    name: 'beamctl version',
    description: 'The beam\u2019s service manager and init, and the image it runs.',
    command: 'beamctl version; echo; . /etc/os-release && echo "$PRETTY_NAME"',
  },
  /*
   * `where` is left off above and filled in here: every built-in is aimed at a
   * server — systemd, journalctl, `ss -tulpn`, /etc/teleport.yaml — and none of
   * them means anything typed into a Mac's own shell. The handful that fall
   * back to something portable say so for themselves.
   */
].map((m) => ({ ...m, builtin: true, where: m.where || 'hosts' }));

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/** Built-ins the user has not dismissed, plus their own, newest use first. */
export async function loadMacros() {
  let saved = { macros: [], hidden: [], categoryOrder: [], pins: [] };
  try { saved = await window.api.macros.list(); } catch { /* no saved macros */ }
  const hidden = new Set(saved.hidden || []);
  const builtins = BUILTIN_MACROS.filter((m) => !hidden.has(m.id));
  const mine = (saved.macros || []).map((m) => ({ ...m, builtin: false }));
  state.macros = arranged([...builtins, ...mine], saved.order || []);
  state.macroOrder = saved.order || [];
  state.macroCategoryOrder = saved.categoryOrder || [];
  state.macroPins = saved.pins || [];
  state.emit('macros');
  return state.macros;
}

/* ------------------------------------------------------------------ */
/* Pinned macros: buttons in the session header                        */
/* ------------------------------------------------------------------ */

/**
 * Icons to choose from, with what each one is for.
 *
 * A pinned macro is a button you hit without reading, so the icon is the
 * whole label — which only works if the choice is quick. A curated set beats
 * an emoji keyboard for that, and anything not here can still be typed in.
 */
export const MACRO_ICONS = [
  ['▶', 'run'], ['⏱', 'timing'], ['\u{1F504}', 'restart'],
  ['\u{1F4CA}', 'stats'], ['\u{1F4C8}', 'load'], ['\u{1F4BE}', 'disk'],
  ['\u{1F4DC}', 'logs'], ['\u{1F50D}', 'inspect'], ['\u{1F9F9}', 'clean up'],
  ['\u{1F6A6}', 'status'], ['\u{1F525}', 'errors'], ['\u{1F514}', 'alerts'],
  ['\u{1F680}', 'deploy'], ['⚙', 'config'], ['\u{1F310}', 'network'],
  ['\u{1F512}', 'security'], ['\u{1F464}', 'who'], ['\u{1F4E6}', 'packages'],
  ['\u{1F433}', 'containers'], ['⚡', 'quick check'], ['❤', 'health'],
  ['\u{1F6D1}', 'stop'], ['♻', 'reload'], ['\u{1F4CB}', 'report'],
];

/** Where a pinned button is allowed to appear. */
export const PIN_SCOPES = [
  { value: 'all', label: 'Every session and the local shell' },
  { value: 'hosts', label: 'Host sessions only' },
  { value: 'beams', label: 'Beam sessions only' },
  { value: 'local', label: 'The local shell only' },
  { value: 'kube', label: 'Kubernetes exec sessions only' },
];

/**
 * Where a macro can be run at all — a property of the macro, not of its
 * button.
 *
 * `sudo journalctl -fu teleport` is not a thing you run on a Mac, and
 * `tsh status` is not a thing you run on the server; offering both everywhere
 * makes the menu longer and the wrong entries easier to hit. So every macro
 * says where it belongs, the ▶ menu shows only what fits the pane, and a pin
 * cannot put a button somewhere its macro would not run.
 *
 * The same three words as the pin scopes, deliberately: one vocabulary.
 */
export const RUN_SCOPES = [
  { value: 'all', label: 'Hosts and the local shell' },
  { value: 'hosts', label: 'Hosts only' },
  // A beam is a host too, so "hosts" macros run in one; these run nowhere else.
  { value: 'beams', label: 'Beams only' },
  { value: 'local', label: 'The local shell only' },
  // A kube exec session is 'local'-kind underneath (see macroKindOf) but
  // runs inside a container, not on this machine — kubectl/env/cgroup
  // checks belong here and nowhere else.
  { value: 'kube', label: 'Kubernetes exec sessions only' },
];

export function scopeLabel(where) {
  return (PIN_SCOPES.find((s) => s.value === (where || 'hosts')) || PIN_SCOPES[1]).label;
}

export function runScopeLabel(where) {
  return (RUN_SCOPES.find((s) => s.value === runScopeOf({ where })) || RUN_SCOPES[0]).label;
}

/**
 * A macro's run scope, with the default for one that does not carry it.
 *
 * `all`, because a macro saved before this existed was offered everywhere and
 * hiding it now would be a feature that takes something away. The built-ins
 * declare their own, since those are shipped data rather than someone's.
 */
export function runScopeOf(m) {
  return ['all', 'hosts', 'beams', 'local', 'kube'].includes(m?.where) ? m.where : 'all';
}

/**
 * Does this macro belong in a pane of this kind? `kind` is 'local', 'remote'
 * (a host), or 'beam' — a host that is also a beam, which takes the host
 * macros as well as its own.
 */
export function macroRunsOn(m, kind = 'remote') {
  const where = runScopeOf(m);
  if (where === 'all') return true;
  if (kind === 'local') return where === 'local';
  if (kind === 'kube') return where === 'kube';
  if (where === 'beams') return kind === 'beam';
  return where === 'hosts';
}

/** The kind of pane, as macros see it: 'local', 'beam', 'kube' or 'remote'. */
export function macroKindOf(pane) {
  if (!pane) return 'remote';
  // A kube exec pane is 'local'-kind underneath (kubepanel.js runs kubectl
  // the same way a local shell runs a program, with no Connection behind
  // it — see openPodExec) but its own macro set, not a local shell's.
  if (pane.kubeExec) return 'kube';
  if (pane.kind === 'local') return 'local';
  const conn = pane.connId ? state.getConnection(pane.connId) : null;
  return conn?.type === 'beam' ? 'beam' : 'remote';
}

/** The macros that can run in a pane of this kind, in the stored order. */
export function macrosFor(kind = 'remote', macros = state.macros || []) {
  return macros.filter((m) => macroRunsOn(m, kind));
}

/**
 * The pinned macros for one kind of pane, in button order.
 *
 * `kind` is 'remote' for a session on a host and 'local' for the local shell.
 * A pin with no scope is one saved before scopes existed, and keeps what it
 * did then: hosts only.
 */
export function pinnedMacros({ kind = 'remote' } = {}) {
  const byId = new Map((state.macros || []).map((m) => [m.id, m]));
  const wanted = kind === 'local' ? ['all', 'local']
    : kind === 'kube' ? ['all', 'kube']
      : kind === 'beam' ? ['all', 'hosts', 'beams'] : ['all', 'hosts'];
  return (state.macroPins || [])
    .filter((p) => wanted.includes(p.where || 'hosts'))
    .map((p) => {
      const macro = byId.get(p.id);
      // A pin whose macro is hidden or gone is simply not drawn; the pin is
      // left alone so restoring the macro brings its button back.
      if (!macro) return null;
      // And a button is never drawn where its macro would not run: the pin
      // scope narrows the macro's own scope, it cannot widen it.
      if (!macroRunsOn(macro, kind)) return null;
      return { macro, icon: p.icon || '▶', where: p.where || 'hosts' };
    })
    .filter(Boolean);
}

export function isPinned(id) {
  return (state.macroPins || []).some((p) => p.id === id);
}

/** The icon a macro is pinned with, or '' when it is not pinned at all. */
export function pinnedIconFor(id) {
  const pin = (state.macroPins || []).find((p) => p.id === id);
  return pin ? (pin.icon || '▶') : '';
}

/** Where a macro's button is shown, or '' when it is not pinned. */
export function pinnedScopeFor(id) {
  const pin = (state.macroPins || []).find((p) => p.id === id);
  return pin ? (pin.where || 'hosts') : '';
}

export async function setPinned(id, { pinned = true, icon = '', where } = {}) {
  state.macroPins = await window.api.macros.pin(id, { pinned, icon, where });
  state.emit('macros');
  return state.macroPins;
}

/**
 * Pick an icon for a macro about to be pinned.
 *
 * Offered rather than assumed: two buttons with the same glyph are worse than
 * no buttons, and the person pinning it is the only one who knows which of
 * their macros this is.
 */
export async function pinOptions({ icon: current = '', where = 'hosts', name = '', iconOnly = false } = {}) {
  const free = textInput({ value: current || '', placeholder: '▶', maxlength: '4' });
  free.style.width = '70px';
  free.style.textAlign = 'center';
  free.style.fontSize = '15px';

  let picked = current;
  const scopeSel = select(PIN_SCOPES, where || 'hosts');

  return modal({
    title: iconOnly ? 'Button icon' : 'Button on the session header',
    subtitle: name || undefined,
    width: 'min(520px, 94vw)',
    render: (body) => {
      const grid = el('div', { class: 'icon-grid' });
      const paint = () => {
        for (const b of grid.children) b.classList.toggle('on', b.textContent === picked);
        free.value = picked;
      };
      for (const [glyph, label] of MACRO_ICONS) {
        grid.append(el('button', {
          class: 'icon-choice' + (glyph === current ? ' on' : ''),
          title: label,
          text: glyph,
          // Choosing an icon no longer closes the dialog: there is a second
          // decision below it, and closing on the first would hide it.
          onClick: (e) => { e.preventDefault(); picked = glyph; paint(); },
        }));
      }
      free.addEventListener('input', () => { picked = free.value.trim(); paint(); });
      body.append(
        el('label', { style: 'font-size:11px;color:var(--muted);margin-bottom:5px;display:block', text: 'Icon' }),
        grid,
        field('Or type one', free,
          'Any character or emoji. It is the whole button, so one is plenty.'),
        // The editor carries its own scope control, so this dialog is then
        // only about the icon.
        iconOnly ? null : field('Show it on', scopeSel,
          'A macro that reads a server\u2019s journal has no business on a local prompt, '
          + 'and one that opens a local tool has none on a server.'));
      paint();
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Use this',
        class: 'primary-btn',
        onClick: ({ close }) => close({ icon: (picked || free.value.trim() || '▶'), where: scopeSel.value }),
      },
    ],
  });
}

/**
 * Pin or unpin from a menu, asking for an icon on the way in.
 *
 * Unpinning asks nothing: it is instantly reversible, and the button that was
 * just in the way is gone.
 */
export async function togglePin(m) {
  if (isPinned(m.id)) {
    await setPinned(m.id, { pinned: false });
    status(`Unpinned ${m.name}`);
    return;
  }
  const opts = await pinOptions({ name: m.name });
  if (!opts) return;
  await setPinned(m.id, { pinned: true, icon: opts.icon, where: opts.where });
  status(`${m.name} is now a button — ${scopeLabel(opts.where).toLowerCase()}`);
}

/**
 * Categories in the order the user has arranged them.
 *
 * A macro's category is free text, so the set grows as they write their own.
 * Anything not yet placed falls in behind what is — Teleport first, then
 * alphabetically — which means a new category appears somewhere sensible
 * without the saved order having to know about it.
 */
export function macroCategories(macros) {
  const byCat = new Map();
  for (const m of macros) {
    const key = m.category || 'Custom';
    if (!byCat.has(key)) byCat.set(key, []);
    byCat.get(key).push(m);
  }

  const order = state.macroCategoryOrder || [];
  const rank = (k) => {
    const i = order.indexOf(k);
    if (i >= 0) return i;
    // Unplaced: after everything arranged, keeping the original defaults.
    return order.length + (k === 'Teleport' ? 0 : k === 'Custom' ? 2 : 1);
  };
  return [...byCat.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Move a category one place up or down and remember it.
 *
 * The saved order is rewritten from what is on screen, so the first drag on an
 * untouched list pins every category where it already appeared rather than
 * reshuffling the ones the user did not touch.
 */
export async function moveCategory(name, delta) {
  const current = macroCategories(state.macros || []).map(([c]) => c);
  const from = current.indexOf(name);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= current.length) return false;
  current.splice(to, 0, current.splice(from, 1)[0]);
  state.macroCategoryOrder = await window.api.macros.setCategoryOrder(current);
  state.emit('macros');
  return true;
}

/**
 * Macros in the order they were dragged into. One not yet placed keeps its
 * default position behind the placed ones, so a new macro or a new built-in
 * turns up at the end of its category rather than reshuffling it.
 */
export function arranged(macros, order) {
  const at = new Map(order.map((id, i) => [id, i]));
  return macros
    .map((m, i) => ({ m, rank: at.has(m.id) ? at.get(m.id) : order.length + i }))
    .sort((a, b) => a.rank - b.rank)
    .map(({ m }) => m);
}

/**
 * Drop a macro before or after another, and remember it.
 *
 * Landing in another category moves it there: your own macro is saved with
 * the new category. A built-in's category is part of the shipped set, so it
 * only moves within its own.
 *
 * Like the category order, the saved order is rewritten from the whole list
 * as it now stands, so the first drag fixes everything where it already was.
 */
export async function moveMacro(id, targetId, { after = false } = {}) {
  const list = [...(state.macros || [])];
  const from = list.findIndex((m) => m.id === id);
  const target = list.find((m) => m.id === targetId);
  if (from < 0 || !target || id === targetId) return false;
  const moving = list[from];
  const category = target.category || 'Custom';
  if ((moving.category || 'Custom') !== category) {
    if (moving.builtin) {
      toast('A built-in macro stays in its own category — drag it within that group', 'error');
      return false;
    }
    const { builtin, ...saved } = moving;
    await window.api.macros.save({ ...saved, category });
  }
  list.splice(from, 1);
  const to = list.indexOf(target) + (after ? 1 : 0);
  list.splice(to, 0, moving);
  state.macroOrder = await window.api.macros.setOrder(list.map((m) => m.id));
  await loadMacros();
  return true;
}

/* ------------------------------------------------------------------ */
/* Running                                                             */
/* ------------------------------------------------------------------ */

async function allowed(m) {
  if (!m.confirm) return true;
  return confirm({
    title: m.name,
    // What running it costs, where the macro says: "Run this?" is no warning
    // for a command that ends a build and discards its changes.
    message: m.warning || 'Run this on the target host?',
    detail: m.command,
    confirmLabel: 'Run',
    danger: true,
  });
}

function markUsed(m) {
  if (!m.builtin) window.api.macros.markUsed(m.id).catch(() => {});
}

/** Type it into the focused terminal — the default, and the only way to follow a log. */
/* ------------------------------------------------------------------ */
/* Variables                                                           */
/* ------------------------------------------------------------------ */

/**
 * A macro can leave blanks: `{{service}}` in the command, filled in when it
 * runs.
 *
 * Without this, "restart a service" is either twenty near-identical macros or
 * a macro you edit by hand every time. A variable can carry a default, so the
 * common case stays one click, and it can carry a list of values, so the
 * choice is a menu rather than a typo waiting to happen. A variable with no
 * default is always asked for — which is the point of leaving it empty.
 */
const VAR_RE = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/**
 * The declaration block, one variable per line:
 *
 *   service = teleport
 *   level = info | warn | error
 *   lines =
 *
 * An `=` with nothing after it means "no default, ask me". A `|` list is a
 * choice; the first is the default unless one is marked with `*`.
 */
export function parseVarSpec(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    const name = (eq < 0 ? line : line.slice(0, eq)).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) continue;
    const rest = eq < 0 ? '' : line.slice(eq + 1).trim();
    if (rest.includes('|')) {
      const parts = rest.split('|').map((x) => x.trim()).filter(Boolean);
      // A starred entry is the default; otherwise the first one is.
      const starred = parts.find((x) => x.startsWith('*'));
      const choices = parts.map((x) => x.replace(/^\*/, '').trim());
      out.push({ name, choices, default: (starred || parts[0] || '').replace(/^\*/, '').trim() });
    } else {
      out.push({ name, choices: null, default: rest });
    }
  }
  return out;
}

export function renderVarSpec(vars) {
  return (vars || []).map((v) => {
    if (v.choices?.length) {
      return `${v.name} = ${v.choices.map((c) => (c === v.default ? '*' + c : c)).join(' | ')}`;
    }
    return `${v.name} = ${v.default || ''}`;
  }).join('\n');
}

/**
 * Every variable this macro needs: the declared ones first, then any
 * `{{placeholder}}` in the command that was never declared — which is treated
 * as a variable with no default rather than left in the command as literal
 * text.
 */
export function varsOf(m) {
  const declared = Array.isArray(m?.variables) ? m.variables : parseVarSpec(m?.variableSpec);
  const byName = new Map(declared.map((v) => [v.name, v]));
  const used = [];
  VAR_RE.lastIndex = 0;
  let match;
  while ((match = VAR_RE.exec(String(m?.command || ''))) !== null) {
    if (!used.includes(match[1])) used.push(match[1]);
  }
  const out = [];
  for (const name of used) out.push(byName.get(name) || { name, choices: null, default: '' });
  // A declared variable the command never mentions is not asked for.
  return out;
}

export function expandMacro(command, values) {
  return String(command || '').replace(VAR_RE, (whole, name) => (
    Object.prototype.hasOwnProperty.call(values || {}, name) ? values[name] : whole
  ));
}

/** Ask for the values. Returns null if the dialog was dismissed. */
/**
 * Suggestions for a variable the user must still be free to type past —
 * unlike `choices`, a fixed menu would refuse a proxy or user this machine
 * has not logged into yet, which is exactly the one most worth typing by
 * hand (a teammate's, or one about to be logged into for the first time).
 */
const SUGGEST_SOURCES = {
  proxy: () => [...new Set((state.teleportProfiles || []).map((p) => p.proxy).filter(Boolean))],
  user: () => [...new Set((state.teleportProfiles || []).map((p) => p.username).filter(Boolean))],
};

/** An `<input>` with a `<datalist>` of suggestions, each still freely overridable by typing. */
function suggestInput(value, placeholder, suggestions) {
  const id = 'macro-suggest-' + Math.random().toString(36).slice(2);
  const input = textInput({ value, placeholder, list: id });
  // Anywhere in the document works — a datalist has no visual position of
  // its own, only the `list`/`id` link to the input that uses it.
  input._datalist = el('datalist', { id }, ...suggestions.map((s) => el('option', { value: s })));
  return input;
}

export async function askMacroVars(m, vars) {
  const fields = [];
  const preview = el('div', {
    class: 'macro-preview',
    style: 'font-family:var(--mono);font-size:11.5px;white-space:pre-wrap;word-break:break-word;'
      + 'background:var(--panel-2);border:1px solid var(--border);border-radius:var(--radius);'
      + 'padding:8px 10px;margin-top:4px;color:var(--text-dim)',
  });

  for (const v of vars) {
    const suggestions = v.suggest && SUGGEST_SOURCES[v.suggest] ? SUGGEST_SOURCES[v.suggest]() : null;
    const input = v.choices?.length
      ? select(v.choices.map((c) => ({ value: c, label: c })), v.default || v.choices[0])
      : suggestions?.length
      ? suggestInput(v.default || '', 'value for ' + v.name, suggestions)
      : textInput({ value: v.default || '', placeholder: 'value for ' + v.name });
    fields.push({ v, input });
  }

  const values = () => {
    const out = {};
    for (const f of fields) out[f.v.name] = (f.input.value ?? '').trim();
    return out;
  };
  const syncPreview = () => { preview.textContent = expandMacro(m.command, values()); };
  for (const f of fields) {
    f.input.addEventListener('input', syncPreview);
    f.input.addEventListener('change', syncPreview);
  }

  const res = await modal({
    title: m.name,
    subtitle: vars.length === 1 ? 'One value to fill in' : `${vars.length} values to fill in`,
    render: (body) => {
      for (const f of fields) {
        body.append(field(f.v.name, f.input,
          f.v.choices?.length ? 'Pick one, or edit the macro to change the list'
            : f.input._datalist ? 'Pick a suggestion, or type any value'
            : undefined));
        if (f.input._datalist) body.append(f.input._datalist);
      }
      body.append(
        el('label', { style: 'font-size:11px;color:var(--muted);margin:10px 0 0;display:block', text: 'Command' }),
        preview);
      syncPreview();
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Run', class: 'primary-btn',
        onClick: ({ close }) => {
          const v = values();
          const missing = vars.filter((x) => !v[x.name]).map((x) => x.name);
          if (missing.length) return toast(`Still needed: ${missing.join(', ')}`, 'error');
          close(v);
        },
      },
    ],
  });
  return res || null;
}

/**
 * The macro as it will actually run.
 *
 * `ask` forces the dialog even when every blank has a default — which is what
 * the submenu entry is for. Without it, a macro whose variables all have
 * defaults runs on one click, and one with a blank still asks, because there
 * is nothing sensible to put there.
 */
export async function resolveMacro(m, { ask = false } = {}) {
  const vars = varsOf(m);
  if (!vars.length) return m;
  const needed = vars.some((v) => !v.default);
  if (!ask && !needed) {
    return { ...m, command: expandMacro(m.command, Object.fromEntries(vars.map((v) => [v.name, v.default]))) };
  }
  const values = await askMacroVars(m, vars);
  if (!values) return null;
  return { ...m, command: expandMacro(m.command, values) };
}

export async function sendMacro(m, { all = false } = {}) {
  const { sendToPane } = await import('./sessions.js');
  const targets = all
    ? state.panesOf(state.activeTabId).map((id) => state.getPane(id)).filter((p) => p && p.termId && p.kind === 'remote')
    : [state.activePane].filter((p) => p && p.termId);

  if (!targets.length) {
    return toast('Open a session first, or use “Run and show output”', 'error');
  }

  /*
   * A macro can reach a pane it is not meant for — the sidebar's double-click
   * sends to whatever is focused, and the focused thing may be the local
   * shell. Asked rather than refused: the scope is a default about where it
   * belongs, not a lock, and the person looking at the pane can see something
   * this code cannot.
   */
  const wrong = targets.filter((p) => !macroRunsOn(m, macroKindOf(p)));
  if (wrong.length && !await confirm({
    title: 'Run it here?',
    message: `“${m.name}” is set to run in ${runScopeLabel(runScopeOf(m)).toLowerCase()}.`,
    detail: wrong.length === targets.length
      ? `The focused pane is ${{ local: 'the local shell', beam: 'a beam session' }[macroKindOf(wrong[0])] || 'a host session'}.`
      : `${wrong.length} of ${targets.length} panes are not what it is set for.`,
    confirmLabel: 'Run it anyway',
  })) return;

  const filled = await resolveMacro(m);
  if (!filled) return;
  m = filled;
  if (!await allowed(m)) return;

  // Normally the newline is the point — the macro runs. A macro marked
  // `noEnter` is one you mean to finish by hand, so it is left on the prompt.
  // A macro with an interval of its own starts ticking rather than running once.
  if (m.repeatSeconds > 0 && !m.interactive && !m.noEnter) {
    for (const p of targets) await startRepeat(m, m.repeatSeconds, p.id);
    return;
  }

  const text = m.noEnter ? m.command.replace(/\n+$/, '') : m.command.replace(/\n*$/, '\n');
  for (const p of targets) sendToPane(p, text);
  markUsed(m);
  status(m.noEnter
    ? `${m.name} → ${targets.length} pane${targets.length === 1 ? '' : 's'} — press Enter to run`
    : `${m.name} → ${targets.length} pane${targets.length === 1 ? '' : 's'}`);
}

/* ------------------------------------------------------------------ */
/* Repeating                                                           */
/* ------------------------------------------------------------------ */

/**
 * Macros that finish can be put on a timer: watch a queue drain, keep an eye
 * on load, poll a service coming back up. Only commands that end are eligible
 * — repeating something that follows a log would stack up followers, and one
 * left at the prompt has not run at all.
 *
 * A repeat belongs to a pane, not to the macro: the same macro can tick on two
 * hosts at once, and closing a pane takes its repeats with it.
 */
const repeats = new Map();   // `${paneId}:${macroId}` -> { timer, macro, paneId, since, runs }

const repeatKey = (paneId, macroId) => `${paneId}:${macroId}`;

export function repeatsOnPane(paneId) {
  return [...repeats.values()].filter((r) => r.paneId === paneId);
}

export function isRepeating(paneId, macroId) {
  return repeats.has(repeatKey(paneId, macroId));
}

/** Seconds as a human would say them: 45s, 2m, 1h 30m. */
export function fmtEvery(seconds) {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return s % 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s / 60}m`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

export async function startRepeat(m, seconds, paneId = state.activePaneId) {
  const pane = state.getPane(paneId);
  if (!pane || !pane.termId) return toast('Open a session first', 'error');
  if (m.interactive) return toast(`“${m.name}” follows a log — it cannot repeat`, 'error');
  if (m.noEnter) return toast(`“${m.name}” is left at the prompt — it cannot repeat`, 'error');

  const every = Math.max(1, Math.round(Number(seconds) || 0));
  if (!every) return toast('Give an interval', 'error');
  if (!await allowed(m)) return;

  stopRepeat(paneId, m.id);
  const { sendToPane } = await import('./sessions.js');
  const text = m.command.replace(/\n*$/, '\n');

  const rec = { macro: m, paneId, every, since: Date.now(), runs: 0, timer: null };
  const tick = () => {
    const p = state.getPane(paneId);
    // The pane went away, or its shell did: stop rather than write into nothing.
    if (!p || !p.termId) return stopRepeat(paneId, m.id);
    sendToPane(p, text);
    rec.runs++;
    state.emit('macro-repeats', rec);
  };
  tick();
  rec.timer = setInterval(tick, every * 1000);
  repeats.set(repeatKey(paneId, m.id), rec);
  markUsed(m);
  state.emit('macro-repeats', rec);
  status(`${m.name} every ${fmtEvery(every)} on ${pane.head?.querySelector('.pname')?.textContent || 'this pane'}`);
  return rec;
}

export function stopRepeat(paneId, macroId) {
  const key = repeatKey(paneId, macroId);
  const rec = repeats.get(key);
  if (!rec) return false;
  clearInterval(rec.timer);
  repeats.delete(key);
  state.emit('macro-repeats', rec);
  return true;
}

/** Everything a pane had on a timer — called when the pane closes. */
export function stopRepeatsForPane(paneId) {
  let n = 0;
  for (const [key, rec] of [...repeats]) {
    if (rec.paneId !== paneId) continue;
    clearInterval(rec.timer);
    repeats.delete(key);
    n++;
  }
  if (n) state.emit('macro-repeats', null);
  return n;
}

/** Ask for an interval, then start one. */
export async function promptRepeat(m, paneId = state.activePaneId) {
  const amount = textInput({ value: String(m.repeatSeconds && m.repeatSeconds % 60 === 0 ? m.repeatSeconds / 60 : m.repeatSeconds || 30), autofocus: true });
  amount.type = 'number';
  amount.min = '1';
  amount.style.width = '90px';
  const unit = select([
    { value: 'seconds', label: 'seconds' },
    { value: 'minutes', label: 'minutes' },
  ], m.repeatSeconds && m.repeatSeconds % 60 === 0 ? 'minutes' : 'seconds');

  const secs = await modal({
    title: `Repeat “${m.name}”`,
    render: (body) => {
      body.append(
        el('div', { style: 'font-size:12.5px;margin-bottom:10px', text: 'It is typed into this pane on every tick, so pick something slower than the command takes.' }),
        field('Run it every', el('div', { style: 'display:flex;gap:8px;align-items:center' }, amount, unit)));
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Start', class: 'primary-btn',
        onClick: ({ close }) => {
          const n = Number(amount.value);
          if (!n || n < 1) return toast('Give an interval', 'error');
          close(unit.value === 'minutes' ? n * 60 : n);
        },
      },
    ],
  });
  if (!secs) return null;
  return startRepeat(m, secs, paneId);
}

/**
 * Run without a terminal and show what came back. Refuses the macros that
 * never finish, since a headless exec would simply hang until its timeout.
 */
export async function runMacroOnHost(m, host, login) {
  if (m.interactive) {
    return toast(`“${m.name}” follows a log — send it to a terminal instead`, 'error');
  }
  // Running it headless is precisely the thing this macro asked not to happen.
  if (m.noEnter) {
    return toast(`“${m.name}” is meant to be edited before running — send it to a terminal`, 'error');
  }
  /*
   * This path is a host by definition — it is reached by picking one — so a
   * macro set for the local shell is being sent somewhere it does not belong.
   * Asked rather than refused, the same as sending one to the wrong pane: the
   * scope is a default about where a macro lives, not a lock.
   */
  if (!macroRunsOn(m, 'remote') && !await confirm({
    title: 'Run it on a host?',
    message: `“${m.name}” is set to run in ${runScopeLabel(runScopeOf(m)).toLowerCase()}.`,
    detail: 'It is about to run on a server instead.',
    confirmLabel: 'Run it anyway',
  })) return;
  const filled = await resolveMacro(m);
  if (!filled) return;
  m = filled;
  if (!await allowed(m)) return;
  const { openRunCommandDialog } = await import('./hostactions.js');
  markUsed(m);
  return openRunCommandDialog(host, { login, command: m.command, title: m.name });
}

/** The host behind the focused pane, when there is one. */
export function activeHost() {
  const conn = state.activeConnId ? state.getConnection(state.activeConnId) : null;
  if (!conn) return null;
  return { id: conn.hostId, label: conn.label, user: conn.user, hostname: conn.hostname };
}

/* ------------------------------------------------------------------ */
/* Quick picker                                                        */
/* ------------------------------------------------------------------ */

/**
 * The macro list as a dropdown under a button, grouped by category.
 *
 * A menu rather than a dialog: this is picking one of a short list to run on
 * the host already in front of you, not a search across everything, and a
 * modal for that is one keystroke and one dismissal too many.
 */
export function openMacroMenu(anchor, { onPick, kind } = {}) {
  /*
   * Only what can run where this menu was opened.
   *
   * `kind` comes from the pane; when the menu is being used to *pick* a macro
   * for something else — multi-exec, a pin — there is no pane, and everything
   * is offered because the caller decides where it goes.
   */
  const paneKind = kind || (onPick ? null : 'remote');
  const all = state.macros || [];
  const macros = paneKind ? macrosFor(paneKind, all) : all;
  if (!macros.length) {
    return toast(all.length
      ? `None of your macros are set to run in ${paneKind === 'local' ? 'the local shell' : 'host sessions'} — `
        + 'change that under Saved → Macros'
      : 'No macros yet — add one under Saved → Macros', 'error');
  }

  const paneId = state.activePaneId;
  const items = [];

  // Anything already on a timer here goes first, because the reason to open
  // this menu while something is ticking is usually to stop it.
  const running = repeatsOnPane(paneId);
  if (running.length && !onPick) {
    items.push({ label: 'Repeating here', heading: true });
    for (const r of running) {
      items.push({
        label: `Stop “${r.macro.name}”`,
        key: 'every ' + fmtEvery(r.every),
        title: `${r.runs} run(s) since ${new Date(r.since).toLocaleTimeString()}`,
        onClick: () => {
          stopRepeat(r.paneId, r.macro.id);
          status(`Stopped ${r.macro.name}`);
        },
      });
    }
  }

  // In a beam its own macros come first: they are why it is a beam.
  const cats = macroCategories(macros);
  const ordered = paneKind === 'beam'
    ? [...cats.filter(([c]) => c === 'Beams'), ...cats.filter(([c]) => c !== 'Beams')]
    : cats;
  const sections = [];
  for (const [category, group] of ordered) {
    const entries = [];
    sections.push({ category, entries });
    for (const m of group) {
      const canRepeat = !m.interactive && !m.noEnter;
      const ticking = isRepeating(paneId, m.id);
      entries.push({
        label: m.name,
        key: [
          m.confirm ? 'careful' : '',
          m.noEnter ? 'edit first' : '',
          ticking ? 'running' : (m.repeatSeconds ? 'every ' + fmtEvery(m.repeatSeconds) : ''),
        ].filter(Boolean).join(' · '),
        title: `${m.description ? m.description + '\n\n' : ''}${m.command}`
          + (m.noEnter ? '\n\n(pasted without pressing Enter)' : ''),
        /*
         * What this macro is for, on a mark of its own. A macro's name is
         * short by design — "Disk usage", "Follow the agent log" — and the
         * sentence explaining which question it answers is the thing worth
         * reading before running something on a server.
         */
        help: {
          // What question it answers, then the command that answers it.
          answers: m.description || '',
          command: m.command,
          notes: [
            m.confirm ? 'Asks before running: it changes something.' : '',
            m.interactive ? 'Does not finish on its own — follows a log.' : '',
            m.noEnter ? 'Pasted at the prompt without Enter, to finish by hand.' : '',
            varsOf(m).length ? 'Fills in: ' + varsOf(m).map((v) => v.name).join(', ') : '',
          ].filter(Boolean),
        },
        onClick: () => (onPick ? onPick(m) : sendMacro(m)),
        // Repeating is a second thing to do with the same macro, so it hangs
        // off it rather than doubling the length of the list.
        // Repeating is a second thing to do with the same macro, and filling
        // in its blanks is a third; both hang off the macro rather than
        // doubling the length of the list.
        submenu: onPick ? null : [
          { label: 'Run once (default)', onClick: () => sendMacro({ ...m, repeatSeconds: 0 }) },
          ...(canRepeat ? [ticking
            ? { label: 'Stop repeating', onClick: () => { stopRepeat(paneId, m.id); status(`Stopped ${m.name}`); } }
            : { label: 'Repeat every…', onClick: () => promptRepeat(m, paneId) }] : []),
          ...(varsOf(m).length ? [
            { sep: true },
            {
              label: 'Fill in variables\u2026',
              key: varsOf(m).map((v) => v.name).join(', '),
              title: 'Confirm or change every value before it runs',
              onClick: async () => {
                const filled = await resolveMacro(m, { ask: true });
                if (filled) sendMacro({ ...filled, repeatSeconds: 0 });
              },
            },
          ] : []),
        ],
      });
    }
  }

  /*
   * Writing one, at the end.
   *
   * The moment you want a macro is the moment you have just typed the command
   * for the third time — and you are looking at this menu, not at the Saved
   * tab. The command in hand is offered as the starting point, so "I keep
   * running this" becomes a macro without retyping it.
   *
   * Not offered when the menu is being used to *pick* a macro for something
   * else (multi-exec, a pin), where a half-written macro is not an answer.
   */
  const tail = [];
  if (!onPick) {
    tail.push({ sep: true });
    tail.push({
      label: 'New macro\u2026', icon: '\u002B',
      title: 'Write one, and it appears in this menu on every host',
      onClick: async () => {
        // Where it was written is the best guess at where it belongs, and the
        // editor shows the control so a wrong guess is one click to fix.
        const saved = await editMacro({ category: 'Custom', where: paneKind === 'local' ? 'local' : 'hosts' });
        if (saved) status(`Saved ${saved.name || 'macro'} \u2014 it is in this menu now`);
      },
    });
    // Or show it: run the commands as usual and they become the macro.
    const pane = state.activePane;
    if (pane?.termId && pane.kind !== 'vnc' && pane.kind !== 'device') {
      tail.push(pane.recorder ? {
        label: `Stop recording (${pane.recorder.steps.length})\u2026`, icon: '\u25CF',
        onClick: async () => (await import('./macrorecord.js')).stopRecording(pane),
      } : {
        label: 'Record a macro', icon: '\u25CF',
        title: 'Run the commands here as usual; when you stop, they become a macro',
        onClick: async () => (await import('./macrorecord.js')).startRecording(pane),
      });
    }
    tail.push({
      label: 'Manage macros\u2026',
      title: 'The full list, including the built-in ones',
      onClick: () => openMacroManager(),
    });
  }

  /*
   * Listed down, folding only what does not fit.
   *
   * Built-ins and your own together can run past the height of a laptop
   * screen, and a menu taller than the window had its top pushed off the
   * edge — the first category simply could not be reached. Folding every
   * category into a submenu fixed that and cost the quick glance down the
   * list everywhere else, so it is done one category at a time, largest
   * first, and only until the rest fits: a tall window shows everything, a
   * short one folds the long categories and keeps the short ones open. If
   * even fully folded it is too tall, it scrolls (see .ctxmenu in styles.css).
   */
  const layout = (folded) => [
    ...items,
    ...sections.flatMap(({ category, entries }, i) => {
      const fold = folded.has(category);
      // No rule between two folded rows: together they read as one list of sections.
      const rule = (i || items.length) && !(fold && i && folded.has(sections[i - 1].category));
      return [
        ...(rule ? [{ sep: true }] : []),
        ...(fold
          ? [{ label: category, key: String(entries.length), submenu: entries }]
          : [{ label: category, heading: true }, ...entries]),
      ];
    }),
    ...tail,
  ];

  const r = anchor.getBoundingClientRect();
  const room = window.innerHeight - 16;
  const folded = new Set();
  let menu = contextMenu(r.left, r.bottom + 2, layout(folded));
  for (const { category } of [...sections].sort((x, y) => y.entries.length - x.entries.length)) {
    if (menu.scrollHeight <= room) break;
    folded.add(category);
    menu = contextMenu(r.left, r.bottom + 2, layout(folded));
  }
  // The button sits at the right edge of the pane, so hang the menu from that
  // edge rather than letting it run off and be clamped back.
  const width = menu.offsetWidth;
  menu.style.left = `${Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))}px`;
  return menu;
}

/** Show the full macro list: the sidebar's Saved tab, on its Macros view. */
export function openMacroManager() {
  document.querySelector('.sb-tab[data-tab="saved"]')?.click();
  document.querySelector('.sb-subtab[data-saved="macros"]')?.click();
}

/* ------------------------------------------------------------------ */
/* Editing                                                             */
/* ------------------------------------------------------------------ */

export async function editMacro(initial = {}) {
  const nameIn = textInput({ value: initial.name || '', placeholder: 'Teleport service status', autofocus: true });
  const descIn = textInput({ value: initial.description || '', placeholder: 'What question does this answer?' });
  const catIn = textInput({ value: initial.category || 'Custom', placeholder: 'Teleport, System, Custom…' });
  catIn.setAttribute('list', 'macro-categories');
  const cmdIn = el('textarea', {
    class: 'macro-cmd', rows: '6', spellcheck: 'false',
    placeholder: 'sudo systemctl status teleport --no-pager',
  });
  cmdIn.value = initial.command || '';
  const confirmIn = checkbox('Ask before running — this changes something', initial.confirm);
  const interactiveIn = checkbox('Does not finish on its own (follows a log)', initial.interactive);
  const noEnterIn = checkbox('Paste it without pressing Enter, to finish by hand', initial.noEnter);

  /*
   * Where this macro can run at all.
   *
   * `systemctl` is not a thing on a Mac and `brew` is not a thing on the
   * server, so a macro that is offered in both places is one you will
   * eventually run in the wrong one. This is the macro's own property: the ▶
   * menu shows only what fits the pane it was opened from, and a pinned button
   * cannot appear where its macro would not run.
   */
  const runWhereSel = select(RUN_SCOPES, runScopeOf(initial));

  /*
   * Pinning, with its icon, sits in the editor as well as on the menus: when
   * you are writing the macro is when you know whether it is one of the two
   * or three worth a permanent button.
   */
  let pinIcon = initial.id ? (pinnedIconFor(initial.id) || '') : '';
  let pinWhere = (initial.id && pinnedScopeFor(initial.id)) || 'hosts';
  const pinIn = checkbox('Pin as a button on the session header', !!pinIcon);
  /*
   * The scope is a control here, not a second dialog.
   *
   * "Change this macro to local only" is one decision and belongs in front of
   * whoever is editing the macro — behind the icon button it was two clicks
   * and a guess that the icon was where scope lived.
   */
  const scopeSel = select(PIN_SCOPES, pinWhere);
  scopeSel.addEventListener('change', () => { pinWhere = scopeSel.value; });
  const iconBtn = el('button', {
    class: 'ghost-btn sm', text: pinIcon || 'Choose an icon…',
    style: pinIcon ? 'font-size:15px;min-width:38px' : '',
    onClick: async (e) => {
      e.preventDefault();
      const next = await pinOptions({
        icon: pinIcon, where: pinWhere, name: nameIn.value.trim(), iconOnly: true,
      });
      if (!next) return;
      pinIcon = next.icon;
      iconBtn.textContent = next.icon;
      iconBtn.style.cssText = 'font-size:15px;min-width:38px';
      pinIn.input.checked = true;
      syncPin();
    },
  });
  const pinRow = el('div', { style: 'display:flex;gap:8px;align-items:center;margin:4px 0 12px 22px' },
    el('span', { style: 'font-size:12px;color:var(--muted)', text: 'Button:' }),
    iconBtn,
    el('span', { style: 'font-size:12px;color:var(--muted)', text: 'shown on' }),
    scopeSel);
  const syncPin = () => {
    pinRow.style.display = pinIn.input.checked ? 'flex' : 'none';
    /*
     * The button cannot be shown where the macro would not run, so the run
     * scope closes off the pin scopes it contradicts and drags the selection
     * with it. Otherwise the dialog would accept "hosts only, button
     * everywhere", which draws nothing in the local shell and looks broken.
     */
    const run = runWhereSel.value;
    for (const opt of [...scopeSel.options]) {
      const impossible = run !== 'all' && opt.value !== run;
      opt.disabled = impossible;
      if (impossible && pinWhere === opt.value) pinWhere = run;
    }
    if (scopeSel.value !== pinWhere) scopeSel.value = pinWhere;
  };
  runWhereSel.addEventListener('change', syncPin);
  pinIn.input.addEventListener('change', () => {
    if (pinIn.input.checked && !pinIcon) pinIcon = '\u25B6';
    if (pinIcon && iconBtn.textContent !== pinIcon) {
      iconBtn.textContent = pinIcon;
      iconBtn.style.cssText = 'font-size:15px;min-width:38px';
    }
    syncPin();
  });
  syncPin();

  // Repeating only makes sense for a command that ends — the two checkboxes
  // above describe the two kinds that do not, so the field follows them.
  const everyIn = textInput({ value: String(initial.repeatSeconds ? (initial.repeatSeconds % 60 === 0 ? initial.repeatSeconds / 60 : initial.repeatSeconds) : ''), placeholder: 'off' });
  everyIn.type = 'number';
  everyIn.min = '1';
  everyIn.style.width = '90px';
  const everyUnit = select([
    { value: 'seconds', label: 'seconds' },
    { value: 'minutes', label: 'minutes' },
  ], initial.repeatSeconds && initial.repeatSeconds % 60 === 0 ? 'minutes' : 'seconds');
  const everyRow = field('Repeat automatically', el('div', { style: 'display:flex;gap:8px;align-items:center' },
    el('span', { style: 'font-size:12.5px;color:var(--muted)', text: 'every' }), everyIn, everyUnit),
    'Leave blank to run once. A repeating macro keeps typing itself into the session until you stop it.');
  const syncEvery = () => {
    const off = interactiveIn.input.checked || noEnterIn.input.checked;
    everyIn.disabled = off;
    everyUnit.disabled = off;
    everyRow.style.opacity = off ? '.5' : '';
  };
  interactiveIn.input.addEventListener('change', syncEvery);
  noEnterIn.input.addEventListener('change', syncEvery);
  syncEvery();

  /*
   * The blanks, declared here and referenced as {{name}} in the command.
   *
   * A textarea rather than a row-builder: three lines of `name = default` is
   * quicker to write and to read than three rows of two inputs, and the syntax
   * is the whole feature.
   */
  const varsIn = el('textarea', {
    class: 'macro-cmd', rows: '3', spellcheck: 'false',
    placeholder: 'service = teleport\nlevel = info | warn | error\nlines =',
  });
  varsIn.value = initial.variableSpec || renderVarSpec(initial.variables);
  const varsNote = el('div', { class: 'hint', style: 'margin-top:5px' });
  const syncVars = () => {
    const declared = parseVarSpec(varsIn.value);
    const used = varsOf({ command: cmdIn.value, variables: declared });
    const undeclared = used.filter((u) => !declared.some((d) => d.name === u.name)).map((u) => u.name);
    const unused = declared.filter((d) => !used.some((u) => u.name === d.name)).map((d) => d.name);
    varsNote.textContent = [
      used.length
        ? `Will ask for: ${used.filter((u) => !u.default).map((u) => u.name).join(', ') || 'nothing — every blank has a default'}`
        : 'No {{blanks}} in the command yet.',
      undeclared.length ? `Used but not declared (no default, so always asked): ${undeclared.join(', ')}` : '',
      unused.length ? `Declared but not used: ${unused.join(', ')}` : '',
    ].filter(Boolean).join('  ·  ');
  };
  varsIn.addEventListener('input', syncVars);
  cmdIn.addEventListener('input', syncVars);

  const cats = el('datalist', { id: 'macro-categories' });
  for (const c of new Set([...BUILTIN_MACROS.map((m) => m.category), 'Custom'])) {
    cats.append(el('option', { value: c }));
  }

  const res = await modal({
    title: initial.id && !initial.builtin ? 'Edit macro' : 'New macro',
    width: 'min(620px, 94vw)',
    render: (body) => {
      body.append(
        field('Name', nameIn),
        field('What it answers', descIn),
        field('Category', catIn),
        cats,
        field('Command', cmdIn, 'Runs through the login shell of wherever it is sent. Write {{name}} for a blank to fill in.'),
        field('Where it can run', runWhereSel,
          'Which panes offer it. A server command has no business in the local shell, and vice versa.'),
        field('Variables', varsIn,
          'One per line. `name = value` gives a default; `name = a | b | c` offers a list (mark the '
          + 'default with *); `name =` has no default and is always asked for.'),
        varsNote,
        confirmIn,
        interactiveIn,
        noEnterIn,
        pinIn,
        pinRow,
        everyRow);
      syncVars();
    },
    buttons: [
      { label: 'Cancel', value: null },
      {
        label: 'Save', class: 'primary-btn',
        onClick: ({ close }) => {
          if (!cmdIn.value.trim()) return toast('Give a command', 'error');
          close({
            id: initial.builtin ? undefined : initial.id,
            name: nameIn.value.trim() || cmdIn.value.trim().split('\n')[0].slice(0, 40),
            description: descIn.value.trim(),
            category: catIn.value.trim() || 'Custom',
            command: cmdIn.value.trim(),
            where: runWhereSel.value,
            confirm: confirmIn.input.checked,
            interactive: interactiveIn.input.checked,
            noEnter: noEnterIn.input.checked,
            variableSpec: varsIn.value.trim(),
            variables: parseVarSpec(varsIn.value),
            repeatSeconds: interactiveIn.input.checked || noEnterIn.input.checked
              ? 0
              : Math.max(0, Math.round(Number(everyIn.value) || 0) * (everyUnit.value === 'minutes' ? 60 : 1)),
            // The icon *and* where the button shows: two decisions, so this
            // carries both. Passing the icon alone lost the scope silently.
            _pin: pinIn.input.checked
              ? { icon: pinIcon || '\u25B6', where: pinWhere || 'hosts' }
              : null,
          });
        },
      },
    ],
  });
  if (!res) return null;
  const pin = res._pin;
  delete res._pin;
  const saved = await window.api.macros.save(res);
  // After the save, because a new macro has no id to pin until it exists.
  if (saved?.id) {
    if (pin) await window.api.macros.pin(saved.id, { pinned: true, icon: pin.icon, where: pin.where });
    else if (initial.id && pinnedIconFor(initial.id)) await window.api.macros.pin(saved.id, { pinned: false });
  }
  await loadMacros();
  return saved;
}

export async function deleteMacro(m) {
  if (m.builtin) {
    if (!await confirm({
      title: 'Hide built-in macro',
      message: `Hide “${m.name}”?`,
      detail: 'Built-in macros cannot be deleted, only hidden. Restore them from the Macros menu.',
      confirmLabel: 'Hide',
    })) return false;
    await window.api.macros.setHidden(m.id, true);
  } else {
    if (!await confirm({
      title: 'Delete macro',
      message: `Delete “${m.name}”?`,
      confirmLabel: 'Delete', danger: true,
    })) return false;
    await window.api.macros.remove(m.id);
  }
  await loadMacros();
  return true;
}

/** Bring back every dismissed built-in. */
export async function restoreBuiltins() {
  const { hidden } = await window.api.macros.list();
  if (!hidden?.length) return status('No hidden macros');
  for (const id of hidden) await window.api.macros.setHidden(id, false);
  await loadMacros();
  status(`Restored ${hidden.length} built-in macro${hidden.length === 1 ? '' : 's'}`);
}

export { contextMenu };
