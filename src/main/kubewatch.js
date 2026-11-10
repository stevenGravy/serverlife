'use strict';
/**
 * Live updates for the full cluster browser — `kubectl get <kind> -o yaml
 * --watch`, each watched object arriving as its own complete YAML
 * document. Kubectl itself delimits consecutive documents with a line
 * that is exactly `---`, confirmed against a real cluster; splitting on
 * that and handing each chunk to js-yaml (already a dependency) needs
 * nothing more exotic than that — no JSON brace-tracking, no raw
 * Kubernetes HTTP client, same "shell out to kubectl" shape as every
 * other main-process kube module.
 *
 * What this cannot do: say a resource was deleted. Kubectl's own watch
 * printers never emit a "this is gone" document — a deleted resource just
 * stops being updated, forever, with nothing in the text stream to say
 * so (confirmed by watching a real pod through a real delete). Callers
 * pair this with a slower periodic re-list (kube:resources, the same
 * call every list view already makes on demand) to catch that; this
 * module only ever reports what is still there to describe.
 */

const { spawn } = require('child_process');
const yaml = require('js-yaml');
const kube = require('./kube');

/** id -> { child } */
const running = new Map();

/** A line that is only `---`, kubectl's own multi-document separator. */
const DOC_SEP = /\n---[ \t]*\r?\n/;

/**
 * The buffering part, pure and independently testable: whatever text has
 * arrived so far, split into complete documents and what's left over
 * (held for the next chunk, or flushed on exit). A document's own data
 * containing the literal text "---" never splits early here — the
 * separator only matches a line with nothing else on it.
 */
function splitDocuments(buffered) {
  const parts = buffered.split(DOC_SEP);
  const remainder = parts.pop();
  return { complete: parts.filter((p) => p.trim()), remainder };
}

/**
 * Watch every instance of one kind, in one namespace or every namespace —
 * the full browser's own list view, kept current. `onEvent({object})`
 * fires once per document — the first batch *is* the current state,
 * kubectl's own watch behaviour, not something recreated here.
 * `onEvent({done, code, error})` fires once, on exit, after which `id` is
 * no longer running.
 */
function start({ id, spec = {}, kind, namespaced = true, namespace, selector } = {}, onEvent) {
  if (!id) throw new Error('No id given.');
  if (!kind) throw new Error('No resource kind to watch.');
  if (running.has(id)) throw new Error('That watch is already running.');

  const { bin, baseArgs, env } = kube.kubectlArgsFor(namespaced ? { ...spec, namespace } : { ...spec, namespace: null });
  const scope = !namespaced ? [] : namespace ? [] : ['-A'];
  const sel = selector ? ['-l', selector] : [];
  const args = [...baseArgs, 'get', kind, ...scope, ...sel, '-o', 'yaml', '--watch'];

  const child = spawn(bin, args, { env });
  // `idle` boxes the pending flush timer so stop() (below, no access to
  // this closure) can cancel it too — otherwise a watch stopped right in
  // that 300ms window could still deliver one last event afterward.
  const idle = { timer: null };
  running.set(id, { child, idle });

  let buffer = '';
  // Kubectl's own separator sits *between* documents — the last one it has
  // printed so far (often the only one, when nothing is actively changing)
  // never gets a trailing `---` at all, confirmed against a real cluster:
  // a lone watched pod with no further updates just sits in the stream
  // forever. A short quiet period is read as "that's the whole document"
  // and tried speculatively; a genuinely incomplete one (still mid-write)
  // simply fails to parse and is left for the next attempt.
  const tryFlushIdle = () => {
    idle.timer = null;
    if (!buffer.trim()) return;
    let object;
    try { object = yaml.load(buffer.trim()); } catch { return; } // not complete yet — wait for more
    buffer = '';
    if (object) onEvent({ object });
  };
  const emitDoc = (text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    let object;
    try { object = yaml.load(trimmed); } catch { return; } // a document split mid-write: wait for more, or drop on exit
    if (object) onEvent({ object });
  };
  const onChunk = (chunk) => {
    if (idle.timer) { clearTimeout(idle.timer); idle.timer = null; }
    buffer += chunk;
    const { complete, remainder } = splitDocuments(buffer);
    buffer = remainder;
    for (const doc of complete) emitDoc(doc);
    if (buffer.trim()) idle.timer = setTimeout(tryFlushIdle, 300);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', onChunk);
  let errText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errText += chunk; });

  child.on('error', (e) => {
    if (idle.timer) clearTimeout(idle.timer);
    running.delete(id);
    onEvent({ done: true, code: null, error: e.message });
  });
  child.on('exit', (code) => {
    if (!running.has(id)) return; // already reported by 'error', or stop() already called
    if (idle.timer) clearTimeout(idle.timer);
    emitDoc(buffer); // whatever was left is complete if the process exited cleanly
    buffer = '';
    running.delete(id);
    onEvent({ done: true, code, error: code ? (errText.trim().split('\n').filter(Boolean).pop() || null) : null });
  });

  return { id };
}

function stop(id) {
  const r = running.get(id);
  if (!r) return false;
  if (r.idle.timer) clearTimeout(r.idle.timer);
  try { r.child.kill(); } catch { /* already gone */ }
  running.delete(id);
  return true;
}

function stopAll() {
  for (const id of [...running.keys()]) stop(id);
}

module.exports = { start, stop, stopAll, splitDocuments };
