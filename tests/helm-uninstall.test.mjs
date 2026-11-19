import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const H = require_(path.join(__PROJECT_ROOT__, 'src/main/kubehelm.js'));

/**
 * What an uninstall says it removed. helm names the resources only in its
 * --debug output, and Helm 3 and Helm 4 word that differently; and the
 * dialog's options reach helm as flags, so what can be typed there is
 * checked before it does.
 */

test('Helm 4: each resource the release owned, once, in order', () => {
  const stderr = [
    'level=DEBUG msg="getting release history" name=web',
    'level=DEBUG msg="deleting resource owned by this release" kind=Service name=web-svc namespace=apps release=web',
    'level=DEBUG msg="deleting resource owned by this release" kind=Deployment name=web namespace=apps release=web',
    'level=DEBUG msg="starting delete resource" namespace=apps name=web-svc kind=Service',
  ].join('\n');
  assert.deepEqual(H.deletedResources(stderr), ['Service/web-svc', 'Deployment/web']);
});

test('Helm 3: the same, from its prose', () => {
  const stderr = [
    'uninstall.go:95: [debug] uninstall: Deleting web',
    'client.go:477: [debug] Starting delete for "web-svc" Service',
    'client.go:477: [debug] Starting delete for "web" Deployment',
  ].join('\n');
  assert.deepEqual(H.deletedResources(stderr), ['Service/web-svc', 'Deployment/web']);
});

test('options become flags, and nothing else does', () => {
  assert.deepEqual(H.uninstallFlags({ noHooks: true, keepHistory: true, wait: true, cascade: 'foreground', timeout: '90s', description: 'tidy' }),
    ['--no-hooks', '--keep-history', '--wait', '--cascade', 'foreground', '--timeout', '90s', '--description', 'tidy']);
  assert.deepEqual(H.uninstallFlags({}), []);
  assert.deepEqual(H.uninstallFlags({ timeout: '1h30m' }), ['--timeout', '1h30m']);
  assert.throws(() => H.uninstallFlags({ timeout: '5 minutes' }), /timeout/);
  assert.throws(() => H.uninstallFlags({ timeout: '--dry-run' }), /timeout/);
  assert.throws(() => H.uninstallFlags({ cascade: 'everything' }), /cascade/);
});
