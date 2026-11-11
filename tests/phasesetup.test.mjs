import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const ps = require_(path.join(__PROJECT_ROOT__, 'src/main/phasesetup.js'));
const beams = require_(path.join(__PROJECT_ROOT__, 'src/main/beams.js'));
const yaml = require_('js-yaml');

const stage = (name, kind, setups, extra = {}) => ({ name, kind, setups, ...extra });
const docsOf = (r) => r.yaml.split('\n---\n').map((d) => yaml.load(d));

test('every setup in the catalog builds without errors from its defaults and placeholders', () => {
  for (const s of ps.SETUPS) {
    const values = Object.fromEntries((s.fields || []).map((f) => [f.key, f.default || (f.kind === 'select' ? f.options[0] : f.placeholder) || 'x']));
    const kind = s.stage === 'files' ? 'files' : 'commands';
    // A service-only setup still needs a command for its commands stage to be valid.
    const setups = [{ id: s.id, values }];
    if (kind === 'commands' && s.stage === 'any') setups.push({ id: 'command', values: { shell: 'true' } });
    const r = ps.build([stage('one', kind, setups)], { home: '/Users/me', exists: () => true });
    assert.deepEqual(r.errors, [], `${s.id}: ${r.errors.join('; ')}`);
  }
});

test('stages chain: each later stage builds on the one before, the first on its chosen parent', () => {
  const r = ps.build([
    stage('tools', 'commands', [{ id: 'go' }], { from: 'workspace' }),
    stage('files', 'files', [{ id: 'copy', values: { from: '/tmp/x', to: '/opt/x' } }]),
  ], { exists: () => true });
  assert.deepEqual(r.errors, []);
  const [a, b] = docsOf(r);
  assert.equal(a.metadata.from, 'workspace');
  assert.equal(b.metadata.from, 'tools');
  assert.ok(a.commands.length && !a.files);
  assert.deepEqual(b.files, [{ comment: 'Copy x', from: '/tmp/x', to: '/opt/x' }]);
  assert.ok(r.yaml.startsWith('# A Phase setup made in ServerLife'));
});

test('the default image is left out of from:, as tsh writes it', () => {
  const r = ps.build([stage('tools', 'commands', [{ id: 'uv' }], { from: 'default:v1' })]);
  assert.equal(docsOf(r)[0].metadata.from, undefined);
});

test('names follow the Phase rules: DNS label, 54 characters, unique', () => {
  const bad = (name) => ps.build([stage(name, 'commands', [{ id: 'uv' }])]).errors;
  assert.ok(bad('My_Phase').length);
  assert.ok(bad('-leading').length);
  assert.ok(bad('a'.repeat(55)).length);
  assert.deepEqual(bad('a'.repeat(54)), []);
  const dup = ps.build([stage('x', 'commands', [{ id: 'uv' }]), stage('x', 'commands', [{ id: 'uv' }])]).errors;
  assert.ok(dup.some((e) => /already has this name/.test(e)));
});

test('a commands stage needs a command; a files stage may be empty', () => {
  assert.ok(ps.build([stage('a', 'commands', [])]).errors.some((e) => /at least one command/.test(e)));
  const r = ps.build([stage('a', 'files', [])]);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(docsOf(r)[0].files, []);
});

test('setups only go in the stage kind they belong to', () => {
  const r = ps.build([stage('a', 'files', [{ id: 'go' }])]);
  assert.ok(r.errors.some((e) => /commands stage/.test(e)));
  const r2 = ps.build([stage('a', 'commands', [{ id: 'copy', values: { from: '/x', to: '/opt/x' } }])]);
  assert.ok(r2.errors.some((e) => /copy-files stage/.test(e)));
});

test('copied files go outside /home, to absolute paths, from files that exist', () => {
  const run = (to, exists = true) => ps.build([stage('a', 'files', [{ id: 'copy', values: { from: '/tmp/x', to } }])], { exists: () => exists }).errors;
  assert.ok(run('/home/beams/x').some((e) => /outside \/home/.test(e)));
  assert.ok(run('/home').some((e) => /outside \/home/.test(e)));
  assert.ok(run('opt/x').some((e) => /absolute/.test(e)));
  assert.ok(run('/opt/x', false).some((e) => /not on this computer/.test(e)));
  assert.deepEqual(run('/opt/x'), []);
});

