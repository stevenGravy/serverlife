/**
 * Indentation-based "what key path is the cursor under" — not a real YAML
 * parse (there is no YAML parser on the renderer side, and a full one is
 * overkill for "what fields exist here"), good enough the same way the
 * plain-textarea viewer this replaces already put it.
 */

const KEY_LINE = /^(\s*)(-\s*)?([A-Za-z0-9_.-]+):(?:\s|$)/;
const PREFIX = /^(\s*)(-\s*)?/;

/**
 * A line's "real" indent for nesting purposes — kubectl's own `-o yaml`
 * aligns a sequence dash with its parent key (`containers:` / `- name:
 * app` at the *same* column), so the dash and the space after it count
 * as part of the indent, the same amount a sibling field without a dash
 * (`image: nginx`, one line down) is indented by.
 */
function effectiveIndent(m) {
  return m[1].length + (m[2] ? m[2].length : 0);
}

/**
 * The key path (`['spec', 'containers', 'image']`) the given cursor
 * offset sits under — walks upward collecting each line whose indent is
 * strictly less than the nearest one already collected (starting from
 * the cursor's own line's indent), stopping at column 0. Ambiguous for
 * one specific, brief moment — a blank new line typed right after a
 * `key:` that opens a sequence, before the dash itself is typed — where
 * it reads as a sibling rather than a child; resolves itself the instant
 * `- ` is typed. Not a full YAML parse, the same "good enough" standard
 * the plain-textarea viewer this replaces already held itself to.
 */
export function inferYamlPath(text, cursorPos) {
  const lines = text.slice(0, cursorPos).split('\n');
  let boundary = effectiveIndent(lines[lines.length - 1].match(PREFIX));
  const path = [];
  for (let i = lines.length - 2; i >= 0; i--) {
    const m = lines[i].match(KEY_LINE);
    if (!m) continue;
    const indent = effectiveIndent(m);
    if (indent >= boundary) continue;
    path.unshift(m[3]);
    boundary = indent;
    if (indent === 0) break;
  }
  return path;
}

/** The `kind`/`apiVersion` declared at column 0 — there is nothing to explain before both are known. */
export function topLevelKind(text) {
  let kind = null;
  let apiVersion = null;
  for (const line of text.split('\n')) {
    const k = line.match(/^kind:\s*(\S+)/);
    if (k) kind = k[1];
    const a = line.match(/^apiVersion:\s*(\S+)/);
    if (a) apiVersion = a[1];
    if (kind && apiVersion) break;
  }
  return kind ? { kind, apiVersion } : null;
}
