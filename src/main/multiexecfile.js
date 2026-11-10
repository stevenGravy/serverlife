'use strict';
/**
 * Saving and loading multi-exec runs as YAML.
 *
 * A run that was worth doing once is usually worth doing again. The saved file
 * is the command plus the host list, in a form that is readable, diffable and
 * safe to commit next to the code it operates on.
 */

const fsp = require('fs/promises');
const yaml = require('js-yaml');

const FORMAT_VERSION = 1;

/** Normalise a target to the small, stable shape the file records. */
function target(t) {
  if (t.type === 'teleport') {
    return {
      type: 'teleport',
      name: t.name,
      cluster: t.cluster || null,
      proxy: t.proxy || null,
      login: t.login || null,
    };
  }
  return {
    type: 'ssh',
    alias: t.alias || t.name,
    user: t.user || t.login || null,
    port: t.port || null,
  };
}

function stripNulls(obj) {
  if (Array.isArray(obj)) return obj.map(stripNulls);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue;
      out[k] = stripNulls(v);
    }
    return out;
  }
  return obj;
}

/** Serialise a run definition. */
function toYaml({ name, description, command, targets, options, selector } = {}) {
  const doc = stripNulls({
    version: FORMAT_VERSION,
    kind: 'serverlife.multiexec',
    name: name || 'Untitled run',
    description: description || null,
    created: new Date().toISOString(),
    // A trailing newline makes the block scalar render as `|` rather than `|-`.
    command: String(command || '').replace(/\n*$/, '\n'),
    options: {
      concurrency: options?.concurrency ?? 10,
      timeoutSeconds: Math.round((options?.timeout ?? 120000) / 1000),
      stopOnError: !!options?.stopOnError,
      // Staged runs keep their stages: first so many, then batches of so many.
      stages: options?.stages ? {
        first: options.stages.first, batch: options.stages.batch,
        pause: options.stages.pause !== false, stopOnFail: options.stages.stopOnFail !== false,
      } : null,
      // A host that fails is tried this many more times, so many seconds apart.
      retries: Number(options?.retries) || 0,
      retryDelaySeconds: Number(options?.retryDelay ?? 10),
    },
    /*
     * A tag run saves the question rather than the answer: `selector` is what
     * runs, and `targets` is the set it matched when the file was written —
     * kept so the file still says what it meant to someone reading it later,
     * and ignored on load when a selector is present.
     */
    selector: selector ? {
      cluster: selector.cluster || null,
      query: String(selector.query || ''),
    } : null,
    targets: (targets || []).map(target),
  });

  const body = yaml.dump(doc, { lineWidth: 100, noRefs: true, quotingType: '"' });
  return [
    '# ServerLife multi-exec run',
    '# Re-open with: Multi-Exec panel -> Load YAML',
    ...(selector ? [
      '#',
      '# This run selects its hosts by tag, so it runs against whatever matches',
      '# at the time. The targets below are a snapshot of what matched when it',
      '# was saved, and are not what will be used.',
    ] : []),
    body,
  ].join('\n');
}

/** Parse a run definition, rejecting anything that is not one. */
function fromYaml(text) {
  let doc;
  try {
    doc = yaml.load(text);
  } catch (e) {
    throw new Error('Not valid YAML: ' + e.message, { cause: e });
  }
  if (!doc || typeof doc !== 'object') throw new Error('File does not contain a multi-exec run');
  if (doc.kind && doc.kind !== 'serverlife.multiexec') {
    throw new Error(`Unexpected kind "${doc.kind}"`);
  }
  if (!doc.command || typeof doc.command !== 'string') {
    throw new Error('Missing a "command" field');
  }
  const selector = doc.selector && typeof doc.selector === 'object'
    ? { cluster: doc.selector.cluster || null, query: String(doc.selector.query || '') }
    : null;
  // A selector is a complete definition on its own; a list is only required
  // when there is nothing to resolve.
  if (!selector && (!Array.isArray(doc.targets) || !doc.targets.length)) {
    throw new Error('Missing a "targets" list');
  }

  const targets = (Array.isArray(doc.targets) ? doc.targets : []).map((t, i) => {
    if (!t || typeof t !== 'object') throw new Error(`Target ${i + 1} is not a mapping`);
    if (t.type === 'teleport') {
      if (!t.name) throw new Error(`Teleport target ${i + 1} needs a "name"`);
      return { type: 'teleport', name: t.name, cluster: t.cluster || null, proxy: t.proxy || null, login: t.login || null };
    }
    const alias = t.alias || t.name;
    if (!alias) throw new Error(`SSH target ${i + 1} needs an "alias"`);
    return { type: 'ssh', alias, user: t.user || null, port: t.port || null };
  });

  return {
    name: doc.name || 'Untitled run',
    description: doc.description || '',
    command: String(doc.command).replace(/\n$/, ''),
    options: {
      concurrency: Number(doc.options?.concurrency) || 10,
      timeout: (Number(doc.options?.timeoutSeconds) || 120) * 1000,
      stopOnError: !!doc.options?.stopOnError,
      stages: doc.options?.stages ? {
        first: Number(doc.options.stages.first) || 1,
        batch: Number(doc.options.stages.batch) || 5,
        pause: doc.options.stages.pause !== false,
        stopOnFail: doc.options.stages.stopOnFail !== false,
      } : null,
      retries: Math.max(0, Math.min(10, Math.floor(Number(doc.options?.retries)) || 0)),
      retryDelay: Math.max(0, Math.min(3600, Number(doc.options?.retryDelaySeconds ?? 10))),
    },
    selector,
    targets,
  };
}

/** Serialise the results of a completed run, for a report or an artefact. */
function resultsToYaml(view, { includeOutput = true } = {}) {
  const doc = stripNulls({
    version: FORMAT_VERSION,
    kind: 'serverlife.multiexec.results',
    command: String(view.command || '').replace(/\n*$/, '\n'),
    startedAt: view.startedAt ? new Date(view.startedAt).toISOString() : null,
    endedAt: view.endedAt ? new Date(view.endedAt).toISOString() : null,
    summary: {
      total: view.results.length,
      succeeded: view.results.filter((r) => r.status === 'done').length,
      failed: view.results.filter((r) => ['error', 'timeout'].includes(r.status)).length,
    },
    results: view.results.map((r) => stripNulls({
      host: r.label,
      status: r.status,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      stdout: includeOutput && r.stdout ? r.stdout.replace(/\n*$/, '\n') : null,
      stderr: includeOutput && r.stderr ? r.stderr.replace(/\n*$/, '\n') : null,
    })),
  });

  return '# ServerLife multi-exec results\n'
    + yaml.dump(doc, { lineWidth: 120, noRefs: true, quotingType: '"' });
}

async function save(filePath, text) {
  await fsp.writeFile(filePath, text, 'utf8');
  return filePath;
}

async function read(filePath) {
  return fsp.readFile(filePath, 'utf8');
}

module.exports = { toYaml, fromYaml, resultsToYaml, save, read, FORMAT_VERSION };
