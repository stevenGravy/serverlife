'use strict';
/**
 * Host discovery from OpenSSH config.
 *
 * Parsing only enumerates candidate aliases; the effective options for any
 * host come from `ssh -G`, which is authoritative and already understands
 * Include, Match and wildcard precedence.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const sshbin = require('./sshbin');
const { execFile } = require('child_process');

const HOME = os.homedir();

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

function stripQuotes(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Split a config line into keyword + raw value (ssh allows `key value` or `key=value`). */
function splitLine(line) {
  const t = line.trim();
  if (!t || t.startsWith('#')) return null;
  const m = t.match(/^([A-Za-z0-9_-]+)\s*(?:=\s*|\s+)(.*)$/);
  if (!m) return null;
  return { key: m[1].toLowerCase(), value: m[2].trim() };
}

/** Tokenise a value respecting quotes (Host patterns, Include globs). */
function tokens(value) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(value))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

function globToRegex(glob) {
  let r = '';
  for (const ch of glob) {
    if (ch === '*') r += '[^/]*';
    else if (ch === '?') r += '[^/]';
    else r += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + r + '$');
}

async function expandInclude(pattern, baseDir) {
  const p = expandHome(pattern);
  const abs = path.isAbsolute(p) ? p : path.join(baseDir, p);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  if (!/[*?]/.test(base)) {
    return fs.existsSync(abs) ? [abs] : [];
  }
  const re = globToRegex(base);
  try {
    const names = await fsp.readdir(dir);
    return names.filter((n) => re.test(n)).map((n) => path.join(dir, n)).sort();
  } catch { return []; }
}

/**
 * Collect literal (non-wildcard) Host aliases across the config tree.
 * Returns [{alias, source, comment}] in file order, de-duplicated.
 */
async function collectAliases(configPath = path.join(HOME, '.ssh', 'config'), seen = new Set(), depth = 0) {
  if (depth > 8 || seen.has(configPath)) return [];
  seen.add(configPath);
  let text;
  try { text = await fsp.readFile(configPath, 'utf8'); } catch { return []; }

  const out = [];
  const lines = text.split(/\r?\n/);
  const baseDir = path.dirname(configPath);
  let lastComment = null;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed.startsWith('#')) { lastComment = trimmed.replace(/^#+\s*/, ''); continue; }
    const kv = splitLine(raw);
    if (!kv) { if (!trimmed) lastComment = null; continue; }

    if (kv.key === 'include') {
      for (const pat of tokens(kv.value)) {
        for (const f of await expandInclude(stripQuotes(pat), baseDir)) {
          out.push(...await collectAliases(f, seen, depth + 1));
        }
      }
      continue;
    }
    if (kv.key === 'host') {
      for (const pat of tokens(kv.value)) {
        const alias = stripQuotes(pat);
        // Skip wildcards, negations and the catch-all.
        if (/[*?!]/.test(alias)) continue;
        out.push({ alias, source: configPath, comment: lastComment });
      }
      lastComment = null;
    }
  }
  return out;
}

/** Always an array, dropping anything empty — `ssh -G` returns either a bare
 *  string or an array once a key repeats, and the text fallback below mirrors
 *  that shape so both paths can be handled the same way. */
function asList(v) {
  return (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => String(x).trim()).filter(Boolean);
}

/** Resolve a host alias through `ssh -G`. */
function resolveHost(alias, extraArgs = []) {
  return new Promise((resolve) => {
    // `ssh -G` is how an alias becomes a hostname, user and port. Without an
    // ssh client there is nothing to ask, and the caller falls back to what the
    // config file itself says.
    execFile(sshbin.findSsh(), [...extraArgs, '-G', alias], {
      timeout: 10000,
      env: sshbin.sshEnv(),
    }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      const cfg = {};
      for (const line of String(stdout).split('\n')) {
        const i = line.indexOf(' ');
        if (i < 1) continue;
        const k = line.slice(0, i).toLowerCase();
        const v = line.slice(i + 1).trim();
        if (cfg[k] === undefined) cfg[k] = v;
        else if (Array.isArray(cfg[k])) cfg[k].push(v);
        else cfg[k] = [cfg[k], v];
      }
      resolve(cfg);
    });
  });
}

