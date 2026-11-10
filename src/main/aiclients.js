/**
 * AI coding assistants ServerLife can open beside a session, and how each is
 * told about ServerLife's own tools.
 *
 * Every one of these is the vendor's own command-line client, run in a
 * terminal pane — the way Claude Code's VS Code and JetBrains integrations
 * run `claude` — so each signs in the way its vendor intends, with nothing
 * embedded or re-implemented here. What ServerLife adds is the MCP server:
 * the agent can list hosts, open sessions and read cluster state through the
 * same fixed list of verbs MCP.md describes.
 *
 * Each client takes MCP servers differently. Where it can be given one for a
 * single session it is (a flag, or a config file named in the environment),
 * so nobody's own setup is edited. Pi and Gemini CLI only read their own
 * config files; for those the registration is a one-time step the person is
 * asked about. Any client can be run through a launcher — a command that
 * wraps it, such as one that routes it through a gateway — configured in
 * Settings rather than known here.
 *
 * Pure apart from writing a session config file: the launch is built here
 * and run by the caller, so it can be tested without any client installed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SERVER = 'serverlife';

/*
 * How each client is started and given an MCP server.
 *   mcp: 'flag'    — passed on the command line for this session
 *        'env'     — a config file named in the environment, this session
 *        'persist' — written to the client's own config, once, when asked
 *   login: the command that signs in, shown when the check finds none
 *   resume: the arguments that reopen a past conversation — `last` the most
 *        recent, `pick` the client's own list to choose from (where it has
 *        one); `lead` when they are a subcommand, put before everything else
 *   nameFlag: the flag that names a new conversation, where there is one
 */
const CLIENTS = [
  {
    id: 'claude', name: 'Claude Code', bin: 'claude', vendor: 'Anthropic', mcp: 'flag', modelFlag: '--model',
    resume: { last: ['--continue'], pick: ['--resume'] }, nameFlag: '--name',
    install: 'npm install -g @anthropic-ai/claude-code', login: 'claude auth login',
  },
  {
    id: 'codex', name: 'Codex', bin: 'codex', vendor: 'OpenAI', mcp: 'flag', modelFlag: '-m',
    // A subcommand, so it goes straight after the program.
    resume: { last: ['resume', '--last'], pick: ['resume'], lead: true },
    install: 'npm install -g @openai/codex', login: 'codex login',
  },
  {
    id: 'copilot', name: 'GitHub Copilot CLI', bin: 'copilot', vendor: 'GitHub', mcp: 'flag', modelFlag: '--model',
    resume: { last: ['--continue'], pick: ['--resume'] }, nameFlag: '--name',
    install: 'npm install -g @github/copilot', login: 'copilot login',
  },
  {
    id: 'opencode', name: 'OpenCode', bin: 'opencode', vendor: 'open source', mcp: 'env', modelFlag: '-m',
    resume: { last: ['--continue'] },
    install: 'npm install -g opencode-ai', login: 'opencode auth login',
  },
  {
    id: 'pi', name: 'Pi', bin: 'pi', vendor: 'open source', mcp: 'persist', modelFlag: '--model',
    resume: { last: ['--continue'], pick: ['--resume'] }, nameFlag: '--name',
    install: null, login: null,
  },
  {
    id: 'gemini', name: 'Gemini CLI', bin: 'gemini', vendor: 'Google', mcp: 'persist', modelFlag: '-m',
    resume: { last: ['--resume', 'latest'] },
    install: 'npm install -g @google/gemini-cli', login: 'gemini',
  },
];

/**
 * A tool the person added themselves: a name, the command that starts it,
 * and — optionally — the flag it takes MCP servers with, as the standard
 * `{"mcpServers": {…}}` JSON that Claude Code, Copilot and others read.
 * Whatever the first word of the command is, that is what is checked for.
 */
