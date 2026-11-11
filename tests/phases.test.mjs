import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const teleport = require_(path.join(__PROJECT_ROOT__, 'src/main/teleport.js'));
const beams = require_(path.join(__PROJECT_ROOT__, 'src/main/beams.js'));

/**
 * Starting a beam from a Phase, delegating roles to it, and knowing when not
 * to offer either.
 *
 * Both are newer than beams — 18.11.7's tsh lists and starts beams but has no
 * `tsh phase`, no `beams add --phase` and no `--roles` — so whether to offer
 * them is asked of the tsh binary, from its own help text. The fixtures are
 * that help text, captured from tsh 18.11.7 (no Phases) and 18.11.9 (Phases).
 */

const fixture = (name) => readFileSync(path.join(__PROJECT_ROOT__, 'tests/fixtures/tsh-help', name), 'utf8');
// tsh prints help to stdout and exits 0; an unknown command goes to stderr.
const WITHOUT = {
  'beams add --help': { ok: true, stdout: fixture('v18.11.7-beams-add.txt'), stderr: '' },
  'phase --help': { ok: false, stdout: '', stderr: fixture('v18.11.7-phase.txt') },
};
const WITH = {
  'beams add --help': { ok: true, stdout: fixture('v18.11.9-beams-add.txt'), stderr: '' },
  'phase --help': { ok: true, stdout: fixture('v18.11.9-phase.txt'), stderr: '' },
};

let tshPath = 0;
function fakeTsh(answers) {
  const calls = [];
  // A fresh binary path each time, since the answer is cached per binary.
  const p = `/opt/tsh-${++tshPath}`;
  teleport.findTsh = () => p;
  teleport.run = async (args) => {
    calls.push(args);
    const key = args.filter((a) => !a.startsWith('--proxy')).join(' ');
    const a = answers[key];
    if (!a) throw new Error('unexpected tsh call: ' + key);
    return typeof a === 'string' ? { ok: true, stdout: a, stderr: '' } : a;
  };
  return calls;
}

test('a tsh without them (18.11.7) is offered neither Phases nor roles', async () => {
  fakeTsh(WITHOUT);
  const r = await beams.addSupport({});
  assert.deepEqual({ phases: r.phases, roles: r.roles, apply: r.apply }, { phases: false, roles: false, apply: false });
});

test('a tsh with them (18.11.9) is offered both', async () => {
  fakeTsh(WITH);
  const r = await beams.addSupport({});
  assert.deepEqual({ phases: r.phases, roles: r.roles }, { phases: true, roles: true });
});

test('apply, --copy and --no-console are read from tsh phase --help and tsh phase add --help', async () => {
  fakeTsh({
    ...WITH,
    'phase --help': WITH['phase --help'] + '\n  phase apply     Create or update Phases from a multi-document YAML configuration.\n',
    'phase add --help': '      --[no-]console  Open an interactive shell or stream command logs.\n      --copy=COPY ...  Copy files outside /home\n',
  });
  const r = await beams.addSupport({});
  assert.deepEqual({ apply: r.apply, copy: r.copy, noConsole: r.noConsole }, { apply: true, copy: true, noConsole: true });
});

test('Phases need both: --phase on beams add without tsh phase is not enough', async () => {
  fakeTsh({ 'beams add --help': WITH['beams add --help'], 'phase --help': WITHOUT['phase --help'] });
  const r = await beams.addSupport({});
  assert.equal(r.phases, false);
  assert.equal(r.roles, true, 'roles only needs the flag');
});

test('the answer is kept per tsh binary, so it is asked once', async () => {
  const calls = fakeTsh(WITH);
  await beams.addSupport({});
  await beams.addSupport({});
  assert.equal(calls.length, 3, 'three help calls, the first time only');
});