/**
 * The config files to read, primary first.
 *
 * Each extra file is a *root*, not an include: its hosts are resolved with
 * `ssh -F <file>`, which is how a connection to one of them will be made, so
 * what the list shows and what the session uses cannot drift apart.
 */
function configRoots(extra = []) {
  const roots = [{ file: CONFIG_PATH, primary: true }];
  const seen = new Set([CONFIG_PATH]);
  for (const raw of Array.isArray(extra) ? extra : []) {
    const file = expandHome(String(raw || '').trim());
    if (!file || seen.has(file)) continue;
    seen.add(file);
    roots.push({ file, primary: false });
  }
  return roots;
}

/** Which config files are configured, and whether they are actually there. */
async function listConfigFiles(extra = []) {
  return Promise.all(configRoots(extra).map(async (r) => {
    let exists = false;
    let size = 0;
    try {
      const st = await fsp.stat(r.file);
      exists = st.isFile();
      size = st.size;
    } catch { /* the file does not exist */ }
    return {
      file: r.file,
      label: r.primary ? '~/.ssh/config' : path.basename(r.file),
      primary: r.primary,
      exists,
      size,
    };
  }));
}

/** Full list of SSH-config hosts with their resolved connection details. */
async function listSshHosts({ extra = [] } = {}) {
  const lists = await Promise.all(configRoots(extra).map((r) => hostsFromConfig(r)));
  return lists.flat();
}

/** The hosts one config file defines, on its own terms. */
async function hostsFromConfig({ file, primary }) {
  const aliases = await collectAliases(file);
  const uniq = [];
  const seenAlias = new Set();
  for (const a of aliases) {
    if (seenAlias.has(a.alias)) continue;
    seenAlias.add(a.alias);
    uniq.push(a);
  }
  // Only the primary config is what plain `ssh <alias>` would read; anything
  // else has to be named on the command line, both here and when connecting.
  const asked = primary ? [] : ['-F', file];

  /*
   * `ssh -G` is the authority on what an alias resolves to — it applies Match
   * blocks, Includes and defaults exactly as a connection would. With no ssh
   * client (a Windows machine without the optional feature) there is nothing to
   * ask, and dropping every host would hide the list entirely; so the config's
   * own text is read instead, which covers the common Host/HostName/User/Port
   * case and is honest about being a weaker answer.
   */
  const canResolve = sshbin.sshAvailable();

  const results = await Promise.all(uniq.map(async (a) => {
    const cfg = canResolve ? await resolveHost(a.alias, asked) : await readAliasFromFile(a);
    if (!cfg) return null;
    const proxied = !!(cfg.proxycommand || cfg.proxyjump);
    // ssh tries every IdentityFile/CertificateFile it was given, in order,
    // before falling through to the agent — so a host configured with a
    // certificate plus a fallback key, or several key types, genuinely has
    // more than one. Keeping only the first hid that from the UI (and from
    // anyone using it to work out why a particular key was never offered).
    const identityFiles = asList(cfg.identityfile);
    const certificateFiles = asList(cfg.certificatefile);
    return {
      /*
       * A host in the primary config keeps the id it has always had, because
       * ids reach settings — hidden hosts, stars, remembered logins. The same
       * alias in two config files is two different hosts, so an extra file's
       * hosts carry the file in their id.
       */
      id: primary ? 'ssh:' + a.alias : `ssh:${a.alias}|${file}`,
      type: 'ssh',
      alias: a.alias,
      name: a.alias,
      hostname: cfg.hostname || a.alias,
      user: cfg.user || os.userInfo().username,
      port: Number(cfg.port || 22),
      identityFile: identityFiles[0] || null,
      identityFiles,
      certificateFiles,
      proxied,
      // A Teleport-generated ProxyCommand means this alias already routes
      // through tsh; label it so the UI can group it sensibly.
      viaTsh: /\btsh\b/.test(String(cfg.proxycommand || '')),
      comment: a.comment,
      source: a.source,
      /*
       * The file to pass as `ssh -F`, or null for the primary config (where
       * naming it would *exclude* the system config and any defaults ssh
       * applies on its own). This is what makes a host from an extra config
       * openable at all.
       */
      configFile: primary ? null : file,
      // Which root it was found under, primary included, so the UI can group.
      configRoot: file,
      configLabel: primary ? '~/.ssh/config' : path.basename(file),
      // The details came from the file rather than from ssh itself.
      unresolved: !canResolve,
    };
  }));

  return results.filter(Boolean);
}