function customClient(raw = {}) {
  const command = String(raw.command || '').trim();
  const words = command.split(/\s+/).filter(Boolean);
  return {
    id: String(raw.id || ''),
    name: String(raw.name || words[0] || 'AI tool').trim(),
    bin: words[0] || '',
    extraArgs: words.slice(1),
    vendor: 'added by you',
    mcp: raw.mcpFlag ? 'flag' : 'none',
    mcpFlag: String(raw.mcpFlag || '').trim(),
    install: String(raw.install || '').trim() || null,
    login: null,
    custom: true,
  };
}

/** The built-in clients and the person's own, as one list. */
function allClients(custom = []) {
  return [...CLIENTS, ...(Array.isArray(custom) ? custom : []).filter((c) => c && c.id && c.command).map(customClient)];
}

let customList = [];
/** Tell this module about the person's own tools (from settings). */
function setCustom(list) { customList = Array.isArray(list) ? list : []; }

const byId = (id) => allClients(customList).find((c) => c.id === id) || null;

/**
 * The MCP server definition, in the parts every client asks for.
 *
 * The bridge is run by ServerLife's own runtime (Electron as Node), so there
 * is no `node` to install; SERVERLIFE_USER_DATA tells it which ServerLife to
 * reach, which matters as soon as two are installed or one is a dev build.
 */
function serverSpec({ runtime, bridge, userData }) {
  return {
    command: runtime,
    args: [bridge],
    env: { ELECTRON_RUN_AS_NODE: '1', SERVERLIFE_USER_DATA: userData },
  };
}

/** TOML for one string or a table of strings, for Codex's -c overrides. */
const tomlStr = (s) => JSON.stringify(String(s));
const tomlTable = (obj) => `{ ${Object.entries(obj).map(([k, v]) => `${k} = ${tomlStr(v)}`).join(', ')} }`;

/**
 * The arguments and environment that give a client the MCP server for this
 * session. `files` are written before launch (OpenCode's config).
 */
function mcpFor(clientId, spec, { tmpDir = os.tmpdir() } = {}) {
  const { command, args, env } = spec;
  switch (clientId) {
    case 'claude':
      return {
        args: ['--mcp-config', JSON.stringify({ mcpServers: { [SERVER]: { command, args, env } } })],
        env: {},
      };
    case 'codex':
      return {
        args: [
          '-c', `mcp_servers.${SERVER}.command=${tomlStr(command)}`,
          '-c', `mcp_servers.${SERVER}.args=[${args.map(tomlStr).join(', ')}]`,
          '-c', `mcp_servers.${SERVER}.env=${tomlTable(env)}`,
        ],
        env: {},
      };
    case 'copilot':
      return {
        args: ['--additional-mcp-config', JSON.stringify({
          mcpServers: { [SERVER]: { type: 'local', command, args, env, tools: ['*'] } },
        })],
        env: {},
      };
    case 'opencode': {
      const file = path.join(tmpDir, 'serverlife-opencode.json');
      const config = {
        $schema: 'https://opencode.ai/config.json',
        mcp: { [SERVER]: { type: 'local', command: [command, ...args], environment: env, enabled: true } },
      };
      return { args: [], env: { OPENCODE_CONFIG: file }, files: [[file, JSON.stringify(config, null, 2)]] };
    }
    default: {
      // A tool of the person's own that names a flag for MCP config.
      const c = byId(clientId);
      if (c?.custom && c.mcpFlag) {
        return { args: [c.mcpFlag, JSON.stringify({ mcpServers: { [SERVER]: { command, args, env } } })], env: {} };
      }
      // Pi and Gemini read only their own config: see registerCommand.
      return { args: [], env: {} };
    }
  }
}

/**
 * The one-time command that adds ServerLife to a client that keeps MCP
 * servers only in its own config. Shown to the person before it is run.
 */
