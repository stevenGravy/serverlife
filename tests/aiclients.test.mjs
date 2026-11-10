import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const A = require_(path.join(__PROJECT_ROOT__, 'src/main/aiclients.js'));

/**
 * Launching AI assistants with ServerLife's MCP server.
 *
 * Every client is told about the server its own way; these pin each one, so
 * a change to one cannot quietly break another. Nothing here needs a client
 * installed — the launch is built, not run.
 */

const spec = A.serverSpec({ runtime: '/Apps/ServerLife', bridge: '/Apps/mcp/serverlife-mcp.mjs', userData: '/Users/me/SL' });

test('the bridge runs on ServerLife\'s own runtime and knows which ServerLife to reach', () => {
  assert.deepEqual(spec, {
    command: '/Apps/ServerLife', args: ['/Apps/mcp/serverlife-mcp.mjs'],
    env: { ELECTRON_RUN_AS_NODE: '1', SERVERLIFE_USER_DATA: '/Users/me/SL' },
  });
});

test('Claude Code gets the server for this session with --mcp-config', () => {
  const { args } = A.mcpFor('claude', spec);
  assert.equal(args[0], '--mcp-config');
  assert.deepEqual(JSON.parse(args[1]), { mcpServers: { serverlife: spec } });
});

test('Codex gets it as -c overrides, in TOML', () => {
  const { args } = A.mcpFor('codex', spec);
  assert.deepEqual(args, [
    '-c', 'mcp_servers.serverlife.command="/Apps/ServerLife"',
    '-c', 'mcp_servers.serverlife.args=["/Apps/mcp/serverlife-mcp.mjs"]',
    '-c', 'mcp_servers.serverlife.env={ ELECTRON_RUN_AS_NODE = "1", SERVERLIFE_USER_DATA = "/Users/me/SL" }',
  ]);
});

test('Copilot CLI gets it with --additional-mcp-config, every tool allowed', () => {
  const { args } = A.mcpFor('copilot', spec);
  const cfg = JSON.parse(args[1]);
  assert.equal(args[0], '--additional-mcp-config');
  assert.deepEqual(cfg.mcpServers.serverlife.tools, ['*']);
  assert.equal(cfg.mcpServers.serverlife.type, 'local');
});

test('OpenCode gets a session config file named in OPENCODE_CONFIG', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-ai-'));
  const m = A.mcpFor('opencode', spec, { tmpDir: dir });
  assert.equal(m.env.OPENCODE_CONFIG, path.join(dir, 'serverlife-opencode.json'));
  A.writeFiles(m.files);
  const cfg = JSON.parse(fs.readFileSync(m.env.OPENCODE_CONFIG, 'utf8'));
  assert.deepEqual(cfg.mcp.serverlife.command, ['/Apps/ServerLife', '/Apps/mcp/serverlife-mcp.mjs']);
  assert.equal(cfg.mcp.serverlife.environment.ELECTRON_RUN_AS_NODE, '1');
});

test('Pi and Gemini are registered once, with a command shown first', () => {
  assert.deepEqual(A.registerCommand('pi', spec), ['pi', 'mcp', 'add', 'serverlife',
    '--env', 'ELECTRON_RUN_AS_NODE=1', '--env', 'SERVERLIFE_USER_DATA=/Users/me/SL',
    '--', '/Apps/ServerLife', '/Apps/mcp/serverlife-mcp.mjs']);
  assert.equal(A.registerCommand('gemini', spec)[0], 'gemini');
  assert.equal(A.registerCommand('claude', spec), null);
});