/**
 * The keys of one Host block, straight from the file. A fallback for when there
 * is no ssh to expand the alias properly: no Match support, no Include
 * inheritance, no defaults beyond the obvious ones.
 */
async function readAliasFromFile(a) {
  let text;
  try { text = await fsp.readFile(a.source, 'utf8'); } catch { return {}; }

  const cfg = {};
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const kv = splitLine(raw);
    if (!kv) continue;
    if (kv.key === 'host') {
      // Wildcard blocks apply too — `Host *.example` is where a shared port or
      // user usually lives — and as in ssh_config, the first value wins.
      inBlock = tokens(kv.value).map(stripQuotes)
        .some((pat) => pat === a.alias || (/[*?]/.test(pat) && globToRegex(pat).test(a.alias)));
      continue;
    }
    if (!inBlock) continue;
    // Most keys take the first value seen, same as ssh_config itself — but
    // IdentityFile/CertificateFile are explicitly cumulative (ssh tries each
    // one it was given, in order), so those two are collected into a list
    // instead of being overwritten, matching resolveHost()'s own shape.
    if (kv.key === 'identityfile' || kv.key === 'certificatefile') {
      const v = stripQuotes(kv.value);
      cfg[kv.key] = cfg[kv.key] ? [...asList(cfg[kv.key]), v] : v;
      continue;
    }
    if (cfg[kv.key] === undefined) cfg[kv.key] = stripQuotes(kv.value);
  }
  return cfg;
}

/* ------------------------------------------------------------------ */
/* Writing hosts into ~/.ssh/config                                     */
/* ------------------------------------------------------------------ */

const CONFIG_PATH = path.join(HOME, '.ssh', 'config');
const BLOCK_START = '# >>> ServerLife managed hosts >>>';
const BLOCK_END = '# <<< ServerLife managed hosts <<<';

const BLOCK_NOTE = '# Edited by ServerLife; entries outside these markers are left alone.';

/**
 * Split a managed block into individual Host entries.
 *
 * Anything before the first `Host` line (our own note, blank lines) is
 * discarded rather than carried forward — otherwise the note accumulates on
 * every write and the first entry can never be matched for removal.
 */
function parseEntries(block) {
  const entries = [];
  let current = null;
  for (const line of String(block || '').split('\n')) {
    if (/^Host\s+\S/.test(line)) {
      if (current) entries.push(current.join('\n').trimEnd());
      current = [line.trimEnd()];
    } else if (current) {
      current.push(line.trimEnd());
    }
  }
  if (current) entries.push(current.join('\n').trimEnd());
  return entries.filter(Boolean);
}

function aliasOf(entry) {
  const m = entry.match(/^Host\s+(\S+)/);
  return m ? m[1] : null;
}

function renderBlock(entries) {
  return entries.length
    ? `${BLOCK_START}\n${BLOCK_NOTE}\n\n${entries.join('\n\n')}\n\n${BLOCK_END}`
    : `${BLOCK_START}\n${BLOCK_NOTE}\n${BLOCK_END}`;
}

