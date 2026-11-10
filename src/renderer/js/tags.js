/**
 * Teleport labels ("tags") — reading them off a node, and the small query
 * language the host filter understands.
 *
 * `tsh ls --format=json` already hands us both kinds of label: the static ones
 * in `metadata.labels` and the dynamic command labels in `spec.cmd_labels`,
 * which the main process merges into one flat `labels` map per node. Everything
 * here works off that map, so plain SSH hosts (which have none) simply fall
 * through to matching on their name and address.
 */

/** Labels Teleport sets for its own bookkeeping, not for humans to filter on. */
const INTERNAL_PREFIXES = ['teleport.internal/', 'teleport.hidden/', 'teleport.dev/'];

export function isInternalLabel(key) {
  return INTERNAL_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * A node's labels as sorted [key, value] pairs. Internal labels are dropped
 * unless asked for — they are noise in the sidebar but useful in the details
 * dialog, where the user went looking.
 */
export function labelEntries(host, { includeInternal = false } = {}) {
  const labels = host?.labels || {};
  return Object.entries(labels)
    .filter(([k]) => includeInternal || !isInternalLabel(k))
    .map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

export function labelCount(host) {
  return labelEntries(host).length;
}

/** Every distinct key=value across a set of nodes, with how many nodes carry it. */
export function collectTags(nodes) {
  const keys = new Map();   // key -> Map(value -> count)
  for (const n of nodes) {
    for (const [k, v] of labelEntries(n)) {
      if (!keys.has(k)) keys.set(k, new Map());
      const values = keys.get(k);
      values.set(v, (values.get(v) || 0) + 1);
    }
  }
  return new Map([...keys.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

/**
 * Label keys worth their own column — the ones most of these hosts actually
 * carry, not every key any one of them happens to have. A key that only a
 * host or two uses would make a column that is blank for everyone else,
 * which is worse than the plain chip it replaced; one a strict majority
 * share earns a column because sorting and scanning by it pays for the
 * width. With one host there is nothing to call "common" against, so none
 * qualify — the chips still show everything, just not broken into columns.
 */
export function mostCommonLabelKeys(hosts, { max = 6 } = {}) {
  if (hosts.length < 2) return [];
  // Not a performance cap — this scan is linear and cheap even at tens of
  // thousands of hosts (collectTags over 10,000 hosts × 10 labels is ~100k
  // map ops, well under a millisecond). It is a backstop against whatever
  // called this with something truly pathological; the real defense against
  // a huge fleet is the caller capping how many hosts it hands in at all.
  if (hosts.length > 50000) hosts = hosts.slice(0, 50000);
  const tags = collectTags(hosts);
  const threshold = hosts.length / 2;
  return [...tags.entries()]
    .map(([k, values]) => [k, [...values.values()].reduce((a, b) => a + b, 0)])
    .filter(([, count]) => count > threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([k]) => k);
}

/* ------------------------------------------------------------------ */
/* Query language                                                      */
/* ------------------------------------------------------------------ */

/**
 * Split on whitespace, but let quotes hold a value together, so both
 * `env="us east"` and `"env=us east"` survive as one term.
 */
function tokenize(text) {
  const out = [];
  let cur = '';
  let quote = null;
  let quoted = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; quoted = true; continue; }
    if (/\s/.test(ch)) {
      if (cur || quoted) out.push(cur);
      cur = ''; quoted = false;
      continue;
    }
    cur += ch;
  }
  if (cur || quoted) out.push(cur);
  return out;
}

/**
 * Parse the filter box into terms, all of which must match (AND).
 *
 *   web                text anywhere — name, address, cluster or any label
 *   env=prod           label `env` is exactly `prod`
 *   env:pro            label `env` contains `pro`
 *   env=prod*          label `env` matches the glob
 *   name~^web-\\d+$     a real regular expression, when a glob is not enough
 *   env=prod,staging   either value — a label has one value, so a second one
 *                      can only mean "or", never "and"
 *   env:               the node has an `env` label at all
 *   tag:gpu            any label key or value contains `gpu`
 *   cluster=corp       a non-label field: name, host, cluster, addr, proxy, type
 *   -env=dev           exclude
 */
/**
 * One already-separated token as a term.
 *
 * Separate from `parseQuery` because the boolean parser has *also* done the
 * splitting by the time it gets here, and running the tokenizer again over
 * one token loses anything a quote was holding together: `"region=us east"`
 * came back as `region=us`, silently matching the wrong thing.
 */
function termFromToken(tok) {
  let s = String(tok);
  let neg = false;
  if (s[0] === '-' && s.length > 1) { neg = true; s = s.slice(1); }
  const m = /^([^:=~\s]+)([:=~])(.*)$/.exec(s);
  /*
   * A regular expression keeps its case. Everything else is lowercased on
   * both sides, which is right for `env=PROD`; a pattern is written the way
   * it is meant to be read, and `[A-Z]` must not quietly become `[a-z]`.
   */
  if (m) return { neg, key: m[1].toLowerCase(), op: m[2], value: m[2] === '~' ? m[3] : m[3].toLowerCase() };
  return { neg, text: s.toLowerCase() };
}

export function parseQuery(text) {
  return tokenize(String(text || '')).filter((tok) => tok !== '').map(termFromToken);
}

function globToRe(pattern) {
  const body = pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${body}$`);
}

/**
 * A regular expression, compiled once and kept.
 *
 * Case-insensitive, because every other comparison here is and a rule that
 * matched `Web-1` but not `web-1` would be a trap. A pattern that will not
 * compile is not an error here — `compileQuery` refuses it up front, where
 * there is somebody to tell — so this simply never matches.
 */
const reCache = new Map();
function toRe(pattern) {
  if (!reCache.has(pattern)) {
    let re = null;
    try { re = new RegExp(pattern, 'i'); } catch { re = null; }
    reCache.set(pattern, re);
  }
  return reCache.get(pattern);
}

/** Does this pattern compile? The rule editor asks before saving it. */
export function regexError(pattern) {
  try { new RegExp(pattern, 'i'); return null; } catch (e) { return e.message; }
}

function matchValue(actual, want, op) {
  const a = String(actual);
  /*
   * A regex is one pattern, never a comma list: a comma is regex syntax —
   * `a{1,3}` — and splitting on it would quietly break half of them.
   */
  if (op === '~') {
    if (!want) return true;
    const re = toRe(want);
    return re ? re.test(a) : false;
  }
  // `key:` / `key=` with nothing after it asks only that the key exists.
  const alts = want.split(',').filter(Boolean);
  if (!alts.length) return true;
  const lower = a.toLowerCase();
  return alts.some((w) => {
    if (op === ':') return lower.includes(w);
    if (w.includes('*')) return globToRe(w).test(lower);
    return lower === w;
  });
}

/** Non-label fields a keyed term may address, so `cluster=corp` works too. */
function fieldValues(host) {
  return {
    name: host.name || host.alias || '',
    host: host.hostname || '',
    hostname: host.hostname || '',
    alias: host.alias || '',
    cluster: host.cluster || '',
    proxy: host.proxy || '',
    addr: host.addr || '',
    type: host.type || '',
    user: host.user || '',
    uuid: host.uuid || '',
    tunnel: host.tunnel ? 'true' : 'false',
  };
}

function textHaystack(host) {
  const parts = [host.name, host.alias, host.hostname, host.cluster, host.addr, host.user];
  for (const [k, v] of labelEntries(host)) parts.push(k, v, `${k}=${v}`);
  return parts.filter(Boolean).join(' ').toLowerCase();
}

function termMatches(host, term) {
  if (term.text !== undefined) return textHaystack(host).includes(term.text);

  const entries = labelEntries(host, { includeInternal: true });

  // `tag:`/`label:` searches across every key and value at once.
  if (term.key === 'tag' || term.key === 'label' || term.key === 'labels') {
    if (term.value === '') return entries.length > 0;
    if (term.op === '~') {
      const re = toRe(term.value);
      return !!re && entries.some(([k, v]) => re.test(k) || re.test(String(v)) || re.test(`${k}=${v}`));
    }
    return entries.some(([k, v]) =>
      k.toLowerCase().includes(term.value)
      || String(v).toLowerCase().includes(term.value)
      || `${k}=${v}`.toLowerCase().includes(term.value));
  }

  // `teleport.internal/foo` is also reachable as plain `foo`: the prefix is
  // what the user is least likely to type.
  const keyed = entries.filter(([k]) => {
    const lower = k.toLowerCase();
    return lower === term.key || lower.split('/').pop() === term.key;
  });
  const field = fieldValues(host)[term.key];

  /*
   * A label and a field can both answer to the same word, and when they do,
   * either matching counts.
   *
   * This used to stop at the label, which made `name=` a coin toss: AWS nodes
   * carry an `aws/Name` tag, whose last segment is `name`, so on those hosts
   * `name=web-1` silently asked about the EC2 tag and never about the node's
   * own name — and `name=prd-web-linux-ec2` matched nothing at all, on the
   * one host it obviously described. Nobody writing that meant "the label and
   * not the host", so both are asked and either will do.
   */
  if (keyed.length || field !== undefined) {
    return keyed.some(([, v]) => matchValue(v, term.value, term.op))
      || (field !== undefined && matchValue(field, term.value, term.op));
  }

  /*
   * Neither a label on this host nor a known field. Fall back to matching the
   * raw token as text, which costs nothing — a host with no `env` label still
   * will not match `env=prod` — but rescues the things that only look like a
   * query, `web-01:3022` and `https://grafana/...` among them.
   */
  return textHaystack(host).includes(term.key + term.op + term.value);
}

export function hostMatchesQuery(host, terms) {
  if (!terms.length) return true;
  return terms.every((t) => (t.neg ? !termMatches(host, t) : termMatches(host, t)));
}

/* ------------------------------------------------------------------ */
/* Boolean queries                                                     */
/* ------------------------------------------------------------------ */

/**
 * The same terms, with `and`, `or`, `not` and brackets between them.
 *
 * Space-separated terms mean AND and a leading `-` means NOT, which covers
 * "these and not those" and was enough while a query was something you typed
 * to find one host. A folder's rule is a different thing: it is written once
 * and then decides, every time the inventory changes, which machines belong
 * to it. That is where `env=prod and (role:web or role:api) and not
 * name=web-canary` earns its keep — one rule cannot be expressed as a list of
 * ANDs, and the alternative is filing a hundred nodes by hand.
 *
 *   env=prod role:web           both, as before
 *   env=prod and role:web       the same, said out loud
 *   env=prod or env=staging     either
 *   not env=dev                 the same as -env=dev
 *   a and (b or c)              brackets group
 *   "and"                       quoted, it is a word to search for again
 *
 * `and` binds tighter than `or`, as everywhere else, so `a or b and c` reads
 * as `a or (b and c)`.
 */
const OPS = { and: 'and', '&': 'and', '&&': 'and', or: 'or', '|': 'or', '||': 'or', not: 'not', '!': 'not' };

/**
 * Tokens for the boolean parser: the same words `tokenize` produces, with
 * brackets split off and the operator words recognised. Quoting takes a token
 * out of the grammar entirely — `"(x)"` and `"or"` are a bracket and a word
 * to search for, not syntax — which is the escape hatch for a host whose name
 * happens to be an operator.
 */
function lex(text) {
  const out = [];
  for (const { value, quoted } of tokenizeRich(text)) {
    if (quoted) { out.push({ type: 'term', value }); continue; }
    let rest = value;
    while (rest) {
      const m = /^[()]/.exec(rest);
      if (m) {
        out.push({ type: m[0] === '(' ? 'lparen' : 'rparen' });
        rest = rest.slice(1);
        continue;
      }
      /*
       * A regular expression owns its own brackets.
       *
       * `name~^(web|api)-\d+$` is one term, not a term and a group: the
       * grammar's brackets and the pattern's are the same character, and the
       * pattern was here first. Everything up to a bracket the *pattern* has
       * not opened belongs to it, so `(name~^(web|api)$)` still closes the
       * group it is in. A bracket inside a character class — `name~[()]` —
       * is beyond this and wants quoting.
       */
      const rx = /^-?[^:=~\s()]+~/.test(rest);
      if (rx) {
        let depth = 0;
        let cut = rest.length;
        for (let i = 0; i < rest.length; i++) {
          const c = rest[i];
          if (c === '\\') { i++; continue; }
          if (c === '(') depth++;
          else if (c === ')') {
            if (!depth) { cut = i; break; }
            depth--;
          }
        }
        out.push({ type: 'term', value: rest.slice(0, cut) });
        rest = rest.slice(cut);
        continue;
      }
      // Up to the next bracket: a term may contain anything else.
      const upto = rest.search(/[()]/);
      const chunk = upto === -1 ? rest : rest.slice(0, upto);
      rest = upto === -1 ? '' : rest.slice(upto);
      const op = OPS[chunk.toLowerCase()];
      out.push(op ? { type: op } : { type: 'term', value: chunk });
    }
  }
  return out;
}

/** `tokenize`, but saying which tokens were quoted. */
function tokenizeRich(text) {
  const out = [];
  let cur = '';
  let quote = null;
  let quoted = false;
  let wasQuoted = false;
  for (const ch of String(text || '')) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; quoted = true; wasQuoted = true; continue; }
    if (/\s/.test(ch)) {
      if (cur || quoted) out.push({ value: cur, quoted: wasQuoted });
      cur = ''; quoted = false; wasQuoted = false;
      continue;
    }
    cur += ch;
  }
  if (cur || quoted) out.push({ value: cur, quoted: wasQuoted });
  return out;
}

function parseExpr(ts, pos) {
  let left = parseAnd(ts, pos);
  while (ts[pos.i]?.type === 'or') { pos.i++; left = { op: 'or', a: left, b: parseAnd(ts, pos) }; }
  return left;
}

function parseAnd(ts, pos) {
  let left = parseUnary(ts, pos);
  for (;;) {
    const t = ts[pos.i];
    if (!t || t.type === 'rparen' || t.type === 'or') break;
    // Juxtaposition is AND; an explicit `and` is the same thing, spelled.
    if (t.type === 'and') pos.i++;
    left = { op: 'and', a: left, b: parseUnary(ts, pos) };
  }
  return left;
}

function parseUnary(ts, pos) {
  const t = ts[pos.i];
  if (!t) throw new Error('the query ends where a condition was expected');
  if (t.type === 'not') { pos.i++; return { op: 'not', a: parseUnary(ts, pos) }; }
  if (t.type === 'and' || t.type === 'or') throw new Error(`"${t.type}" needs something on both sides`);
  if (t.type === 'lparen') {
    pos.i++;
    const inner = parseExpr(ts, pos);
    if (ts[pos.i]?.type !== 'rparen') throw new Error('a bracket is left open');
    pos.i++;
    return inner;
  }
  if (t.type === 'rparen') throw new Error('a closing bracket with nothing open');
  pos.i++;
  const term = termFromToken(t.value);
  // A broken pattern is worth saying out loud: silently matching nothing is
  // indistinguishable from a rule that is simply too narrow.
  if (term?.op === '~' && term.value) {
    const bad = regexError(term.value);
    if (bad) throw new Error(`that regular expression will not compile (${bad})`);
  }
  return { op: 'term', term };
}

function evalNode(host, n) {
  switch (n.op) {
    case 'and': return evalNode(host, n.a) && evalNode(host, n.b);
    case 'or': return evalNode(host, n.a) || evalNode(host, n.b);
    case 'not': return !evalNode(host, n.a);
    default: {
      const t = n.term;
      if (!t) return true;
      return t.neg ? !termMatches(host, t) : termMatches(host, t);
    }
  }
}

/**
 * Turn a query into something that can be asked of a host.
 *
 * Returns `{ empty, error, match }`. A query that will not parse still gets a
 * usable `match`: it falls back to the plain AND reading of the same words,
 * with the operators dropped. Half-typed queries are the normal state of a
 * filter box — `env=prod and ` is a syntax error for exactly as long as it
 * takes to type the next word — and blanking the list in the meantime would
 * make the box unusable. The `error` is there for the places that *should*
 * complain, such as the editor for a folder's rule.
 */
export function compileQuery(text) {
  const src = String(text || '').trim();
  if (!src) return { empty: true, error: null, match: () => true };
  const tokens = lex(src);
  if (!tokens.length) return { empty: true, error: null, match: () => true };
  try {
    const pos = { i: 0 };
    const ast = parseExpr(tokens, pos);
    if (pos.i < tokens.length) throw new Error('there is more here than the query can read');
    return { empty: false, error: null, match: (h) => evalNode(h, ast), ast };
  } catch (e) {
    const terms = parseQuery(tokens.filter((t) => t.type === 'term').map((t) => t.value).join(' '));
    return { empty: !terms.length, error: e.message, match: (h) => hostMatchesQuery(h, terms) };
  }
}

/** Does this query use any of the boolean syntax, or is it the plain old list? */
export function isBooleanQuery(text) {
  return lex(String(text || '')).some((t) => t.type !== 'term');
}

/**
 * Take the quotes off a term, if it arrived wearing them.
 *
 * `termFor` quotes a value with a space in it — `"aws/Owner=Steven Martin"`
 * — and that same string comes back here from a chip asking "am I on?" or
 * "toggle me". Parsed with the quotes still attached, the key reads as
 * `"aws/Owner` and matches nothing: the chip never lit up, and clicking it
 * twice added the term twice. Everything below works on the bare form and
 * `joinTokens` puts the quotes back on the way out.
 */
function unquote(tok) {
  const s = String(tok || '');
  if (s.length > 1 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) return s.slice(1, -1);
  return s;
}

function splitTerm(tok) {
  const m = /^(-?)([^:=~\s]+)([:=~])(.*)$/.exec(unquote(tok));
  return m ? { neg: !!m[1], key: m[2], op: m[3], value: m[4] } : null;
}

/** An existing positive term for the same key and operator, if there is one. */
function sameKeyIndex(tokens, t) {
  return tokens.findIndex((x) => {
    const p = splitTerm(x);
    return p && !p.neg && p.key.toLowerCase() === t.key.toLowerCase() && p.op === t.op;
  });
}

/**
 * Add or remove `key=value` in a query string, so clicking the same tag chip
 * twice leaves the filter as it was found.
 *
 * Picking a *second* value for a key folds into that key's comma list rather
 * than adding a term: a label holds one value, so `env=prod env=staging` could
 * only ever match nothing, which is never what the click meant.
 */
export function toggleTerm(query, term) {
  const tokens = tokenize(String(query || ''));
  const bare = unquote(term);
  const t = splitTerm(bare);

  if (!t) {
    const i = tokens.findIndex((x) => x.toLowerCase() === bare.toLowerCase());
    i >= 0 ? tokens.splice(i, 1) : tokens.push(bare);
    return joinTokens(tokens);
  }

  // "any value of this key" replaces whatever values were pinned — whichever
  // operator pinned them — and toggles off when it is already all that is asked.
  if (t.value === '') {
    const hits = tokens
      .map((x, ix) => [splitTerm(x), ix])
      .filter(([p]) => p && !p.neg && p.key.toLowerCase() === t.key.toLowerCase());
    const hadValues = hits.some(([p]) => p.value !== '');
    for (const [, ix] of hits.reverse()) tokens.splice(ix, 1);
    if (!hits.length || hadValues) tokens.push(bare);
    return joinTokens(tokens);
  }

  const i = sameKeyIndex(tokens, t);
  if (i < 0) {
    tokens.push(bare);
    return joinTokens(tokens);
  }

  const cur = splitTerm(tokens[i]);
  const values = cur.value.split(',').filter(Boolean);
  const vi = values.findIndex((v) => v.toLowerCase() === t.value.toLowerCase());
  if (vi >= 0) values.splice(vi, 1);
  else values.push(t.value);

  if (!values.length) tokens.splice(i, 1);
  else tokens[i] = `${cur.key}${cur.op}${values.join(',')}`;
  return joinTokens(tokens);
}

export function hasTerm(query, term) {
  const bare = unquote(term);
  const t = splitTerm(bare);
  return tokenize(String(query || '')).some((x) => {
    if (x.toLowerCase() === bare.toLowerCase()) return true;
    if (!t) return false;
    const p = splitTerm(x);
    if (!p || p.neg || p.key.toLowerCase() !== t.key.toLowerCase()) return false;
    // "any value" is satisfied by any term on that key, whatever the operator.
    if (t.value === '') return true;
    if (p.op !== t.op) return false;
    return p.value.split(',').some((v) => v.toLowerCase() === t.value.toLowerCase());
  });
}

function joinTokens(tokens) {
  return tokens.map(quoteIfNeeded).join(' ');
}

function quoteIfNeeded(tok) {
  return /\s/.test(tok) ? `"${tok}"` : tok;
}

/** `key=value`, quoted when the value has spaces, ready to drop in the filter. */
export function termFor(key, value) {
  return quoteIfNeeded(value === '' ? `${key}:` : `${key}=${value}`);
}
