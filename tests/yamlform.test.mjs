import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildValuesYaml } from '../src/renderer/js/yamlform.js';

const yaml = createRequire(import.meta.url)('js-yaml');

test('buildValuesYaml nests dotted paths into proper indentation', () => {
  const text = buildValuesYaml([{ path: 'auth.rootPassword', value: 'secret' }, { path: 'architecture', value: 'standalone' }]);
  const parsed = yaml.load(text);
  assert.deepEqual(parsed, { auth: { rootPassword: 'secret' }, architecture: 'standalone' });
});

test('buildValuesYaml quotes string scalars safely, even ones that would otherwise read as YAML syntax', () => {
  const text = buildValuesYaml([{ path: 'k', value: 'yes: no, true: false' }]);
  const parsed = yaml.load(text);
  assert.equal(parsed.k, 'yes: no, true: false');
});

test('buildValuesYaml leaves boolean and number scalars unquoted', () => {
  const text = buildValuesYaml([{ path: 'a', value: true }, { path: 'b', value: 42 }]);
  assert.match(text, /^a: true$/m);
  assert.match(text, /^b: 42$/m);
});

test('buildValuesYaml merges two paths sharing a parent rather than overwriting it', () => {
  const text = buildValuesYaml([{ path: 'auth.username', value: 'root' }, { path: 'auth.password', value: 'pw' }]);
  const parsed = yaml.load(text);
  assert.deepEqual(parsed, { auth: { username: 'root', password: 'pw' } });
});

test('buildValuesYaml nests three levels deep correctly', () => {
  const text = buildValuesYaml([{ path: 'primary.podSecurityContext.enabled', value: false }]);
  const parsed = yaml.load(text);
  assert.deepEqual(parsed, { primary: { podSecurityContext: { enabled: false } } });
});

test('buildValuesYaml returns empty text for no fields at all', () => {
  assert.equal(buildValuesYaml([]), '');
  assert.equal(buildValuesYaml(undefined), '');
});