test('dotfiles keep their place relative to home and are put there on first start without replacing', () => {
  const r = ps.build([stage('dots', 'files', [{ id: 'dotfiles', values: { paths: '~/.gitconfig\n~/.claude/settings.json' } }])], { home: '/Users/me' });
  assert.deepEqual(r.errors, []);
  const d = docsOf(r)[0];
  assert.deepEqual(d.files.map((f) => [f.from, f.to]), [
    ['/Users/me/.gitconfig', `${ps.HOME_STAGING}/.gitconfig`],
    ['/Users/me/.claude/settings.json', `${ps.HOME_STAGING}/.claude/settings.json`],
  ]);
  assert.equal(d.services[0].type, 'pre-start');
  assert.match(d.services[0].shell, /^cp -Rn /);
  const replace = ps.build([stage('dots', 'files', [{ id: 'dotfiles', values: { paths: '~/.vimrc', replace: 'yes' } }])], { home: '/Users/me' });
  assert.match(docsOf(replace)[0].services[0].shell, /^cp -Rf /);
});

test('services: names, kinds and contexts are checked, and a repeated name is caught', () => {
  const svc = (values) => ps.build([stage('a', 'commands', [{ id: 'command', values: { shell: 'true' } }, { id: 'service', values }])]).errors;
  assert.deepEqual(svc({ name: 'web', shell: 'exec x', type: 'background', context: 'runtime' }), []);
  assert.ok(svc({ name: 'bootstrap', shell: 'x' }).length);
  assert.ok(svc({ name: 'bad name', shell: 'x' }).length);
  assert.ok(svc({ name: 'web', shell: 'x', context: 'sometimes' }).length);
  const twice = ps.build([stage('a', 'commands', [{ id: 'redis' }, { id: 'service', values: { name: 'redis', shell: 'x' } }])]).errors;
  assert.ok(twice.some((e) => /two services are called "redis"/.test(e)));
});

test('a required field left empty is pointed at', () => {
  const r = ps.build([stage('a', 'commands', [{ id: 'apt', values: { packages: '' } }])]);
  assert.ok(r.errors.some((e) => /"Packages" is needed/.test(e)));
});

