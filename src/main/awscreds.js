'use strict';
/**
 * The AWS access a desktop already has.
 *
 * Most machines that touch AWS have a `~/.aws` with named profiles, and those
 * profiles are rarely plain keys any more — they are SSO sessions, assumed
 * roles, `credential_process` hooks, or an instance role. Re-implementing that
 * chain would be a mistake, so where the AWS CLI is installed it is asked to
 * resolve the profile and hand back the credentials it would have used.
 *
 * Without the CLI the fallback is the one case that can be read honestly: a
 * static key pair written in `~/.aws/credentials`.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const CLI_CANDIDATES = [
  process.env.AWS_CLI_PATH,
  '/opt/homebrew/bin/aws',
  '/usr/local/bin/aws',
  '/usr/bin/aws',
  'aws',
].filter(Boolean);

let cliPath = null;
function findAwsCli() {
  if (cliPath !== null) return cliPath;
  for (const p of CLI_CANDIDATES) {
    try {
      if (p === 'aws') { cliPath = 'aws'; return cliPath; }
      if (fs.existsSync(p)) { cliPath = p; return cliPath; }
    } catch { /* unreadable path: not a candidate */ }
  }
  cliPath = 'aws';
  return cliPath;
}

function run(args, { timeout = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(findAwsCli(), args, {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PATH: (process.env.PATH || '') + ':/usr/local/bin:/opt/homebrew/bin' },
    }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), err });
    });
  });
}

function configDir() {
  return process.env.AWS_CONFIG_FILE
    ? path.dirname(process.env.AWS_CONFIG_FILE)
    : path.join(os.homedir(), '.aws');
}

/** Minimal INI reader — enough for section names and a few keys. */
function parseIni(text) {
  const out = {};
  let section = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/[;#].*$/, '').trim();
    if (!line) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) { section = sec[1].trim(); out[section] = out[section] || {}; continue; }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (kv && section) out[section][kv[1].trim()] = kv[2].trim();
  }
  return out;
}

/**
 * Profiles the user has. `~/.aws/config` names them `[profile x]` while
 * `~/.aws/credentials` names them `[x]`, so both are normalised here.
 */
async function listProfiles() {
  const dir = configDir();
  const names = new Set();
  const details = new Map();

  for (const [file, stripPrefix] of [['config', true], ['credentials', false]]) {
    let text = '';
    try { text = await fsp.readFile(path.join(dir, file), 'utf8'); } catch { continue; }
    const ini = parseIni(text);
    for (const [section, values] of Object.entries(ini)) {
      if (section.startsWith('sso-session ')) continue;
      const name = stripPrefix ? section.replace(/^profile\s+/, '') : section;
      names.add(name);
      const prev = details.get(name) || {};
      details.set(name, {
        ...prev,
        region: values.region || prev.region || '',
        sso: !!(values.sso_session || values.sso_start_url) || prev.sso || false,
        assumesRole: !!values.role_arn || prev.assumesRole || false,
        staticKey: !!values.aws_access_key_id || prev.staticKey || false,
        credentialProcess: !!values.credential_process || prev.credentialProcess || false,
      });
    }
  }

  return [...names].sort((a, b) => (a === 'default' ? -1 : b === 'default' ? 1 : a.localeCompare(b)))
    .map((name) => ({ name, ...(details.get(name) || {}) }));
}

/* ------------------------------------------------------------------ */
/* Resolving                                                           */
/* ------------------------------------------------------------------ */

const cache = new Map();   // profile -> { creds, expiresAt }

/**
 * Credentials for a profile, however that profile happens to get them. The
 * CLI's `export-credentials` runs the whole provider chain — SSO, assumed
 * roles, credential_process, instance metadata — which is precisely the part
 * worth not reimplementing.
 */
async function resolveProfile(profile = 'default', { refresh = false } = {}) {
  const key = profile || 'default';
  const hit = cache.get(key);
  // A minute of headroom: credentials that expire mid-upload are worse than
  // fetching them again.
  if (!refresh && hit && (!hit.expiresAt || hit.expiresAt - Date.now() > 60000)) return hit.creds;

  const r = await run(['configure', 'export-credentials', '--profile', key, '--format', 'process']);
  if (r.ok) {
    let doc;
    try { doc = JSON.parse(r.stdout); } catch { doc = null; }
    if (doc?.AccessKeyId && doc?.SecretAccessKey) {
      const creds = {
        accessKeyId: doc.AccessKeyId,
        secretAccessKey: doc.SecretAccessKey,
        sessionToken: doc.SessionToken || null,
        source: 'aws cli',
        expiration: doc.Expiration || null,
      };
      cache.set(key, { creds, expiresAt: doc.Expiration ? Date.parse(doc.Expiration) : 0 });
      return creds;
    }
  }

  const cliMessage = (r.stderr || r.stdout || '').trim().split('\n').filter(Boolean).pop();

  // Fall back to a static key pair, the one case readable without the CLI.
  const statik = await staticKeys(key);
  if (statik) return statik;

  if (/sso|token.*expired|Error loading SSO/i.test(cliMessage || '')) {
    throw new Error(`AWS profile "${key}" needs a fresh login. Run: aws sso login --profile ${key}`);
  }
  throw new Error(cliMessage
    ? `AWS profile "${key}": ${cliMessage}`
    : `AWS profile "${key}" has no usable credentials, and the AWS CLI is not available to resolve it.`);
}

async function staticKeys(profile) {
  const dir = configDir();
  for (const file of ['credentials', 'config']) {
    let text = '';
    try { text = await fsp.readFile(path.join(dir, file), 'utf8'); } catch { continue; }
    const ini = parseIni(text);
    const section = ini[profile] || ini[`profile ${profile}`];
    if (section?.aws_access_key_id && section?.aws_secret_access_key) {
      return {
        accessKeyId: section.aws_access_key_id,
        secretAccessKey: section.aws_secret_access_key,
        sessionToken: section.aws_session_token || null,
        source: `~/.aws/${file}`,
        expiration: null,
      };
    }
  }
  return null;
}

/** The profile's configured region, so a bucket need not be told twice. */
async function profileRegion(profile = 'default') {
  const list = await listProfiles();
  const found = list.find((p) => p.name === profile);
  return found?.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || '';
}

function forget(profile) {
  if (profile) cache.delete(profile);
  else cache.clear();
}

module.exports = { listProfiles, resolveProfile, profileRegion, findAwsCli, forget };