test('tsh phase ls is read into the fields the picker shows', async () => {
  fakeTsh({
    'phase ls --format=json': JSON.stringify([{
      name: 'sage-garden', owner: 'stevenGravy@users.noreply.github.com', strategy: 'snapshot', parent: 'default:v1',
      state: 'ready', image_digest: 'sha256:34eada19f8', region: 'us-west-2',
      published_at: '2026-11-05T21:29:20.21254155Z',
    }]),
  });
  const r = await beams.phases({ proxy: 'red-fire.beams.sh:443' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.phases[0], {
    name: 'sage-garden', state: 'ready', parent: 'default:v1', region: 'us-west-2',
    digest: 'sha256:34eada19f8', owner: 'stevenGravy@users.noreply.github.com', strategy: 'snapshot', roles: [],
    publishedAt: Date.parse('2026-11-05T21:29:20.21254155Z'), nextBuild: null, lastError: '', buildBeam: '',
  });
});

test('a beam started from a Phase with roles passes both, and a plain one neither', async () => {
  const beam = JSON.stringify({ alias: 'quick-fox', id: 'b1', region: 'us-west-2' });
  const calls = fakeTsh({
    'beams add --format=json --phase=sage-garden --roles=access,beam-user': beam,
    'beams add --format=json': beam,
  });
  await beams.add({ proxy: 'red-fire.beams.sh:443', phase: 'sage-garden', roles: ['access', 'beam-user'] });
  await beams.add({ proxy: 'red-fire.beams.sh:443', roles: [] });
  assert.ok(calls[0].includes('--phase=sage-garden'));
  assert.ok(calls[0].includes('--roles=access,beam-user'));
  assert.ok(!calls[1].some((a) => a.startsWith('--phase') || a.startsWith('--roles')), 'no roles ticked: no flag');
});

test('a tsh that cannot be run at all is offered nothing, without throwing', async () => {
  teleport.findTsh = () => `/opt/tsh-missing-${++tshPath}`;
  teleport.run = async () => { throw new Error('spawn tsh ENOENT'); };
  const can = await beams.addSupport({});
  assert.deepEqual({ phases: can.phases, roles: can.roles, apply: can.apply }, { phases: false, roles: false, apply: false });
  const r = await beams.phases({});
  assert.equal(r.ok, false);
  assert.deepEqual(r.phases, []);
});

test('a cluster that will not list Phases says so, and the beam still starts plainly', async () => {
  fakeTsh({ 'phase ls --format=json': { ok: false, stdout: '', stderr: 'ERROR: access denied to perform action "list" on "beam_phase"' } });
  const r = await beams.phases({ proxy: 'red-fire.beams.sh:443' });
  assert.equal(r.ok, false);
  assert.match(r.error, /access denied/);
});

test('a new Phase from the default image is just tsh phase add, with a name if given', () => {
  assert.deepEqual(beams.phaseAddArgs({ proxy: 'red-fire.beams.sh:443' }),
    ['--proxy=red-fire.beams.sh:443', 'phase', 'add']);
  assert.deepEqual(beams.phaseAddArgs({ name: 'dev-tools' }), ['phase', 'add', 'dev-tools']);
});

test('built on another Phase is --from; forked from one is --fork-from', () => {
  assert.deepEqual(beams.phaseAddArgs({ name: 'project-tools', from: 'sage-garden' }),
    ['phase', 'add', 'project-tools', '--from=sage-garden']);
  assert.deepEqual(beams.phaseAddArgs({ name: 'my-fork', forkFrom: 'sage-garden@sha256:34eada19f8' }),
    ['phase', 'add', 'my-fork', '--fork-from=sage-garden@sha256:34eada19f8']);
  assert.throws(() => beams.phaseAddArgs({ from: 'a', forkFrom: 'b' }), /not both/);
});

test('roles and region are passed only when chosen', () => {
  assert.deepEqual(beams.phaseAddArgs({ name: 'x', roles: ['access', 'beam-user'], region: 'us-west-2' }),
    ['phase', 'add', 'x', '--roles=access,beam-user', '--region=us-west-2']);
  assert.deepEqual(beams.phaseAddArgs({ name: 'x', roles: [] }), ['phase', 'add', 'x']);
});

test('editing a Phase in place is tsh phase edit, and needs a name', () => {
  assert.deepEqual(beams.phaseEditArgs({ proxy: 'p:443', name: 'sage-garden' }),
    ['--proxy=p:443', 'phase', 'edit', 'sage-garden']);
  assert.throws(() => beams.phaseEditArgs({}), /Which Phase/);
});

test('a command-file build passes --commands-file, on the base image or on a Phase, but never on a fork', () => {
  assert.deepEqual(beams.phaseAddArgs({ name: 'dev-tools', commandsFile: '/tmp/build.yaml' }),
    ['phase', 'add', 'dev-tools', '--commands-file=/tmp/build.yaml']);
  assert.deepEqual(beams.phaseAddArgs({ name: 'p', from: 'dev-tools', commandsFile: '/tmp/b.yaml' }),
    ['phase', 'add', 'p', '--from=dev-tools', '--commands-file=/tmp/b.yaml']);
  assert.throws(() => beams.phaseAddArgs({ forkFrom: 'dev-tools', commandsFile: '/tmp/b.yaml' }), /no command file/);
});

test('tsh phase ls-failed is read into a phase, its snapshot and when', async () => {
  fakeTsh({
    'phase ls-failed --format=json': JSON.stringify([{
      phase: 'dev-tools', digest: 'sha256:abc123', timestamp: '2026-11-05T21:00:00Z', expiration: '2026-11-12T21:00:00Z',
    }]),
  });
  const r = await beams.failedPhases({ proxy: 'red-fire.beams.sh:443' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.failed, [{
    phase: 'dev-tools', digest: 'sha256:abc123', at: Date.parse('2026-11-05T21:00:00Z'), expires: Date.parse('2026-11-12T21:00:00Z'),
  }]);
});

test('an empty ls-failed is an empty list, not an error', async () => {
  fakeTsh({ 'phase ls-failed --format=json': '[]' });
  assert.deepEqual(await beams.failedPhases({}), { ok: true, failed: [] });
});
