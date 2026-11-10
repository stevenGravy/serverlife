'use strict';
/**
 * Just enough JSONPath to read a CRD's own `additionalPrinterColumns` —
 * not a general JSONPath engine. Real `additionalPrinterColumns` lean on
 * one pattern above everything else: a predicate filter picking one entry
 * out of a conditions-shaped array, e.g.
 * `.status.conditions[?(@.type == "Ready")].status` (cert-manager's own
 * `Certificate` CRD). Plain dot paths and a numeric array index cover
 * everything else seen in practice.
 */

/** A dotted-but-bracketless lookup, for a filter's own `@.field` (nesting there is rare, but cheap to allow). */
function getPlain(obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function parseBracket(inner) {
  const s = inner.trim();
  const filter = s.match(/^\?\(\s*@\.([\w.-]+)\s*(==|!=)\s*(.+?)\s*\)$/);
  if (filter) {
    const [, field, op, rawValue] = filter;
    let value = rawValue;
    if (/^"[^"]*"$/.test(rawValue) || /^'[^']*'$/.test(rawValue)) value = rawValue.slice(1, -1);
    else if (rawValue === 'true') value = true;
    else if (rawValue === 'false') value = false;
    else if (!Number.isNaN(Number(rawValue))) value = Number(rawValue);
    return { type: 'filter', field, op, value };
  }
  if (/^-?\d+$/.test(s)) return { type: 'index', n: Number(s) };
  return { type: 'unknown' };
}

/** A jsonPath string into field/index/filter tokens, left to right. */
function tokenize(jsonPath) {
  let s = String(jsonPath || '').trim();
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1); // the {.x.y} wrapper some CRDs still use
  if (s.startsWith('.')) s = s.slice(1);
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '.') { i++; continue; }
    if (s[i] === '[') {
      let depth = 1; let j = i + 1;
      while (j < s.length && depth > 0) {
        if (s[j] === '[') depth++;
        else if (s[j] === ']') depth--;
        j++;
      }
      tokens.push(parseBracket(s.slice(i + 1, j - 1)));
      i = j;
      continue;
    }
    let j = i;
    while (j < s.length && s[j] !== '.' && s[j] !== '[') j++;
    tokens.push({ type: 'field', name: s.slice(i, j) });
    i = j;
  }
  return tokens;
}

/** Resolve one jsonPath against one object — undefined for anything not found or not supported. */
function resolve(obj, jsonPath) {
  let cur = obj;
  for (const t of tokenize(jsonPath)) {
    if (cur === undefined || cur === null) return undefined;
    if (t.type === 'field') cur = cur[t.name];
    else if (t.type === 'index') cur = Array.isArray(cur) ? cur[t.n] : undefined;
    else if (t.type === 'filter') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur.find((item) => {
        const v = getPlain(item, t.field);
        return t.op === '==' ? v === t.value : v !== t.value;
      });
    } else {
      return undefined;
    }
  }
  return cur;
}

module.exports = { resolve, tokenize };