function renderHostBlock(h) {
  const lines = [`Host ${h.alias}`];
  if (h.hostname) lines.push(`  HostName ${h.hostname}`);
  if (h.user) lines.push(`  User ${h.user}`);
  if (h.port && Number(h.port) !== 22) lines.push(`  Port ${h.port}`);
  if (h.identityFile) {
    lines.push(`  IdentityFile ${h.identityFile}`);
    lines.push('  IdentitiesOnly yes');
  }
  if (h.proxyJump) lines.push(`  ProxyJump ${h.proxyJump}`);
  if (h.forwardAgent) lines.push('  ForwardAgent yes');
  for (const line of String(h.extraOptions || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
    lines.push('  ' + line);
  }
  return lines.join('\n');
}

/**
 * Append (or replace) a Host entry inside a marked block.
 *
 * Everything this app writes stays between the markers so the user's own
 * configuration is never reformatted or reordered, and a timestamped backup is
 * taken before the first write of each session.
 */
/**
 * Put a cluster's `tsh config` output into `~/.ssh/config`.
 *
 * `tsh config >> ~/.ssh/config` is the documented gesture, and it is the one
 * thing everybody does by hand — after which plain `ssh node.cluster` works,
 * and so does every tool that only speaks ssh: scp, rsync, Ansible, VS Code
 * Remote, git over ssh.
 *
 * Done here as a *replace* rather than an append, between markers per cluster.
 * A literal `>>` run twice leaves two blocks for the same cluster with the
 * same `Host` patterns, where the first quietly wins and the second is dead
 * text that looks live — which is exactly the confusing state someone is in
 * when they come asking why an edit had no effect. The user's own
 * configuration outside the markers is never touched, and the file is backed
 * up before the first change.
 */
async function appendTshConfig({ cluster, proxy, text }) {
  const tag = String(cluster || proxy || 'teleport').trim();
  if (!tag) throw new Error('Which cluster? A name or proxy is needed.');
  const body = String(text || '').trim();
  if (!body.includes('Host ')) throw new Error('That does not look like ssh config output.');

  const start = `# >>> ServerLife: tsh config for ${tag} >>>`;
  const end = `# <<< ServerLife: tsh config for ${tag} <<<`;

  await fsp.mkdir(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  let existing = '';
  try { existing = await fsp.readFile(CONFIG_PATH, 'utf8'); } catch { /* no config yet: one is started */ }

  let backedUp = null;
  if (existing) {
    const backup = `${CONFIG_PATH}.serverlife-backup-${Date.now()}`;
    await fsp.copyFile(CONFIG_PATH, backup).catch(() => {});
    if (fs.existsSync(backup)) backedUp = backup;
  }

  const block = [
    start,
    '# Written by ServerLife from `tsh config`. Edits inside these markers are',
    '# replaced the next time this cluster is written.',
    body,
    end,
  ].join('\n');

  const si = existing.indexOf(start);
  const ei = existing.indexOf(end);
  const replaced = si !== -1 && ei !== -1 && ei > si;
  /*
   * A cluster's block goes at the *top* of the file when it is new.
   *
   * ssh takes the first value it sees for any option, so a block appended
   * after a catch-all `Host *` that sets, say, `IdentityFile` or `User` can be
   * silently overridden. The generated block is specific (`Host *.cluster`),
   * and first is the only position where it reliably applies.
   */
  const out = replaced
    ? existing.slice(0, si) + block + existing.slice(ei + end.length)
    : block + '\n\n' + (existing ? existing.replace(/^\s*\n/, '') : '');

  const tmp = CONFIG_PATH + '.serverlife-tmp';
  await fsp.writeFile(tmp, out.replace(/\s*$/, '\n'), { mode: 0o600 });
  await fsp.rename(tmp, CONFIG_PATH);
  return { path: CONFIG_PATH, replaced, backup: backedUp, lines: block.split('\n').length };
}

/**
 * Is this cluster already in the file, and if so, how?
 *
 * Two different answers matter. `present` means our own marked block is there,
 * and writing again simply replaces it. `foreign` means the same `Host`
 * patterns are already in the file *outside* the markers — almost always a
 * hand-run `tsh config >> ~/.ssh/config` — and that is worth stopping for:
 * ssh takes the first value it finds for an option, so two blocks for one
 * cluster leave one of them live and the other dead text that reads as live.
 */
async function tshConfigStatus({ cluster, proxy, text: generated }) {
  const tag = String(cluster || proxy || '').trim();
  let text = '';
  try { text = await fsp.readFile(CONFIG_PATH, 'utf8'); } catch { /* no config to read */ }
  const start = `# >>> ServerLife: tsh config for ${tag} >>>`;
  const end = `# <<< ServerLife: tsh config for ${tag} <<<`;
  const present = !!tag && text.includes(start);

  // Everything except our own block for this cluster.
  let outside = text;
  const si = text.indexOf(start);
  const ei = text.indexOf(end);
  if (si !== -1 && ei > si) outside = text.slice(0, si) + text.slice(ei + end.length);

  // The Host patterns the generated block would define, looked for in the rest
  // of the file. Comparing patterns rather than whole text means a block that
  // was written by an older tsh, or hand-edited since, is still recognised.
  const patterns = String(generated || '')
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*Host\s+(.+?)\s*$/i))
    .filter(Boolean)
    .flatMap((m) => m[1].split(/\s+/))
    .filter((h) => h && h !== '*');
  const foreign = [...new Set(patterns)].filter((h) => new RegExp(
    `^\\s*Host\\s+(.*\\s)?${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`, 'mi').test(outside));

  return { path: CONFIG_PATH, present, foreign, hasFile: !!text };
}

