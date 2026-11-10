/**
 * Turns a flat `[{path, value}]` (from the Helm install/upgrade
 * wizard's own values-schema form — see `kubehelm.js`'s
 * `fieldsFromSchema()`) into a values YAML block — a generator, not a
 * live two-way binding onto whatever YAML was already in the textarea.
 * Parsing arbitrary existing YAML, finding values at schema paths, and
 * merging edits back in while preserving formatting is a much harder
 * and more fragile problem than one button ever needs to solve; this
 * just produces a fresh block the real YAML editor (Section 6) takes
 * over from.
 *
 * Deliberately not `js-yaml`: every value here is a controlled scalar
 * (string/boolean/number) and every path a plain dotted key, so a
 * string scalar is always written with `JSON.stringify()` — valid YAML
 * on its own, and it sidesteps every unquoted-scalar escaping edge case
 * a general-purpose YAML writer has to handle for arbitrary content.
 */
function scalarText(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  return JSON.stringify(String(value));
}

/** `[{path: 'a.b.c', value}, ...]` → the nested plain object `{a: {b: {c: value}}}`, later fields on a shared prefix merging rather than overwriting. */
function nestValues(values) {
  const root = {};
  for (const { path: p, value } of values) {
    const keys = p.split('.');
    let node = root;
    for (let i = 0; i < keys.length - 1; i++) node = (node[keys[i]] ??= {});
    node[keys[keys.length - 1]] = value;
  }
  return root;
}

function renderObject(obj, indent) {
  const pad = '  '.repeat(indent);
  return Object.entries(obj).map(([key, value]) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return `${pad}${key}:\n${renderObject(value, indent + 1)}`;
    }
    return `${pad}${key}: ${scalarText(value)}`;
  }).join('\n');
}

export function buildValuesYaml(values) {
  if (!values || !values.length) return '';
  return renderObject(nestValues(values), 0) + '\n';
}