test('environment variables become quoted exports; a line that is not NAME=value is refused', () => {
  const r = ps.build([stage('a', 'commands', [{ id: 'env', values: { vars: "EDITOR=vim\nGREETING=hello world\nQUOTE=it's" } }])]);
  assert.deepEqual(r.errors, []);
  const shell = docsOf(r)[0].commands[0].shell;
  assert.match(shell, /export EDITOR=vim/);
  assert.match(shell, /export GREETING='hello world'/);
  assert.match(shell, /export QUOTE='it'\\''s'/);
  assert.ok(ps.build([stage('a', 'commands', [{ id: 'env', values: { vars: 'not a var' } }])]).errors.length);
});

test('rebuilding dependencies under /home reserves that folder (rebuild_home_paths)', () => {
  const r = ps.build([stage('deps', 'commands', [{ id: 'deps-under-home' }], { from: 'app-source' })]);
  assert.deepEqual(r.errors, []);
  const d = docsOf(r)[0];
  assert.deepEqual(d.metadata.rebuild_home_paths, ['/home/beams/app/node_modules']);
  assert.equal(d.commands[0].workdir, '/home/beams/app');
  const bad = ps.build([stage('deps', 'commands', [{ id: 'deps-under-home', values: { reserve: '/home/beams/*' } }])]).errors;
  assert.ok(bad.some((e) => /without wildcards/.test(e)));
});

test('a working folder must be a clean absolute path, and reserved build variables are refused', () => {
  assert.ok(ps.build([stage('a', 'commands', [{ id: 'command', values: { shell: 'x', workdir: 'relative' } }])]).errors.length);
  assert.ok(ps.build([stage('a', 'commands', [{ id: 'command', values: { shell: 'x', workdir: '/a/../b' } }])]).errors.length);
  assert.equal(ps.build([stage('a', 'commands', [{ id: 'command', values: { shell: 'x', workdir: '/srv' } }])]).errors.length, 0);
});

test('a stage too big for the 32 KiB build configuration is refused', () => {
  const r = ps.build([stage('a', 'commands', [{ id: 'command', values: { shell: 'x'.repeat(33 * 1024) } }])]);
  assert.ok(r.errors.some((e) => /32768/.test(e)));
});

test('the catalog is plain data the renderer can take', () => {
  const c = ps.catalog();
  assert.ok(c.setups.length >= 15);
  for (const s of c.setups) assert.equal(typeof s.expand, 'undefined');
  assert.doesNotThrow(() => JSON.stringify(c));
});

test('apply, copy, no-console and edit arguments', () => {
  const tail = (args) => args.slice(args.indexOf('phase'));
  assert.deepEqual(tail(beams.phaseApplyArgs({ file: '/tmp/p.yaml', noConsole: true, region: 'us-west-2' })),
    ['phase', 'apply', '--file=/tmp/p.yaml', '--no-console', '--region=us-west-2']);
  assert.throws(() => beams.phaseApplyArgs({}), /phase.yaml/);
  assert.deepEqual(tail(beams.phaseAddArgs({ name: 'files', copies: [{ from: './config', to: '/opt/app/config' }], noConsole: true })),
    ['phase', 'add', 'files', '--copy=/opt/app/config:./config', '--no-console']);
  assert.throws(() => beams.phaseAddArgs({ copies: [{ from: 'x', to: '/home/beams/x' }] }), /outside \/home/);
  assert.throws(() => beams.phaseAddArgs({ copies: [{ from: 'x', to: '/opt/x' }], commandsFile: 'c.yaml' }), /not with a command file/);
  assert.deepEqual(tail(beams.phaseEditArgs({ name: 'tools', commandsFile: '/tmp/b.yaml' })), ['phase', 'edit', 'tools', '--commands-file=/tmp/b.yaml']);
  assert.deepEqual(tail(beams.phaseEditArgs({ name: 'files', copies: [{ from: '/a', to: '/opt/a' }] })), ['phase', 'edit', 'files', '--copy=/opt/a:/a']);
  assert.throws(() => beams.phaseEditArgs({ name: 'x', from: 'y', commandsFile: 'c' }), /takes no command file/);
});

test("beamctl's service map is read as names and states", () => {
  // As `beamctl --json list` printed it in a Beam built from these setups.
  const out = beams.servicesFrom({
    web: { running: { main_pid: 165, pty: null } },
    'clone-hello': { exited: { reason: 'exited', code: 0 } },
    broken: { exited: { reason: 'exited', code: 2 } },
  });
  assert.deepEqual(out.map((s) => [s.name, s.status]), [
    ['broken', 'exited with 2'], ['clone-hello', 'finished'], ['web', 'running (pid 165)'],
  ]);
});

/* ---- Add-ins ---- */
const fsMod = require_('fs');
const osMod = require_('os');

const NODE_ADDIN = `
label: Our Node toolchain
group: Team setups
stage: commands
fields:
  - { key: version, label: Node version, default: "22", required: true }
  - { key: registry, label: Registry, default: "https://npm.example.com/a b" }
commands:
  - comment: Install Node {{version}}
    shell: curl -fsSL https://deb.nodesource.com/setup_{{version}}.x | bash - && npm config set registry {{registry|sh}}
`;

test('an add-in is read into a setup, and its {{fields}} filled in — |sh quoted', () => {
  const a = ps.parseAddin(NODE_ADDIN, 'node-team');
  assert.equal(a.id, 'addin:node-team');
  assert.equal(a.group, 'Team setups');
  const out = a.expand({ version: '20', registry: "https://npm.example.com/a b" });
  assert.equal(out.commands[0].comment, 'Install Node 20');
  assert.match(out.commands[0].shell, /setup_20\.x/);
  assert.match(out.commands[0].shell, /registry 'https:\/\/npm\.example\.com\/a b'$/);
});

test('an add-in goes through the same stage checks as the built-in setups', () => {
  const a = ps.parseAddin(NODE_ADDIN, 'node-team');
  const ok = ps.build([stage('tools', 'commands', [{ id: a.id, values: { version: '22' } }])], { addins: [a] });
  assert.deepEqual(ok.errors, []);
  assert.match(ok.yaml, /comment: Install Node 22/);
  const empty = ps.build([stage('tools', 'commands', [{ id: a.id, values: { version: '' } }])], { addins: [a] });
  assert.ok(empty.errors.some((e) => /"Node version" is needed/.test(e)));
  const gone = ps.build([stage('tools', 'commands', [{ id: 'addin:nope' }])], { addins: [a] });
  assert.ok(gone.errors.some((e) => /add-in not found/.test(e)));
});

test('add-in mistakes are named', () => {
  const bad = (text) => { try { ps.parseAddin(text, 'x'); return null; } catch (e) { return e.message; } };
  assert.match(bad('label: [unclosed'), /not YAML/);
  assert.match(bad('commands: []'), /needs a label/);
  assert.match(bad('label: x\nstage: commands\ncomand:\n  - shell: true'), /unknown key: comand/);
  assert.match(bad('label: x\nstage: commands\ncommands:\n  - shell: echo {{versoin}}'), /uses \{\{versoin\}\} but has no such field/);
  assert.match(bad('label: x\nstage: files\ncommands:\n  - shell: true'), /files add-in runs no commands/);
  assert.match(bad('label: x\nstage: any\ncommands:\n  - shell: true'), /can only add services/);
  assert.match(bad('label: x\nstage: commands'), /adds nothing/);
  assert.match(bad('label: x\nfields:\n  - { key: k, kind: select }\ncommands:\n  - shell: true'), /select needs options/);
  assert.equal(bad(ps.ADDIN_TEMPLATE), null, 'the template a new add-in starts from is itself valid');
});

test('a folder of add-ins: the good ones loaded, a bad one reported, not fatal', () => {
  const dir = fsMod.mkdtempSync(path.join(osMod.tmpdir(), 'sl-addins-'));
  try {
    fsMod.writeFileSync(path.join(dir, 'node-team.yaml'), NODE_ADDIN);
    fsMod.writeFileSync(path.join(dir, 'broken.yaml'), 'label: x\n');
    fsMod.writeFileSync(path.join(dir, 'notes.txt'), 'not an add-in');
    const r = ps.loadAddins(dir);
    assert.deepEqual(r.addins.map((a) => a.id), ['addin:node-team']);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0].file, /broken\.yaml$/);
    const cat = ps.catalog(r.addins);
    assert.ok(cat.setups.some((s) => s.id === 'addin:node-team' && s.addin));
    assert.doesNotThrow(() => JSON.stringify(cat));
  } finally { fsMod.rmSync(dir, { recursive: true, force: true }); }
  assert.deepEqual(ps.loadAddins('/no/such/folder').addins, [], 'a folder not made yet is just none');
});

