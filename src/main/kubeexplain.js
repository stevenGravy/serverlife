'use strict';
/**
 * Field names for the YAML editor's own autocomplete — asked straight
 * from `kubectl explain <kind> --recursive`, the cluster's own answer to
 * "what fields does this kind have," CRDs included automatically. No
 * bundled schema to go stale: the same reasoning `kuberesources.js`'s
 * `discoverResourceTypes()`/`crdColumnsFor()` already use for "what kinds
 * exist" and "what columns does this CRD have."
 */

const { execFile } = require('child_process');
const kube = require('./kube');

function run(bin, args, { env, timeout = 15000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer, env },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

function plain(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '').trim();
}

const FIELD_LINE = /^(\s*)([A-Za-z0-9_-]+)\t<([^>]+)>/;

/**
 * `kubectl explain --recursive`'s plaintext tree, one field per line
 * (name, a tab, its type in angle brackets, optionally ` -required-` and
 * an `enum:` note on the following line — neither a field of its own) —
 * indentation nests it, tracked with a stack rather than assuming a
 * fixed number of spaces per level.
 */
function parseExplainFields(text) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((l) => l.trim() === 'FIELDS:');
  if (start === -1) return [];
  const fields = [];
  const stack = []; // [{ indent, name }], shallowest first
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(FIELD_LINE);
    if (!m) continue;
    const indent = m[1].length;
    const name = m[2];
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    fields.push({ path: [...stack.map((s) => s.name), name].join('.'), type: m[3] });
    stack.push({ indent, name });
  }
  return fields;
}

/** `--api-version` disambiguates a kind name that exists in more than one group/version — most useful for CRDs. */
async function explainFields(spec = {}, { kind, apiVersion } = {}) {
  if (!kind) return { ok: false, error: 'No kind to explain.', fields: [] };
  const { bin, baseArgs, env } = kube.kubectlArgsFor(spec);
  const args = [...baseArgs, 'explain', kind, '--recursive'];
  if (apiVersion) args.push(`--api-version=${apiVersion}`);
  const r = await run(bin, args, { env });
  if (!r.ok) return { ok: false, error: plain(r.stderr) || 'kubectl explain failed', fields: [] };
  return { ok: true, fields: parseExplainFields(r.stdout) };
}

module.exports = { parseExplainFields, explainFields };
