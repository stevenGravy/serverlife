import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const jp = require_(path.join(__PROJECT_ROOT__, 'src/main/jsonpath-lite.js'));

/** The fixture is cert-manager's own `Certificate` CRD — exactly the additionalPrinterColumns shape real CRDs use. */
const certificate = {
  status: {
    conditions: [
      { type: 'Ready', status: 'True', message: 'Certificate is up to date and has not expired' },
      { type: 'Issuing', status: 'False', message: 'Not issuing' },
    ],
  },
  spec: {
    secretName: 'web-tls',
    issuerRef: { name: 'letsencrypt-prod' },
    containers: [{ image: 'nginx:1.27' }],
  },
};

test('a plain dot path', () => {
  assert.equal(jp.resolve(certificate, '.spec.secretName'), 'web-tls');
  assert.equal(jp.resolve(certificate, '.spec.issuerRef.name'), 'letsencrypt-prod');
});

test('a numeric array index', () => {
  assert.equal(jp.resolve(certificate, '.spec.containers[0].image'), 'nginx:1.27');
});

test('the predicate filter cert-manager\'s own Certificate CRD actually uses', () => {
  assert.equal(jp.resolve(certificate, '.status.conditions[?(@.type == "Ready")].status'), 'True');
  assert.equal(jp.resolve(certificate, '.status.conditions[?(@.type == "Ready")].message'),
    'Certificate is up to date and has not expired');
});

test('the filter works with no surrounding spaces too', () => {
  assert.equal(jp.resolve(certificate, '.status.conditions[?(@.type=="Issuing")].status'), 'False');
});

test('!= is supported', () => {
  const r = jp.resolve(certificate, '.status.conditions[?(@.type != "Ready")].type');
  assert.equal(r, 'Issuing');
});

test('a filter matching nothing resolves to undefined, not a throw', () => {
  assert.equal(jp.resolve(certificate, '.status.conditions[?(@.type == "DoesNotExist")].status'), undefined);
});

test('a path through something that is not there resolves to undefined', () => {
  assert.equal(jp.resolve({}, '.status.conditions[?(@.type == "Ready")].status'), undefined);
  assert.equal(jp.resolve(certificate, '.spec.nope.alsoNope'), undefined);
});

test('the {.x.y} wrapper some CRDs still use is stripped', () => {
  assert.equal(jp.resolve(certificate, '{.spec.secretName}'), 'web-tls');
});

test('a leading dot is optional', () => {
  assert.equal(jp.resolve(certificate, 'spec.secretName'), jp.resolve(certificate, '.spec.secretName'));
});