function registerCommand(clientId, spec) {
  const { command, args, env } = spec;
  const envFlags = (flag) => Object.entries(env).flatMap(([k, v]) => [flag, `${k}=${v}`]);
  if (clientId === 'pi') return ['pi', 'mcp', 'add', SERVER, ...envFlags('--env'), '--', command, ...args];
  if (clientId === 'gemini') return ['gemini', 'mcp', 'add', '--scope', 'user', ...envFlags('-e'), SERVER, command, ...args];
  return null;
}

/**
 * Words from a line a person typed: whitespace-separated, with "double" or
 * 'single' quotes keeping spaces in one word. Enough for extra arguments.
 */
function splitWords(line) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(line || '')))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** One argument for a POSIX shell, quoted only when it needs it. */
function shq(a) {
  const v = String(a);
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * The client's command line, run through a launcher if one is set.
 *
 * A launcher is any command the person wants assistants run through — one
 * that routes them through a gateway, sets up credentials, records usage.
 * `{client}` is replaced by the assistant's name (claude, codex, …) with its
 * arguments after it; `{command}` by its whole command line; with neither,
 * the command is added after the launcher. Only the clients listed in
 * `clients` go through it, when a list is given.
 */
function withLauncher(clientId, argv, launcher) {
  const template = String(launcher?.template || '').trim();
  const applies = template && (!launcher.clients?.length || launcher.clients.includes(clientId));
  if (!applies) return { argv, launched: false };
  const words = template.split(/\s+/);
  let out;
  if (words.includes('{client}')) {
    out = words.flatMap((w) => (w === '{client}' ? [clientId, ...argv.slice(1)] : [w]));
  } else if (words.includes('{command}')) {
    out = words.flatMap((w) => (w === '{command}' ? argv : [w]));
  } else {
    out = [...words, ...argv];
  }
  return { argv: out, launched: true };
}

/**
 * How to start a client: the program, its arguments and environment.
 *
 * Through the person's login shell on macOS and Linux, so `claude` is found
 * wherever their shell finds it — nvm, Homebrew, ~/.local/bin — which an app
 * started from the Dock cannot see.
 */
function launch(clientId, {
  spec = null, launcher = null, shell = process.env.SHELL || '/bin/zsh',
  platform = process.platform, tmpDir, model = '', extraArgs = '', recipeArgs = [],
  resume = '', name = '',
} = {}) {
  const c = byId(clientId);
  if (!c) throw new Error(`Unknown assistant: ${clientId}`);
  const mcp = spec ? mcpFor(clientId, spec, { tmpDir }) : { args: [], env: {} };
  /*
   * A model chosen for this tool goes on its own model flag — which also
   * keeps a tool from guessing a provider from whatever credentials happen
   * to be in the environment. Extra arguments are whatever else the person
   * wants on this tool's command line.
   */
  const modelArgs = model && c.modelFlag ? [c.modelFlag, String(model).trim()] : [];
  const extra = splitWords(extraArgs);
  /*
   * Picking up a past conversation ('last' or 'pick'), and a name for a new
   * one — each only where the client has a way to; a resumed conversation
   * keeps the name it had.
   */
  const again = (resume && c.resume?.[resume]) || [];
  const lead = c.resume?.lead ? again : [];
  const tail = c.resume?.lead ? [] : again;
  const label = String(name || '').trim();
  const nameArgs = label && c.nameFlag && !again.length ? [c.nameFlag, label] : [];
  const { argv, launched } = withLauncher(clientId,
    [c.bin, ...lead, ...(c.extraArgs || []), ...recipeArgs, ...modelArgs, ...extra, ...nameArgs, ...tail, ...mcp.args], launcher);
  const title = label || (c.name + (launched ? ' · via launcher' : ''));
  if (platform === 'win32') {
    return { command: argv[0], args: argv.slice(1), env: mcp.env, files: mcp.files || [], title, client: c, launched };
  }
  /*
   * Login and interactive, as the person's own terminal starts: ~/.zshrc is
   * where Homebrew, nvm and the like are often set up, and a login shell
   * alone does not read it. The pane is a real terminal, so -i is at home.
   */
  return {
    command: shell,
    args: ['-l', '-i', '-c', 'exec ' + argv.map(shq).join(' ')],
    env: mcp.env, files: mcp.files || [], title, client: c, launched,
  };
}

/*
 * Launchers worth suggesting, when their command is installed. Suggested
 * only — nothing is used unless the person picks it in Settings.
 */
const KNOWN_LAUNCHERS = [
  {
    bin: 'prism', template: 'prism {client}', clients: ['claude', 'codex', 'opencode', 'pi'],
    about: 'routes assistants through a Teleport cluster’s LLM gateways, signed in as you in Teleport',
    /*
     * What a client needs beyond the launcher, applied by ServerLife so
     * nobody has to know it. Codex no longer reads OPENAI_BASE_URL, which is
     * all prism sets, so on its own it went straight to OpenAI; a provider
     * pointing at prism's router is what makes it go through the gateway.
     * The router's port is read from prism's state when the tool starts.
     */
    recipes: {
      codex: {
        why: 'Codex ignores OPENAI_BASE_URL, so ServerLife points a Codex model provider at the gateway on this machine.',
        needs: 'prismPort',
        args: (port) => [
          '-c', 'model_provider="gateway"',
          '-c', 'model_providers.gateway.name="Teleport gateway"',
          '-c', `model_providers.gateway.base_url="http://127.0.0.1:${port}/v1"`,
          '-c', 'model_providers.gateway.env_key="OPENAI_API_KEY"',
          '-c', 'model_providers.gateway.wire_api="responses"',
        ],
      },
    },
  },
];

/** The recipe a client needs for a launcher, if one is known. */
function recipeFor(clientId, template) {
  const first = String(template || '').trim().split(/\s+/)[0];
  const l = KNOWN_LAUNCHERS.find((x) => x.bin === first);
  return l?.recipes?.[clientId] || null;
}

/** prism's router port, from its state file, or null. */
function prismPort(home = os.homedir()) {
  const dir = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'prism', 'state.json'), 'utf8')).local_port || null;
  } catch {
    return null;
  }
}