async function addHostToConfig(host) {
  if (!host?.alias || /\s/.test(host.alias)) throw new Error('Give the host a single-word alias');
  if (!host.hostname) throw new Error('Hostname is required');
  // Into the config file it was asked for — one the host list reads — or the
  // primary one.
  const target = host.file ? expandHome(host.file) : CONFIG_PATH;
  const label = host.file && target !== CONFIG_PATH ? target : '~/.ssh/config';

  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });

  let text = '';
  try { text = await fsp.readFile(target, 'utf8'); } catch { /* no config to read */ }

  if (text) {
    const backup = `${target}.serverlife-backup`;
    if (!fs.existsSync(backup)) await fsp.copyFile(target, backup).catch(() => {});
  }

  // Refuse to shadow a Host the user defined themselves, outside our block.
  const outside = text.split(BLOCK_START)[0] + (text.split(BLOCK_END)[1] || '');
  const clash = new RegExp(`^\\s*Host\\s+(.*\\s)?${host.alias}(\\s|$)`, 'mi').test(outside);
  if (clash && !host.force) {
    throw new Error(`${label} already defines "${host.alias}" outside the ServerLife block`);
  }

  const startIdx = text.indexOf(BLOCK_START);
  const endIdx = text.indexOf(BLOCK_END);
  let block = '';
  if (startIdx !== -1 && endIdx !== -1) {
    block = text.slice(startIdx + BLOCK_START.length, endIdx).trim();
  }

  // Drop any previous entry for this alias, then append the new one.
  const kept = parseEntries(block)
    .filter((e) => (aliasOf(e) || '').toLowerCase() !== host.alias.toLowerCase());

  kept.push(renderHostBlock(host));
  const newBlock = renderBlock(kept);

  let out;
  if (startIdx !== -1 && endIdx !== -1) {
    out = text.slice(0, startIdx) + newBlock + text.slice(endIdx + BLOCK_END.length);
  } else {
    out = (text ? text.replace(/\s*$/, '\n\n') : '') + newBlock + '\n';
  }

  const tmp = target + '.serverlife-tmp';
  await fsp.writeFile(tmp, out, { mode: 0o600 });
  await fsp.rename(tmp, target);
  return { alias: host.alias, path: target, label };
}

/** Remove an alias from the managed block. Hosts outside it are untouched. */
async function removeHostFromConfig(alias) {
  let text;
  try { text = await fsp.readFile(CONFIG_PATH, 'utf8'); } catch { return { removed: false }; }
  const startIdx = text.indexOf(BLOCK_START);
  const endIdx = text.indexOf(BLOCK_END);
  if (startIdx === -1 || endIdx === -1) return { removed: false };

  const block = text.slice(startIdx + BLOCK_START.length, endIdx);
  const all = parseEntries(block);
  const kept = all.filter((e) => (aliasOf(e) || '').toLowerCase() !== String(alias).toLowerCase());
  if (kept.length === all.length) return { removed: false, alias };

  // An empty block leaves nothing behind; drop the markers entirely.
  const out = kept.length
    ? text.slice(0, startIdx) + renderBlock(kept) + text.slice(endIdx + BLOCK_END.length)
    : (text.slice(0, startIdx).replace(/\n{3,}$/, '\n\n') + text.slice(endIdx + BLOCK_END.length)).replace(/\n{3,}$/, '\n');
  const tmp = CONFIG_PATH + '.serverlife-tmp';
  await fsp.writeFile(tmp, out, { mode: 0o600 });
  await fsp.rename(tmp, CONFIG_PATH);
  return { removed: true, alias };
}

/* ------------------------------------------------------------------ */
/* Removing or commenting out any Host, wherever it was written         */
/* ------------------------------------------------------------------ */

/**
 * Where an alias's `Host` block sits in one file.
 *
 * The block runs from its `Host` line to the line before the next `Host` or
 * `Match`, less the blank and comment lines at its end — those are usually
 * the next host's description, which is how the sidebar reads them too.
 * `shared` lists the other names on the same `Host` line: removing the block
 * would take them with it, so for those only the one name is taken off.
 */
