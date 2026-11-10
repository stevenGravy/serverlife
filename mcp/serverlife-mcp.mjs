#!/usr/bin/env node
/**
 * ServerLife as an MCP server.
 *
 * MCP clients — Claude Code and the rest — spawn a server and speak JSON-RPC
 * over stdio. ServerLife is a GUI process that is already running, so this is a
 * bridge rather than a server proper: it forwards each tool call to the app's
 * local control socket and hands back the answer.
 *
 * Nothing here decides what is allowed. The app does: the socket is off until
 * the user turns it on, the token is theirs, and the verb list is fixed. This
 * file only translates.
 *
 *   claude mcp add serverlife -- node /path/to/mcp/serverlife-mcp.mjs
 *
 * Protocol is implemented by hand — initialize, tools/list, tools/call is the
 * whole of it — so the app ships no extra dependency for this.
 */

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';

const WINDOWS = process.platform === 'win32';
const PROTOCOL_VERSION = '2024-11-05';

/* ------------------------------------------------------------------ */
/* Finding the app                                                     */
/* ------------------------------------------------------------------ */

/** Where Electron keeps this app's data, per platform. */
function userDataDir() {
  if (process.env.SERVERLIFE_USER_DATA) return process.env.SERVERLIFE_USER_DATA;
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'ServerLife');
  if (WINDOWS) return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'ServerLife');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'ServerLife');
}

function shortHash(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
}

function socketPath(dir) {
  if (process.env.SERVERLIFE_SOCKET) return process.env.SERVERLIFE_SOCKET;
  if (WINDOWS) return '\\\\.\\pipe\\serverlife-' + shortHash(dir + os.userInfo().username);
  return path.join(os.tmpdir(), `serverlife-${shortHash(dir + String(process.getuid?.() ?? ''))}.sock`);
}

function readToken(dir) {
  if (process.env.SERVERLIFE_TOKEN) return process.env.SERVERLIFE_TOKEN.trim();
  return fs.readFileSync(path.join(dir, 'control-token'), 'utf8').trim();
}

/* ------------------------------------------------------------------ */
/* Talking to the app                                                  */
/* ------------------------------------------------------------------ */

/**
 * One request, one connection.
 *
 * Reconnecting per call costs nothing on a local socket and means a restarted
 * app (or one started after this bridge) is picked up without the client having
 * to restart the MCP server.
 */
function callApp(verb, params) {
  const dir = userDataDir();
  return new Promise((resolve, reject) => {
    let token;
    try { token = readToken(dir); } catch {
      reject(new Error('ServerLife has no control token yet. Turn on Settings → Local automation in the app.'));
      return;
    }

    const sock = net.createConnection(socketPath(dir));
    let buf = '';
    const done = (err, data) => {
      try { sock.end(); } catch { /* the socket may already be closed */ }
      if (err) reject(err); else resolve(data);
    };

    sock.setTimeout(300000, () => done(new Error('ServerLife did not answer in time.')));
    sock.on('error', (e) => {
      done(new Error(e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
        ? 'ServerLife is not listening. Is the app running, with Settings → Local automation turned on?'
        : `Could not reach ServerLife: ${e.message}`));
    });
    sock.on('connect', () => {
      sock.write(JSON.stringify({ token, client: 'mcp', id: 1, verb, params: params || {} }) + '\n');
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let res;
      try { res = JSON.parse(buf.slice(0, i)); } catch { return done(new Error('Unreadable reply from ServerLife.')); }
      if (res.ok) done(null, res.data);
      else done(new Error(res.error || 'ServerLife refused the request.'));
    });
  });
}

/* ------------------------------------------------------------------ */
/* The tools                                                           */
/* ------------------------------------------------------------------ */

const BEAM_FLAG = 'A beam\u2019s name (in place of host, as sync_apply takes it), or true: the host is a beam / false: it is not. Only needed when a beam and another host share the exact name — that case is refused until you say which.';

