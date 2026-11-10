import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const K = require_(path.join(__PROJECT_ROOT__, 'src/main/kubehelm.js'));

/**
 * Only `fieldsFromSchema` — a pure function. Everything else in
 * kubehelm.js is an IO wrapper around a real `helm` binary and real
 * charts, verified for real while building this (see the Section 7
 * verification notes), the same boundary every other kube*.test.mjs
 * keeps. The fixture below is trimmed from the real
 * `values.schema.json` of a real public chart (bitnami/mysql) that was
 * actually pulled and inspected while planning this.
 */

const MYSQL_SCHEMA_EXCERPT = {
  $schema: 'http://json-schema.org/schema#',
  type: 'object',
  properties: {
    architecture: {
      type: 'string', title: 'MySQL architecture', form: true,
      description: 'Allowed values: `standalone` or `replication`',
      enum: ['standalone', 'replication'],
    },
    auth: {
      type: 'object', title: 'Authentication configuration', form: true,
      properties: {
        rootPassword: { type: 'string', title: 'MySQL root password' },
        username: { type: 'string', title: 'MySQL custom username' },
      },
    },
    primary: {
      type: 'object', title: 'Primary database configuration', form: true,
      properties: {
        podSecurityContext: {
          type: 'object', title: 'Pod security context',
          properties: {
            enabled: { type: 'boolean', default: false },
            fsGroup: { type: 'integer', default: 1001 },
          },
        },
        extraVolumes: { type: 'array', title: 'Extra volumes' },
      },
    },
  },
};

test('fieldsFromSchema flattens top-level scalar fields with their own metadata', () => {
  const fields = K.fieldsFromSchema(MYSQL_SCHEMA_EXCERPT);
  const arch = fields.find((f) => f.path === 'architecture');
  assert.equal(arch.type, 'string');
  assert.equal(arch.title, 'MySQL architecture');
  assert.deepEqual(arch.enum, ['standalone', 'replication']);
});

test('fieldsFromSchema descends into a nested object, building a dotted path', () => {
  const fields = K.fieldsFromSchema(MYSQL_SCHEMA_EXCERPT);
  const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
  assert.equal(byPath['auth.rootPassword'].type, 'string');
  assert.equal(byPath['auth.username'].title, 'MySQL custom username');
});

test('fieldsFromSchema descends several levels deep, reading defaults', () => {
  const fields = K.fieldsFromSchema(MYSQL_SCHEMA_EXCERPT);
  const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
  assert.equal(byPath['primary.podSecurityContext.enabled'].default, false);
  assert.equal(byPath['primary.podSecurityContext.fsGroup'].default, 1001);
});

test('fieldsFromSchema lists an array field but does not descend into it', () => {
  const fields = K.fieldsFromSchema(MYSQL_SCHEMA_EXCERPT);
  const extra = fields.find((f) => f.path === 'primary.extraVolumes');
  assert.equal(extra.type, 'array');
  assert.ok(!fields.some((f) => f.path.startsWith('primary.extraVolumes.')));
});

test('fieldsFromSchema stops descending past maxDepth, keeping the object itself as one field', () => {
  const fields = K.fieldsFromSchema(MYSQL_SCHEMA_EXCERPT, 2);
  assert.ok(fields.some((f) => f.path === 'primary.podSecurityContext' && f.type === 'object'));
  assert.ok(!fields.some((f) => f.path === 'primary.podSecurityContext.enabled'));
});

test('fieldsFromSchema handles a schema with no properties at all', () => {
  assert.deepEqual(K.fieldsFromSchema({}), []);
  assert.deepEqual(K.fieldsFromSchema(null), []);
});