/*
 * Where command-line tools are installed, for an environment that does not
 * already have them on PATH — an app opened from the Dock has only launchd's
 * /usr/bin:/bin:/usr/sbin:/sbin.
 */
function toolDirs(home = os.homedir()) {
  return ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, 'bin'),
    path.join(home, '.npm-global', 'bin'), path.join(home, '.bun', 'bin'), path.join(home, '.cargo', 'bin'),
    path.join(home, '.volta', 'bin'), path.join(home, '.claude', 'local')];
}

/** The first executable named `bin` in the directories of `pathStr`, or null. */
function findOnPath(bin, pathStr) {
  if (!bin) return null;
  if (bin.includes('/')) return fs.existsSync(bin) ? bin : null;
  for (const dir of String(pathStr || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      if (fs.statSync(full).isFile()) return full;
    } catch { /* not here */ }
  }
  return null;
}

/** An environment with the tool directories appended to its PATH. */
function withToolPath(env = process.env) {
  if (process.platform === 'win32') return env;
  const have = String(env.PATH || '').split(':').filter(Boolean);
  const add = toolDirs().filter((d) => !have.includes(d));
  return { ...env, PATH: [...have, ...add].join(':') };
}

/** Write a launch's files (OpenCode's session config) before starting it. */
function writeFiles(files) {
  for (const [file, text] of files || []) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, { mode: 0o600 });
  }
}

module.exports = { CLIENTS, KNOWN_LAUNCHERS, recipeFor, prismPort, splitWords, withToolPath, toolDirs, findOnPath, byId, allClients, setCustom, customClient, serverSpec, mcpFor, registerCommand, launch, withLauncher, writeFiles, shq, SERVER };