const TOOLS = [
  {
    name: 'serverlife_status',
    description: 'What ServerLife is: version, platform, whether tsh and ssh were found, and which Teleport clusters are logged in.',
    verb: 'status',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'serverlife_list_hosts',
    description: 'Every host ServerLife can open: beams (by the name to open them with), Teleport nodes (with labels), Kubernetes clusters (logged in or available — not ones you would first have to request), ssh_config aliases and saved profiles. Use before opening a session to get names right.',
    verb: 'list_hosts',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring match over names, clusters and labels.' },
        limit: { type: 'number', description: 'Maximum hosts to return (default 200).' },
      },
    },
  },
  {
    name: 'serverlife_list_sessions',
    description: 'The sessions currently open, per tab, with their panes and connection state.',
    verb: 'list_sessions',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'serverlife_open_session',
    description: 'Open one session in ServerLife. The host is named as a person would: a beam’s name (as list_beams shows it), a Teleport node hostname, an ssh_config alias, a saved profile name, a Kubernetes cluster name (opens its cluster browser tab — logging in first if it is only available, not yet connected), or "local".',
    verb: 'open_session',
    inputSchema: {
      type: 'object',
      // host, or a beam by name.
      properties: {
        host: { type: 'string', description: 'Beam name, host name, alias, profile name, Kubernetes cluster name, or "local". Beams match exactly, never partially.' },
        login: { type: 'string', description: 'Remote user to connect as. Not meaningful for a Kubernetes cluster.' },
        cluster: { type: 'string', description: 'Teleport cluster, when the same name exists in several.' },
        beam: { type: ['string', 'boolean'], description: BEAM_FLAG },
        filesOnly: { type: 'boolean', description: 'Open the file browser with no terminal.' },
        split: { type: 'string', enum: ['right', 'down'], description: 'Split a pane instead of opening a tab. By default the currently-focused one — pass "tab" to name exactly which one instead of relying on that. Not available for a Kubernetes cluster, which always opens its own tab.' },
        tab: { type: 'number', description: 'With split: which open tab to split, by its index from list_sessions — e.g. the one a previous open_session call just opened — rather than whatever happens to be focused.' },
        tmux: {
          type: 'boolean',
          description: 'Run the session inside tmux on the host, so it survives this window going away. '
            + 'Left unset, the host\u2019s own setting decides. Not available on hosts that ask for MFA per session.',
        },
        tmuxSession: { type: 'string', description: 'Which tmux session to attach to or create. Defaults to the host\u2019s setting.' },
      },
    },
  },
  {
    name: 'serverlife_open_sessions',
    description: 'Open a set of sessions in one go — the usual way to set up for a piece of work. Each entry takes the same fields as open_session; one failure does not stop the rest.',
    verb: 'open_sessions',
    inputSchema: {
      type: 'object',
      required: ['sessions'],
      properties: {
        sessions: {
          type: 'array',
          description: 'Sessions to open, in order.',
          items: {
            type: 'object',
            properties: {
              host: { type: 'string' },
              login: { type: 'string' },
              cluster: { type: 'string' },
              beam: { type: ['string', 'boolean'] },
              filesOnly: { type: 'boolean' },
              split: { type: 'string', enum: ['right', 'down'] },
              tab: { type: 'number', description: 'With split: which open tab to split, by its index from list_sessions.' },
              tmux: { type: 'boolean' },
              tmuxSession: { type: 'string' },
            },
          },
        },
        stopOnError: { type: 'boolean', description: 'Stop at the first failure instead of carrying on.' },
      },
    },
  },
  {
    name: 'serverlife_list_tmux',
    description: 'What tmux has running on a host, so you can resume a session rather than start another. '
      + 'Says whether tmux is installed there, and lists each session with its window count and whether '
      + 'something is attached. Dials the host to ask.',
    verb: 'list_tmux',
    inputSchema: {
      type: 'object',
      // host, or a beam by name.
      properties: {
        host: { type: 'string', description: 'Beam name, host name, alias or profile name.' },
        cluster: { type: 'string', description: 'Teleport cluster, when the same name exists in several.' },
        login: { type: 'string', description: 'Remote user to connect as.' },
        beam: { type: ['string', 'boolean'], description: BEAM_FLAG },
      },
    },
  },
  {
    name: 'serverlife_close_session',
    description: 'Close a session tab, by index (from list_sessions) or title. With all=true, closes every session. '
      + 'If it still has a live session in it, the user is asked to confirm first (skipped if it already exited, '
      + 'and can be turned off for good from that dialog or from Settings); a decline throws.',
    verb: 'close_session',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number' },
        title: { type: 'string' },
        all: { type: 'boolean' },
      },
    },
  },
  {
    name: 'serverlife_get_settings',
    description: 'Every app setting as it is right now, the same object the Settings dialog reads from — fonts, '
      + 'cursor (cursorStyle: "bar"|"block"|"underline", cursorBlink), scrollback, confirmations, kubeEnabled '
      + '(KubeLife, the optional Kubernetes module — on by default), and the rest.',
    verb: 'get_settings',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'serverlife_set_settings',
    description: 'Change one or more settings, by the same keys the Settings dialog’s own Save button writes '
      + '(see serverlife_get_settings for the current ones) — e.g. { cursorStyle: "block" } or '
      + '{ kubeEnabled: false } to turn KubeLife off. A cursor change applies live to every open terminal; '
      + 'kubeEnabled applies live to the Resources tab; others take effect the way they always have.',
    verb: 'set_settings',
    inputSchema: {
      type: 'object',
      properties: {
        patch: { type: 'object', description: 'Settings to change, as { key: value }.' },
      },
      required: ['patch'],
    },
  },
  {
    name: 'serverlife_list_layouts',
    description: 'Saved layouts — named arrangements of tabs and panes that can be reopened as a set.',
    verb: 'list_layouts',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'serverlife_load_layout',
    description: 'Open a saved layout by name. This replaces whatever is open, dialling each session again.',
    verb: 'load_layout',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, id: { type: 'string' } },
    },
  },
  {
    name: 'serverlife_save_layout',
    description: 'Save what is open now as a named layout.',
    verb: 'save_layout',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  },
  {
    name: 'serverlife_list_clusters',
    description: 'Teleport clusters: which are logged in, as whom, when the certificate expires, which tsh home each is in, and which are saved for re-login.',
    verb: 'list_clusters',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'serverlife_login_command',
    description: 'The tsh login command for a cluster, ready to paste into a terminal (TELEPORT_HOME included where it matters). Returns the command; it does not run it.',
    verb: 'login_command',
    inputSchema: {
      type: 'object',
      properties: {
        cluster: { type: 'string' },
        proxy: { type: 'string' },
        user: { type: 'string' },
        home: { type: 'string' },
      },
    },
  },
  {
    name: 'serverlife_list_kube_resource_types',
    description: 'Every resource kind a Kubernetes cluster actually has — kubectl api-resources under the hood, CRDs included, not a fixed list. The cluster has to already be logged in (see serverlife_list_hosts/serverlife_open_session).',
    verb: 'list_kube_resource_types',
    inputSchema: {
      type: 'object',
      required: ['cluster'],
      properties: {
        cluster: { type: 'string', description: 'Cluster name, as serverlife_list_hosts shows it, or its exact kubeconfig context name.' },
      },
    },
  },
  {
    name: 'serverlife_list_kube_resources',
    description: 'Resources of one kind in a Kubernetes cluster — kubectl get, trimmed to name, namespace, status and age. Read-only.',
    verb: 'list_kube_resources',
    inputSchema: {
      type: 'object',
      required: ['cluster', 'kind'],
      properties: {
        cluster: { type: 'string', description: 'Cluster name, as serverlife_list_hosts shows it, or its exact kubeconfig context name.' },
        kind: { type: 'string', description: 'Resource kind, e.g. Pod, Deployment, Service. See serverlife_list_kube_resource_types for what this cluster has.' },
        namespace: { type: 'string', description: 'One namespace. Every namespace, if left out.' },
        selector: { type: 'string', description: 'A label selector, kubectl’s own -l syntax, e.g. "app=foo,env=prod".' },
        limit: { type: 'number', description: 'Maximum resources to return (default 100).' },
      },
    },
  },
  {
    name: 'serverlife_get_kube_resource',
    description: 'One Kubernetes resource’s own YAML — kubectl get -o yaml. Read-only.',
    verb: 'get_kube_resource',
    inputSchema: {
      type: 'object',
      required: ['cluster', 'kind', 'name'],
      properties: {
        cluster: { type: 'string', description: 'Cluster name, as serverlife_list_hosts shows it, or its exact kubeconfig context name.' },
        kind: { type: 'string', description: 'Resource kind, e.g. Pod, Deployment, Service.' },
        name: { type: 'string' },
        namespace: { type: 'string', description: 'Required for a namespaced kind.' },
      },
    },
  },
  {
    name: 'serverlife_describe_kube_resource',
    description: 'kubectl describe for one Kubernetes resource — conditions and recent events, in kubectl’s own words. Read-only.',
    verb: 'describe_kube_resource',
    inputSchema: {
      type: 'object',
      required: ['cluster', 'kind', 'name'],
      properties: {
        cluster: { type: 'string', description: 'Cluster name, as serverlife_list_hosts shows it, or its exact kubeconfig context name.' },
        kind: { type: 'string', description: 'Resource kind, e.g. Pod, Deployment, Service.' },
        name: { type: 'string' },
        namespace: { type: 'string', description: 'Required for a namespaced kind.' },
      },
    },
  },
  {
    name: 'serverlife_list_beams',
    description: 'Beams — ephemeral sandbox VMs — on every logged-in cluster that runs the service, '
      + 'with their region and expiry. Use before syncing to one, to get the name right.',
    verb: 'list_beams',
    inputSchema: {
      type: 'object',
      properties: {
        proxy: { type: 'string', description: 'Limit to one cluster proxy address.' },
      },
    },
  },
  {
    name: 'serverlife_sync_preview',
    description: 'What a folder synchronisation would do between this machine and a server or a beam, '
      + 'without doing any of it: which files would be uploaded, downloaded or deleted, and why. '
      + 'Always worth calling before sync_apply, and the only safe way to check a direction.',
    verb: 'sync_preview',
    inputSchema: {
      type: 'object',
      required: ['local', 'remote'],
      properties: {
        host: { type: 'string', description: 'Server: a Teleport node hostname or an ssh_config alias.' },
        beam: { type: 'string', description: 'Beam name (or UUID), instead of host.' },
        cluster: { type: 'string', description: 'Teleport cluster, when the name exists in several.' },
        login: { type: 'string', description: 'Remote user to connect as.' },
        local: { type: 'string', description: 'Absolute path to the folder on this machine.' },
        remote: { type: 'string', description: 'Absolute path to the folder on the server or beam.' },
        direction: {
          type: 'string', enum: ['up', 'down', 'both'],
          description: 'up = this machine to the server (default), down = the other way, both = newer side wins.',
        },
        compare: {
          type: 'string', enum: ['both', 'size', 'time'],
          description: 'What makes two files the same. Default both (size and time).',
        },
        delete: {
          type: 'boolean',
          description: 'Include removing what the source does not have. Off by default.',
        },
      },
    },
  },
  {
    name: 'serverlife_sync_apply',
    description: 'Run a folder synchronisation between this machine and a server or a beam. '
      + 'Transfers appear in the app\'s transfer queue. Deleting is opt-in: without delete:true '
      + 'nothing is removed, only copied. Call sync_preview first and show the user what it will do.',
    verb: 'sync_apply',
    inputSchema: {
      type: 'object',
      required: ['local', 'remote'],
      properties: {
        host: { type: 'string', description: 'Server: a Teleport node hostname or an ssh_config alias.' },
        beam: { type: 'string', description: 'Beam name (or UUID), instead of host.' },
        cluster: { type: 'string', description: 'Teleport cluster, when the name exists in several.' },
        login: { type: 'string', description: 'Remote user to connect as.' },
        local: { type: 'string', description: 'Absolute path to the folder on this machine.' },
        remote: { type: 'string', description: 'Absolute path to the folder on the server or beam.' },
        direction: { type: 'string', enum: ['up', 'down', 'both'] },
        compare: { type: 'string', enum: ['both', 'size', 'time'] },
        delete: {
          type: 'boolean',
          description: 'Also remove what the source does not have — including folders, with their '
            + 'contents. Off by default; ask the user before turning it on.',
        },
      },
    },
  },
  {
    name: 'serverlife_list_forwards',
    description: 'Port forwards: the tunnels open right now, and the ones the user has saved as '
      + 'favourites. Worth checking before opening anything, so a port already in use is not fought over.',
    verb: 'list_forwards',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'serverlife_open_forward',
    description: 'Open one of the user\u2019s saved tunnels, dialling its host first if needed. Only '
      + 'saved favourites can be opened — arbitrary ports and destinations cannot be asked for through '
      + 'this interface. list_forwards has the names.',
    verb: 'open_forward',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Favourite name, as listed by list_forwards.' },
        id: { type: 'string', description: 'Its id, if the name is ambiguous.' },
      },
    },
  },
  {
    name: 'serverlife_list_requests',
    description: 'The HTTP requests the user has saved in Network and certificate tools, with the method and URL of each.',
    verb: 'list_requests',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'serverlife_run_request',
    description: 'Run one of the user\u2019s saved HTTP requests and return the status, timing and body. '
      + 'Only saved requests can be run — this is not a way to fetch an arbitrary URL from the '
      + 'user\u2019s machine.',
    verb: 'run_request',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Request name, as listed by list_requests.' },
        id: { type: 'string' },
        limit: { type: 'number', description: 'Maximum body characters to return (default 4000).' },
      },
    },
  },
  {
    name: 'serverlife_search',
    description: 'Search everything in ServerLife by name or details, as the search box at the top '
      + 'of its window does: hosts (name, address, labels, uuid), saved profiles, clusters, beams, '
      + 'open tabs, macros, snippets, layouts, past multi-exec runs, and saved AI prompts and '
      + 'responses. Each kind of result says which tool opens or runs it. Read-only.',
    verb: 'search',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'Words to find; every word must match. Labels work as text, e.g. "env=prod web".' },
        limit: { type: 'number', description: 'Most results per kind (default 8, at most 50).' },
        kinds: {
          type: 'array', items: { type: 'string', enum: ['tab', 'host', 'profile', 'beam', 'cluster', 'macro', 'snippet', 'layout', 'run', 'prompt', 'response'] },
          description: 'Only these kinds of result.',
        },
      },
    },
  },
  {
    name: 'serverlife_list_macros',
    description: 'The macros the user has saved, with the command each one runs.',
    verb: 'list_macros',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'serverlife_run_macro',
    description: 'Run one of the user\'s saved macros in the focused session. Only saved macros can be run — there is no way to run an arbitrary command through this interface. Pass waitSeconds to wait for it and get back what it printed; or read it afterwards with serverlife_read_output.',
    verb: 'run_macro',
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Macro name, as listed by list_macros.' },
        allPanes: { type: 'boolean', description: 'Run it in every pane of the focused tab.' },
        waitSeconds: { type: 'number', description: 'Wait this long (up to 60) for the command, then return its output.' },
      },
    },
  },
  {
    name: 'serverlife_type_into_session',
    description: 'Type (paste) text into a terminal session — the focused pane of the current tab unless tab and pane (indexes from serverlife_list_sessions) are given — and optionally press Enter to run it. The user decides in ServerLife whether this is allowed: by default they are shown the text and the target and asked each time, and they may decline, paste without running, or turn it off. Read the result with serverlife_read_output.',
    verb: 'type_text',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'What to type. Several lines are pasted as one paste.' },
        enter: { type: 'boolean', description: 'Press Enter afterwards, to run it. Default false.' },
        tab: { type: 'integer', description: 'Tab index from list_sessions. Default: the current tab.' },
        pane: { type: 'integer', description: 'Pane index within that tab. Default: its focused pane.' },
      },
    },
  },
  {
    name: 'serverlife_read_output',
    description: 'Read the text a session shows: the last lines of a terminal pane — the focused pane of the current tab unless tab and pane (indexes from serverlife_list_sessions) are given. Read-only. Use it to see what a macro printed. It returns whatever the terminal shows, which can include anything the session displayed.',
    verb: 'read_output',
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'integer', description: 'Tab index from list_sessions. Default: the current tab.' },
        pane: { type: 'integer', description: 'Pane index within that tab. Default: its focused pane.' },
        lines: { type: 'integer', description: 'How many of the last lines to return (1–1000, default 80).' },
      },
    },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