test('launch: through the login shell, so PATH is the person\'s own', () => {
  const l = A.launch('claude', { spec, shell: '/bin/zsh', platform: 'darwin' });
  assert.equal(l.command, '/bin/zsh');
  // Login and interactive, so ~/.zshrc is read as in the person's terminal.
  assert.deepEqual(l.args.slice(0, 3), ['-l', '-i', '-c']);
  assert.match(l.args[3], /^exec claude --mcp-config '\{"mcpServers"/);
  assert.equal(l.title, 'Claude Code');
});

test('a launcher wraps the client: {client}, {command}, or prefixed', () => {
  const argv = ['claude', '--mcp-config', '{}'];
  assert.deepEqual(A.withLauncher('claude', argv, { template: 'prism {client}' }).argv, ['prism', 'claude', '--mcp-config', '{}']);
  assert.deepEqual(A.withLauncher('claude', argv, { template: 'aws-vault exec dev -- {command}' }).argv,
    ['aws-vault', 'exec', 'dev', '--', 'claude', '--mcp-config', '{}']);
  assert.deepEqual(A.withLauncher('claude', argv, { template: 'nice -n 5' }).argv, ['nice', '-n', '5', 'claude', '--mcp-config', '{}']);
});

test('a launcher applies only to the clients it lists', () => {
  const l = { template: 'prism {client}', clients: ['claude', 'pi'] };
  assert.equal(A.withLauncher('copilot', ['copilot'], l).launched, false);
  const pi = A.launch('pi', { launcher: l, platform: 'darwin', shell: '/bin/zsh' });
  assert.equal(pi.args[3], 'exec prism pi');
  assert.equal(pi.title, 'Pi · via launcher');
  assert.equal(A.launch('pi', { platform: 'darwin', shell: '/bin/zsh' }).args[3], 'exec pi');
});

test('on Windows the client is run directly, with its arguments unquoted', () => {
  const l = A.launch('codex', { spec, platform: 'win32' });
  assert.equal(l.command, 'codex');
  assert.equal(l.args[0], '-c');
});

test('the six clients, each with a name, a binary and an MCP route', () => {
  assert.deepEqual(A.CLIENTS.map((c) => c.id), ['claude', 'codex', 'copilot', 'opencode', 'pi', 'gemini']);
  for (const c of A.CLIENTS) assert.ok(c.name && c.bin && ['flag', 'env', 'persist'].includes(c.mcp));
  assert.ok(!A.CLIENTS.some((c) => 'prism' in c), 'no client entry names a launcher');
});

test('a custom tool: its command, extra words, and MCP through the flag it names', () => {
  A.setCustom([{ id: 'custom-aider', name: 'Aider', command: 'aider --no-auto-commits', mcpFlag: '' },
    { id: 'custom-x', name: 'X', command: 'xagent', mcpFlag: '--mcp-config' }]);
  const aider = A.launch('custom-aider', { spec, platform: 'darwin', shell: '/bin/zsh' });
  assert.equal(aider.args[3], 'exec aider --no-auto-commits');
  const x = A.launch('custom-x', { spec, platform: 'win32' });
  assert.equal(x.command, 'xagent');
  assert.equal(x.args[0], '--mcp-config');
  assert.deepEqual(JSON.parse(x.args[1]).mcpServers.serverlife, spec);
  assert.equal(A.byId('custom-x').custom, true);
  A.setCustom([]);
  assert.equal(A.byId('custom-x'), null);
});

test('a model goes on each tool\'s own flag; extra arguments after it, quotes kept', () => {
  assert.equal(A.launch('opencode', { model: 'anthropic/claude-haiku-4-5', platform: 'darwin', shell: '/bin/zsh' }).args[3],
    'exec opencode -m anthropic/claude-haiku-4-5');
  assert.equal(A.launch('claude', { model: 'claude-sonnet-5', extraArgs: '--add-dir "/tmp/a b"', platform: 'win32' }).args.join(' '),
    '--model claude-sonnet-5 --add-dir /tmp/a b');
  assert.deepEqual(A.splitWords(`-c 'model_providers.g.base_url="http://x/v1"' --fast`),
    ['-c', 'model_providers.g.base_url="http://x/v1"', '--fast']);
});

test('an app opened from the Dock still finds tools: their directories go on PATH', () => {
  const env = A.withToolPath({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin' });
  if (process.platform === 'win32') return;
  assert.ok(env.PATH.split(':').includes('/opt/homebrew/bin'));
  assert.ok(env.PATH.startsWith('/usr/bin:/bin'));
  assert.equal(A.withToolPath({ PATH: '/opt/homebrew/bin:/usr/bin' }).PATH.split(':').filter((d) => d === '/opt/homebrew/bin').length, 1);
});

test('a tool is found on PATH on disk, without asking a shell', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-bin-'));
  const bin = path.join(dir, 'mytool');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'notexec'), 'x', { mode: 0o644 });
  assert.equal(A.findOnPath('mytool', `/nonexistent:${dir}`), bin);
  if (process.platform !== 'win32') assert.equal(A.findOnPath('notexec', dir), null);
  assert.equal(A.findOnPath('nope', dir), null);
});

test('Codex through prism gets a provider pointing at prism\'s router', () => {
  const r = A.recipeFor('codex', 'prism {client}');
  assert.ok(r && /OPENAI_BASE_URL/.test(r.why));
  const args = r.args(7331);
  assert.ok(args.includes('model_providers.gateway.base_url="http://127.0.0.1:7331/v1"'));
  assert.equal(A.recipeFor('claude', 'prism {client}'), null);
  assert.equal(A.recipeFor('codex', 'other {client}'), null);
  const l = A.launch('codex', { launcher: { template: 'prism {client}' }, recipeArgs: args, platform: 'win32' });
  assert.deepEqual([l.command, ...l.args].slice(0, 4), ['prism', 'codex', '-c', 'model_provider="gateway"']);
});

test('picking up a past conversation, and naming a new one, use each client’s own flags', () => {
  const win = (id, o) => A.launch(id, { platform: 'win32', ...o });
  assert.deepEqual(win('claude', { resume: 'last' }).args, ['--continue']);
  assert.deepEqual(win('claude', { resume: 'pick' }).args, ['--resume']);
  // Codex's is a subcommand: straight after the program, before its options.
  assert.deepEqual(win('codex', { resume: 'last', model: 'gpt-5' }).args, ['resume', '--last', '-m', 'gpt-5']);
  assert.deepEqual(win('gemini', { resume: 'last' }).args, ['--resume', 'latest']);
  // No list to choose from: nothing added rather than a flag it does not take.
  assert.deepEqual(win('opencode', { resume: 'pick' }).args, []);

  const named = win('claude', { name: 'prod upgrade' });
  assert.deepEqual(named.args, ['--name', 'prod upgrade']);
  assert.equal(named.title, 'prod upgrade');
  // A resumed conversation keeps its own name; a client without a name flag gets none.
  assert.deepEqual(win('claude', { resume: 'last', name: 'x' }).args, ['--continue']);
  assert.deepEqual(win('codex', { name: 'x' }).args, []);
  assert.equal(win('codex', { name: 'x' }).title, 'x');
});