/* ---- Opening an existing phase.yaml ---- */
test('an opened phase.yaml becomes the same stages, and builds back to the same documents', () => {
  const text = `version: v1
metadata:
  name: app-tools
  from: workspace
commands:
  - comment: Install tools
    command: /bin/sh
    args: [-c, "apt-get update && apt-get install -y git"]
    env: [{ name: DEBIAN_FRONTEND, value: noninteractive }]
---
version: v1
metadata:
  name: app-config
  from: app-tools
files:
  - from: ./config
    to: /opt/app-config
services:
  - name: prepare-config
    type: pre-start
    shell: cp /opt/app-config/app.json /home/beams/app.json
---
version: v1
metadata:
  name: app-deps
  from: app-config
  rebuild_home_paths: [/home/beams/app/node_modules]
commands:
  - command: npm
    args: [ci]
    workdir: /home/beams/app
`;
  const r = ps.fromYaml(text, { dir: '/work/project' });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.stages.map((s) => [s.name, s.from, s.kind]), [['app-tools', 'workspace', 'commands'], ['app-config', '', 'files'], ['app-deps', '', 'commands']]);
  const built = ps.build(r.stages, { exists: () => true });
  assert.deepEqual(built.errors, []);
  const want = yaml.loadAll(text);
  want[1].files[0].from = '/work/project/config';   // made absolute against the file's folder
  assert.deepEqual(yaml.loadAll(built.yaml), want);
});

test('opening: a raw command file is one stage; a broken chain and stray keys are said', () => {
  const raw = ps.fromYaml('commands:\n  - command: /bin/true\n');
  assert.equal(raw.stages.length, 1);
  assert.equal(raw.stages[0].kind, 'commands');
  const odd = ps.fromYaml('version: v1\nmetadata: { name: a }\ncommands: [{ shell: x }]\nnotes: hi\n---\nversion: v1\nmetadata: { name: b, from: zzz }\ncommands: [{ shell: y }]\n');
  assert.ok(odd.warnings.some((w) => /left out notes/.test(w)));
  assert.ok(odd.warnings.some((w) => /was built on zzz/.test(w)));
  assert.throws(() => ps.fromYaml(''), /empty/);
  assert.throws(() => ps.fromYaml('a: [b'), /not YAML/);
});

test('"Written in YAML" keeps to its stage kind', () => {
  const r = ps.build([stage('a', 'files', [{ id: 'raw', values: { yaml: 'commands:\n  - shell: true' } }])]);
  assert.ok(r.errors.some((e) => /runs no commands/.test(e)));
  const r2 = ps.build([stage('a', 'commands', [{ id: 'raw', values: { yaml: 'comands:\n  - shell: true' } }])]);
  assert.ok(r2.errors.some((e) => /unknown key: comands/.test(e)));
});
