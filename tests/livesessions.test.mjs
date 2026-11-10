import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const L = require_(path.join(__PROJECT_ROOT__, 'src/main/livesessions.js'));

/**
 * Active sessions: what `tsh sessions ls --format=json` says, read into rows,
 * and the command that joins one.
 *
 * The trackers below are trimmed from a real cluster's output — an SSH
 * session in a beam and an app session — plus a Kubernetes one, because the
 * field that names its target differs by kind and that is where a list goes
 * quietly wrong.
 */

const ssh = {
  kind: 'session_tracker', version: 'v1',
  metadata: { name: '37689402-1b94-4576-9547-45856e3fd409' },
  spec: {
    session_id: '37689402-1b94-4576-9547-45856e3fd409', kind: 'ssh', state: 1,
    created: '2026-10-06T10:50:18.871263461Z',
    target_hostname: 'beam-9be7a318-f331-4be5-be0a-e0a472790df3',
    target_address: '9be7a318-f331-4be5-be0a-e0a472790df3',
    cluster_name: 'red-fire.beams.sh', login: 'beams',
    participants: [{ id: 'x', user: 'stevenGravy@users.noreply.github.com', mode: 'peer' }],
    host_user: 'stevenGravy@users.noreply.github.com',
  },
};
const app = {
  kind: 'session_tracker',
  spec: {
    session_id: '63297a4e-c983-4224-9473-56eccaa8ae31', kind: 'app', state: 1,
    created: '2026-10-06T09:00:00Z', app_name: 'grafana', cluster_name: 'red-fire.beams.sh',
  },
};
const kube = {
  kind: 'session_tracker',
  spec: {
    session_id: 'k-1', kind: 'k8s', created: '2026-10-06T11:00:00Z',
    kubernetes_cluster: 'prod-eks', cluster_name: 'red-fire.beams.sh', login: 'steven',
    participants: [{ user: 'alice', mode: 'moderator' }],
  },
};

test('trackers become rows, newest first, with the target each kind names', () => {
  const rows = L.parseSessionList(JSON.stringify([ssh, app, kube]));
  assert.deepEqual(rows.map((r) => r.id), ['k-1', ssh.spec.session_id, app.spec.session_id]);
  const [k, s, a] = rows;
  assert.equal(s.target, 'beam-9be7a318-f331-4be5-be0a-e0a472790df3');
  assert.equal(s.login, 'beams');
  assert.deepEqual(s.participants, [{ user: 'stevenGravy@users.noreply.github.com', mode: 'peer' }]);
  assert.equal(k.target, 'prod-eks');
  assert.equal(a.target, 'grafana');
});

test('only SSH and Kubernetes sessions are joinable', () => {
  const [k, s, a] = L.parseSessionList(JSON.stringify([ssh, app, kube]));
  assert.equal(s.joinable, true);
  assert.equal(k.joinable, true);
  assert.equal(a.joinable, false);
});

test('an omitted state is pending — a moderated session waiting to start', () => {
  const [k] = L.parseSessionList(JSON.stringify([kube]));
  assert.equal(k.state, 'pending');
  assert.equal(k.joinable, true);
});

test('a terminated session is listed but not offered a join', () => {
  const done = { ...ssh, spec: { ...ssh.spec, state: 2 } };
  const [s] = L.parseSessionList(JSON.stringify([done]));
  assert.equal(s.state, 'terminated');
  assert.equal(s.joinable, false);
});

test('nothing running is an empty list, however tsh spells it', () => {
  assert.deepEqual(L.parseSessionList(''), []);
  assert.deepEqual(L.parseSessionList('null'), []);
  assert.deepEqual(L.parseSessionList('[]'), []);
});

test('join: tsh join for SSH, tsh kube join for Kubernetes, with the mode', () => {
  assert.deepEqual(
    L.joinArgs('abc', { proxy: 'red-fire.beams.sh:443', cluster: 'red-fire.beams.sh', kind: 'ssh', mode: 'peer' }),
    ['--proxy=red-fire.beams.sh:443', 'join', '--mode=peer', '--cluster=red-fire.beams.sh', 'abc']);
  assert.deepEqual(
    L.joinArgs('k-1', { kind: 'k8s', mode: 'moderator' }),
    ['kube', 'join', '--mode=moderator', 'k-1']);
});

test('join: an unknown mode falls back to watching, never to more access', () => {
  assert.deepEqual(L.joinArgs('abc', { kind: 'ssh', mode: 'admin' }), ['join', '--mode=observer', 'abc']);
});

test('join: kinds without a terminal are refused', () => {
  assert.throws(() => L.joinArgs('x', { kind: 'app', mode: 'observer' }), /cannot be joined/);
  assert.throws(() => L.joinArgs('', { kind: 'ssh' }), /no session id/);
});