function findHostBlock(lines, alias) {
  for (let i = 0; i < lines.length; i++) {
    const kv = splitLine(lines[i]);
    if (!kv || kv.key !== 'host') continue;
    const names = tokens(kv.value).map(stripQuotes);
    if (!names.includes(alias)) continue;
    let end = i + 1;
    while (end < lines.length) {
      const next = splitLine(lines[end]);
      if (next && (next.key === 'host' || next.key === 'match')) break;
      end++;
    }
    while (end > i + 1 && (!lines[end - 1].trim() || lines[end - 1].trim().startsWith('#'))) end--;
    // Comment lines touching the Host line are its description.
    let lead = i;
    while (lead > 0 && lines[lead - 1].trim().startsWith('#')) lead--;
    return { start: i, lead, end, shared: names.filter((n) => n !== alias) };
  }
  return null;
}

/** The text of an alias's block, to show before anything is changed. */
async function hostBlockPreview({ file, alias }) {
  const text = await fsp.readFile(expandHome(file), 'utf8');
  const lines = text.split(/\r?\n/);
  const b = findHostBlock(lines, alias);
  if (!b) throw new Error(`"${alias}" is not defined in ${file}`);
  const from = b.shared.length ? b.start : b.lead;
  return { file, alias, text: lines.slice(from, b.end).join('\n'), shared: b.shared, line: b.start + 1 };
}

/**
 * Delete an alias from the file it was written in, or comment its block out.
 *
 * The file as it was is copied to `<file>.serverlife-backup` first — over the
 * last one, so it is always the state before the most recent edit — and the
 * new text is written beside it and renamed over, keeping the file's mode.
 */
async function removeHostFromFile({ file, alias, mode = 'delete' } = {}) {
  if (!file || !alias) throw new Error('Give a file and an alias.');
  const target = expandHome(file);
  const text = await fsp.readFile(target, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const b = findHostBlock(lines, alias);
  if (!b) throw new Error(`"${alias}" is not defined in ${file}`);

  let replacement;
  if (b.shared.length) {
    // Other names share this block: take this one off the Host line only.
    const indent = lines[b.start].match(/^\s*/)[0];
    const kept = `${indent}Host ${b.shared.join(' ')}`;
    replacement = mode === 'comment'
      ? [`${indent}# ${alias} taken off this Host line by ServerLife, ${new Date().toISOString().slice(0, 10)}`, kept]
      : [kept];
    lines.splice(b.start, 1, ...replacement);
  } else if (mode === 'comment') {
    replacement = [
      `# Commented out by ServerLife, ${new Date().toISOString().slice(0, 10)}`,
      ...lines.slice(b.start, b.end).map((l) => (l.trim() ? '# ' + l : l)),
    ];
    lines.splice(b.start, b.end - b.start, ...replacement);
  } else {
    // Its description goes with it, and a blank line either side of the
    // hole becomes one.
    let end = b.end;
    if (b.lead > 0 && !lines[b.lead - 1].trim() && end < lines.length && !lines[end].trim()) end++;
    lines.splice(b.lead, end - b.lead);
  }

  const st = await fsp.stat(target);
  await fsp.copyFile(target, target + '.serverlife-backup');
  const tmp = target + '.serverlife-tmp';
  await fsp.writeFile(tmp, lines.join(eol), { mode: st.mode & 0o777 });
  await fsp.rename(tmp, target);
  return { file, alias, mode, shared: b.shared, backup: target + '.serverlife-backup' };
}

/** Which aliases this app wrote, so the UI can offer to remove them. */
async function managedAliases() {
  let text;
  try { text = await fsp.readFile(CONFIG_PATH, 'utf8'); } catch { return []; }
  const startIdx = text.indexOf(BLOCK_START);
  const endIdx = text.indexOf(BLOCK_END);
  if (startIdx === -1 || endIdx === -1) return [];
  const block = text.slice(startIdx + BLOCK_START.length, endIdx);
  return parseEntries(block).map(aliasOf).filter(Boolean);
}

module.exports = {
  listSshHosts, listConfigFiles, resolveHost, collectAliases, expandHome,
  appendTshConfig, tshConfigStatus,
  addHostToConfig, removeHostFromConfig, managedAliases, CONFIG_PATH,
  findHostBlock, hostBlockPreview, removeHostFromFile, readAliasFromFile,
};