/* ------------------------------------------------------------------ */
/* JSON-RPC over stdio                                                 */
/* ------------------------------------------------------------------ */

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function result(id, value) { write({ jsonrpc: '2.0', id, result: value }); }

function failure(id, code, message) { write({ jsonrpc: '2.0', id, error: { code, message } }); }

let clientName = null;

async function onMessage(msg) {
  const { id, method, params } = msg;

  // Notifications carry no id and expect no answer.
  if (id === undefined || id === null) return;

  switch (method) {
    case 'initialize':
      // Who is asking, so ServerLife can name it when it asks the person.
      clientName = String(params?.clientInfo?.name || '').slice(0, 60) || null;
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'serverlife', version: '1.0.0' },
        instructions: 'Drives a running ServerLife window: list hosts and beams, open sessions (singly '
          + 'or as a set — a Kubernetes cluster opens its own browser tab the same way a host opens a '
          + 'terminal), browse a logged-in Kubernetes cluster\'s own resources (kinds, resources, a '
          + 'resource\'s YAML or description — all read-only), synchronise folders with a server or a '
          + 'beam, manage layouts, read Teleport cluster state, run the user\'s saved macros, read what '
          + 'a session shows, and — when the user allows it — type into a session. '
          + 'The app must be running with Settings → Local automation turned on.',
      });

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });

    case 'tools/call': {
      const tool = byName.get(params?.name);
      if (!tool) return failure(id, -32602, `Unknown tool "${params?.name}"`);
      try {
        const data = await callApp(tool.verb, { ...(params.arguments || {}), _client: clientName });
        return result(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
      } catch (e) {
        // A tool that failed is a result, not a protocol error: the model should
        // see the reason and be able to act on it.
        return result(id, {
          isError: true,
          content: [{ type: 'text', text: e.message }],
        });
      }
    }

    case 'resources/list':
      return result(id, { resources: [] });
    case 'prompts/list':
      return result(id, { prompts: [] });

    default:
      return failure(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch {
    return failure(null, -32700, 'Parse error');
  }
  onMessage(msg).catch((e) => failure(msg?.id ?? null, -32603, e.message));
});
rl.on('close', () => process.exit(0));
