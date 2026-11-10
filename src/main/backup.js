'use strict';
/**
 * Export and import — moving a setup to another machine, and sharing macros.
 *
 * Everything is written as one versioned JSON envelope so a file can say what
 * it is before anything is applied. Nothing secret travels: the store holds
 * ssh_config aliases, identity-file *paths* and Teleport cluster names, never
 * passwords or keys, so a backup is no more sensitive than ~/.ssh/config.
 */

const fsp = require('fs/promises');

const FORMAT = 'serverlife.backup';
const VERSION = 1;

/** What "everything" means. History is left out: it is a log, not a setting. */
const FULL_KEYS = [
  'profiles', 'folders', 'snippets',
  'macros', 'hiddenMacros', 'macroCategoryOrder', 'macroOrder',
  'requestTemplates', 'layouts', 'defaultLayoutId', 'settings',
];

/** Keys that are lists of records, and so can be merged rather than replaced. */
const LIST_KEYS = ['profiles', 'folders', 'snippets', 'macros', 'requestTemplates', 'layouts'];

function envelope(kind, data, meta = {}) {
  return {
    format: FORMAT,
    version: VERSION,
    kind,
    exportedAt: new Date().toISOString(),
    app: 'ServerLife',
    ...meta,
    data,
  };
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

function exportAll(store) {
  const data = {};
  for (const k of FULL_KEYS) {
    const v = store.data[k];
    if (v !== undefined) data[k] = JSON.parse(JSON.stringify(v));
  }
  return envelope('settings', data, {
    counts: Object.fromEntries(LIST_KEYS.map((k) => [k, (data[k] || []).length])),
  });
}

/**
 * Macros only. Built-ins are not written out — they exist on the other machine
 * already — so an export carries the user's own, and the ids of any built-ins
 * they have hidden, which is a preference worth moving.
 */
function exportMacros(store, ids) {
  const all = store.data.macros || [];
  const macros = ids?.length ? all.filter((m) => ids.includes(m.id)) : all;
  return envelope('macros', {
    macros: JSON.parse(JSON.stringify(macros)),
    hiddenMacros: ids?.length ? [] : [...(store.data.hiddenMacros || [])],
    macroCategoryOrder: ids?.length ? [] : [...(store.data.macroCategoryOrder || [])],
    macroOrder: ids?.length ? [] : [...(store.data.macroOrder || [])],
  }, { counts: { macros: macros.length } });
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

function parse(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('That file is not JSON.'); }
  if (!doc || doc.format !== FORMAT) {
    throw new Error('That is not a ServerLife export.');
  }
  if (Number(doc.version) > VERSION) {
    throw new Error(`That file was written by a newer ServerLife (format ${doc.version}).`);
  }
  if (!doc.data || typeof doc.data !== 'object') throw new Error('The export has no data in it.');
  return doc;
}

/** What an import would do, without doing it — so the user can be asked first. */
function describe(doc) {
  const d = doc.data || {};
  const counts = {};
  for (const k of [...LIST_KEYS, 'hiddenMacros']) {
    if (Array.isArray(d[k])) counts[k] = d[k].length;
  }
  return {
    kind: doc.kind,
    exportedAt: doc.exportedAt || null,
    hasSettings: !!d.settings,
    counts,
  };
}

/**
 * Merge keeps what is here and adds what is not; replace makes this machine
 * look like the file. Records are matched on id, so importing the same file
 * twice does not double everything.
 */
function applyImport(store, doc, { mode = 'merge' } = {}) {
  const d = doc.data || {};
  const added = {};

  for (const k of LIST_KEYS) {
    if (!Array.isArray(d[k])) continue;
    if (mode === 'replace') {
      store.data[k] = JSON.parse(JSON.stringify(d[k]));
      added[k] = d[k].length;
      continue;
    }
    const existing = store.data[k] || [];
    const seen = new Set(existing.map((x) => x && x.id).filter(Boolean));
    const incoming = d[k].filter((x) => x && (!x.id || !seen.has(x.id)));
    store.data[k] = [...existing, ...JSON.parse(JSON.stringify(incoming))];
    added[k] = incoming.length;
  }

  for (const k of ['hiddenMacros', 'macroCategoryOrder', 'macroOrder']) {
    if (!Array.isArray(d[k])) continue;
    store.data[k] = mode === 'replace'
      ? [...d[k]]
      : [...new Set([...(store.data[k] || []), ...d[k]])];
  }

  if (d.settings && typeof d.settings === 'object') {
    // Settings always merge over the top: a file from an older build must not
    // remove settings this one has gained.
    store.data.settings = { ...store.data.settings, ...d.settings };
  }
  if (mode === 'replace' && d.defaultLayoutId !== undefined) {
    store.data.defaultLayoutId = d.defaultLayoutId;
  }

  store.save();
  return { mode, added };
}

async function readFile(file) { return parse(await fsp.readFile(file, 'utf8')); }

async function writeFile(file, doc) {
  await fsp.writeFile(file, JSON.stringify(doc, null, 2), { mode: 0o600 });
  return file;
}

module.exports = {
  FORMAT, VERSION, FULL_KEYS,
  exportAll, exportMacros, parse, describe, applyImport, readFile, writeFile,
};
