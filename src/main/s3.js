'use strict';
/**
 * S3 as another place files live.
 *
 * Signature V4 is implemented here rather than pulling in the AWS SDK: the
 * whole of it is a few hashes, it adds no dependency to an app that ships a
 * browser already, and it keeps S3 on the same footing as the hand-written
 * SFTP client next door.
 *
 * Credentials are never invented. A target either names environment variables
 * the user already has (the common case — AWS_PROFILE, SSO, instance roles all
 * export these) or carries keys the renderer supplied, which the store keeps
 * encrypted through the OS keychain.
 */

const https = require('https');
const fsx = require('./fsx');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { URL } = require('url');

const SERVICE = 's3';
const UNSIGNED = 'UNSIGNED-PAYLOAD';

/** Storage classes S3 accepts on a PUT, cheapest-to-restore first. */
const STORAGE_CLASSES = [
  { value: 'STANDARD', label: 'Standard', hint: 'Default. Instant access.' },
  { value: 'INTELLIGENT_TIERING', label: 'Intelligent-Tiering', hint: 'Moves between tiers automatically.' },
  { value: 'STANDARD_IA', label: 'Standard-IA', hint: 'Cheaper storage, charged per retrieval.' },
  { value: 'ONEZONE_IA', label: 'One Zone-IA', hint: 'As Standard-IA, single availability zone.' },
  { value: 'GLACIER_IR', label: 'Glacier Instant Retrieval', hint: 'Archive, still instant to read.' },
  { value: 'GLACIER', label: 'Glacier Flexible Retrieval', hint: 'Restore takes minutes to hours.' },
  { value: 'DEEP_ARCHIVE', label: 'Glacier Deep Archive', hint: 'Cheapest. Restore takes hours.' },
  { value: 'REDUCED_REDUNDANCY', label: 'Reduced Redundancy', hint: 'Legacy. Not recommended.' },
];

/* ------------------------------------------------------------------ */
/* Signature V4                                                        */
/* ------------------------------------------------------------------ */

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/**
 * Each path segment is encoded, but the separators are not — S3 treats the key
 * as a path, and encoding the slashes would ask for a different object.
 */
function encodeKey(key) {
  return String(key).split('/').map(encodeRfc3986).join('/');
}

function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function canonicalQuery(query) {
  const pairs = Object.entries(query || {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(String(v))]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : 1)));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function amzDate(d = new Date()) {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { full: iso, day: iso.slice(0, 8) };
}

/**
 * Sign a request and return the headers to send. Exported so the signature can
 * be checked against AWS's published test vectors without a network or an
 * account.
 */
function signRequest({
  method, host, canonicalUri, query = {}, headers = {},
  payloadHash = sha256(''), region, credentials, date = new Date(),
}) {
  const { full, day } = amzDate(date);
  const scope = `${day}/${region}/${SERVICE}/aws4_request`;

  const all = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': full,
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
    ...headers,
  };

  const names = Object.keys(all).map((h) => h.toLowerCase()).sort();
  const lookup = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonicalHeaders = names.map((n) => `${n}:${lookup[n]}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    full,
    scope,
    sha256(canonicalRequest),
  ].join('\n');

  const kDate = hmac('AWS4' + credentials.secretAccessKey, day);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    headers: {
      ...all,
      Authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, `
        + `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    signature,
    canonicalRequest,
    stringToSign,
  };
}

/* ------------------------------------------------------------------ */
/* Targets and credentials                                             */
/* ------------------------------------------------------------------ */

/**
 * Where a target's keys come from. 'env' reads the process environment at the
 * moment of use, so rotating credentials outside the app is picked up without
 * re-registering anything.
 */
function resolveCredentials(target, env = process.env) {
  const mode = target.credentials?.mode || 'env';
  // Teleport credentials are minted per session by `tsh proxy aws`; main
  // resolves them before calling in, because starting a proxy is async.
  if (mode === 'teleport' || mode === 'profile') {
    const c = target.credentials || {};
    if (!c.accessKeyId || !c.secretAccessKey) {
      throw new Error(mode === 'teleport'
        ? `${target.name}: the Teleport AWS proxy has not been started for this bucket.`
        : `${target.name}: the AWS profile has not been resolved for this bucket.`);
    }
    return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, sessionToken: c.sessionToken || null };
  }
  if (mode === 'explicit') {
    const c = target.credentials || {};
    if (!c.accessKeyId || !c.secretAccessKey) {
      throw new Error(`${target.name}: no access key stored. Edit the bucket and enter one, or switch it to environment credentials.`);
    }
    return {
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      sessionToken: c.sessionToken || null,
    };
  }

  const prefix = target.credentials?.envPrefix || '';
  const pick = (name) => env[prefix + name] || env[name];
  const accessKeyId = pick('AWS_ACCESS_KEY_ID');
  const secretAccessKey = pick('AWS_SECRET_ACCESS_KEY');
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `${target.name}: ${prefix || 'AWS'}_ACCESS_KEY_ID and ${prefix || 'AWS'}_SECRET_ACCESS_KEY are not set in this app's environment. `
      + 'Launch ServerLife from a shell that has them, or store keys on the bucket instead.');
  }
  return { accessKeyId, secretAccessKey, sessionToken: pick('AWS_SESSION_TOKEN') || null };
}

/** Virtual-hosted addressing by default; path style for MinIO and friends. */
function endpointFor(target) {
  const region = target.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  if (target.endpoint) {
    const u = new URL(/^https?:\/\//i.test(target.endpoint) ? target.endpoint : 'https://' + target.endpoint);
    return {
      protocol: u.protocol, host: u.host, region,
      pathStyle: target.pathStyle !== false,
      basePath: u.pathname.replace(/\/+$/, ''),
    };
  }
  return {
    protocol: 'https:',
    host: `${target.bucket}.s3.${region}.amazonaws.com`,
    region,
    pathStyle: false,
    basePath: '',
  };
}

/** The service endpoint rather than a bucket's — what ListBuckets talks to. */
function serviceUri(target) {
  const region = target.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  if (target.endpoint) {
    const ep = endpointFor(target);
    return { ep, uri: (ep.basePath || '') + '/' };
  }
  return {
    ep: { protocol: 'https:', host: `s3.${region}.amazonaws.com`, region, pathStyle: true, basePath: '' },
    uri: '/',
  };
}

function uriFor(target, key) {
  const ep = endpointFor(target);
  const encoded = key ? encodeKey(key) : '';
  const uri = ep.pathStyle
    ? `${ep.basePath}/${encodeRfc3986(target.bucket)}${encoded ? '/' + encoded : ''}`
    : `${ep.basePath}/${encoded}`;
  return { ep, uri: uri || '/' };
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

async function request(opts) {
  const res = await requestOnce(opts);
  /*
   * A bucket outside the target's region answers 301 with the real region in a
   * header. Signing is region-specific, so the first call cannot succeed — but
   * the answer is right there, and retrying once is cheaper than making the
   * user find out which region a bucket is in.
   */
  const moved = res.status === 301 && res.headers['x-amz-bucket-region'];
  if (moved && moved !== (opts.target.region || '') && !opts._retried && !opts.stream) {
    res.res.resume();
    return requestOnce({ ...opts, target: { ...opts.target, region: moved }, _retried: true });
  }
  return res;
}

function requestOnce({ target, method = 'GET', key = '', query = {}, headers = {}, body = null, payloadHash, stream = null, onProgress = null, signal = null, bucketless = false }) {
  const { ep, uri } = bucketless ? serviceUri(target) : uriFor(target, key);
  const credentials = resolveCredentials(target);
  const hash = payloadHash || (body ? sha256(body) : (stream ? UNSIGNED : sha256('')));

  const signed = signRequest({
    method,
    host: ep.host,
    canonicalUri: uri,
    query,
    headers,
    payloadHash: hash,
    region: ep.region,
    credentials,
  });

  const mod = ep.protocol === 'http:' ? http : https;
  const qs = canonicalQuery(query);

  return new Promise((resolve, reject) => {
    const req = mod.request({
      protocol: ep.protocol,
      host: ep.host,
      method,
      path: uri + (qs ? '?' + qs : ''),
      headers: signed.headers,
      timeout: 60000,
      // Set when the credentials came from Teleport: every byte goes through
      // its local proxy, which re-signs with the real IAM role.
      ...(target.agent ? { agent: target.agent } : {}),
    }, (res) => {
      resolve({ res, status: res.statusCode, headers: res.headers });
    });
    req.on('error', reject);
    req.once('timeout', () => req.destroy(new Error('S3 request timed out.')));
    if (signal) signal.addEventListener('abort', () => req.destroy(new Error('Cancelled')), { once: true });

    if (stream) {
      let sent = 0;
      stream.on('data', (c) => { sent += c.length; onProgress?.(sent); });
      stream.on('error', reject);
      stream.pipe(req);
    } else {
      req.end(body || undefined);
    }
  });
}

async function readBody(res) {
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/** S3 reports failures as XML; the message inside is the useful part. */
async function failure(res, status, what) {
  const text = await readBody(res).catch(() => '');
  const msg = (text.match(/<Message>([^<]*)<\/Message>/) || [])[1];
  const code = (text.match(/<Code>([^<]*)<\/Code>/) || [])[1];
  if (status === 403) {
    return new Error(`${what}: access denied${code ? ` (${code})` : ''}. Check the credentials and the bucket policy.`);
  }
  if (status === 404) return new Error(`${what}: not found${code ? ` (${code})` : ''}.`);
  return new Error(`${what}: ${msg || code || 'HTTP ' + status}`);
}

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

function xmlAll(text, tag) {
  const out = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

function xmlOne(text, tag) {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? m[1] : null;
}

function unescapeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * One "directory" of a bucket. S3 has no directories, so the delimiter turns
 * shared key prefixes into the folders the file browser expects.
 */
async function list({ target, prefix = '' }) {
  const base = joinPrefix(target.prefix, prefix);
  const entries = [];
  let token = null;

  do {
    const { res, status } = await request({
      target,
      query: {
        'list-type': '2',
        delimiter: '/',
        prefix: base,
        'max-keys': '1000',
        ...(token ? { 'continuation-token': token } : {}),
      },
    });
    if (status !== 200) throw await failure(res, status, `Listing ${target.bucket}`);
    const text = await readBody(res);

    for (const cp of xmlAll(text, 'CommonPrefixes')) {
      const p = unescapeXml(xmlOne(cp, 'Prefix') || '');
      const name = p.slice(base.length).replace(/\/$/, '');
      if (name) entries.push({ name, path: p, type: 'directory', size: 0, mtime: 0 });
    }
    for (const c of xmlAll(text, 'Contents')) {
      const k = unescapeXml(xmlOne(c, 'Key') || '');
      const name = k.slice(base.length);
      // The prefix itself comes back as a zero-length key; it is not a file.
      if (!name) continue;
      entries.push({
        name,
        path: k,
        type: 'file',
        size: Number(xmlOne(c, 'Size') || 0),
        mtime: Date.parse(xmlOne(c, 'LastModified') || '') || 0,
        storageClass: xmlOne(c, 'StorageClass') || 'STANDARD',
      });
    }

    token = xmlOne(text, 'IsTruncated') === 'true'
      ? unescapeXml(xmlOne(text, 'NextContinuationToken') || '')
      : null;
  } while (token);

  return { prefix: base, entries };
}

/**
 * What sits under a prefix, counted rather than listed: how many objects, how
 * many bytes, how they are tiered, and when they were last touched. Listing
 * without a delimiter walks the whole subtree, so it is capped — the caller is
 * told when the answer is a floor rather than a total.
 */
async function prefixInfo({ target, prefix = '', maxKeys = 200000 }) {
  const base = joinPrefix(target.prefix, prefix);
  let token = null;
  let objects = 0;
  let bytes = 0;
  let newest = 0;
  let oldest = 0;
  let truncated = false;
  const classes = new Map();

  do {
    const { res, status } = await request({
      target,
      query: {
        'list-type': '2',
        prefix: base,
        'max-keys': '1000',
        ...(token ? { 'continuation-token': token } : {}),
      },
    });
    if (status !== 200) throw await failure(res, status, `Listing ${target.bucket}`);
    const text = await readBody(res);

    for (const c of xmlAll(text, 'Contents')) {
      const key = unescapeXml(xmlOne(c, 'Key') || '');
      if (key === base) continue;          // the folder marker itself
      objects++;
      bytes += Number(xmlOne(c, 'Size') || 0);
      const when = Date.parse(xmlOne(c, 'LastModified') || '') || 0;
      if (when) {
        if (when > newest) newest = when;
        if (!oldest || when < oldest) oldest = when;
      }
      const cls = xmlOne(c, 'StorageClass') || 'STANDARD';
      classes.set(cls, (classes.get(cls) || 0) + 1);
    }

    token = xmlOne(text, 'IsTruncated') === 'true'
      ? unescapeXml(xmlOne(text, 'NextContinuationToken') || '')
      : null;
    if (objects >= maxKeys) { truncated = !!token; token = null; }
  } while (token);

  return {
    prefix: base, objects, bytes, newest, oldest, truncated,
    classes: [...classes.entries()].sort((a, b) => b[1] - a[1]),
  };
}

function joinPrefix(...parts) {
  const joined = parts
    .filter(Boolean)
    .map((p) => String(p).replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return joined ? joined + '/' : '';
}

async function download({ target, key, destPath, onProgress, signal }) {
  const { res, status, headers } = await request({ target, key, signal });
  if (status !== 200) throw await failure(res, status, `Downloading ${key}`);

  await fsx.ensureParentDir(destPath);
  const total = Number(headers['content-length'] || 0);
  let done = 0;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.on('data', (c) => { done += c.length; onProgress?.(done, total); });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });
  return { path: destPath, bytes: done };
}

async function upload({ target, localPath, key, storageClass, contentType, onProgress, signal }) {
  const stat = await fsp.stat(localPath);
  if (!stat.isFile()) throw new Error(`${localPath} is not a file.`);
  // A single PUT tops out at 5 GiB; beyond that S3 requires multipart.
  if (stat.size > 5 * 1024 * 1024 * 1024) {
    throw new Error(`${path.basename(localPath)} is larger than 5 GiB, which needs a multipart upload — not supported yet.`);
  }

  const headers = {
    'content-length': String(stat.size),
    ...(contentType ? { 'content-type': contentType } : {}),
    ...(storageClass && storageClass !== 'STANDARD' ? { 'x-amz-storage-class': storageClass } : {}),
  };

  const { res, status } = await request({
    target,
    method: 'PUT',
    key,
    headers,
    stream: fs.createReadStream(localPath),
    // Streaming means the body is not in hand to hash; over TLS this is what
    // AWS expects instead.
    payloadHash: UNSIGNED,
    onProgress: (sent) => onProgress?.(sent, stat.size),
    signal,
  });
  if (status !== 200) throw await failure(res, status, `Uploading ${path.basename(localPath)}`);
  res.resume();
  return { key, bytes: stat.size, storageClass: storageClass || 'STANDARD' };
}

async function remove({ target, keys }) {
  for (const key of keys) {
    const { res, status } = await request({ target, method: 'DELETE', key });
    // 204 is the success here; 404 means it is already gone, which is fine.
    if (status !== 204 && status !== 200 && status !== 404) {
      throw await failure(res, status, `Deleting ${key}`);
    }
    res.resume();
  }
  return true;
}

/** Copy within a bucket, which is how S3 does both rename and re-tiering. */
async function copy({ target, fromKey, toKey, storageClass }) {
  const source = `/${target.bucket}/${encodeKey(fromKey)}`;
  const { res, status } = await request({
    target,
    method: 'PUT',
    key: toKey,
    headers: {
      'x-amz-copy-source': source,
      ...(storageClass ? { 'x-amz-storage-class': storageClass } : {}),
    },
  });
  if (status !== 200) throw await failure(res, status, `Copying ${fromKey}`);
  res.resume();
  return true;
}

async function head({ target, key }) {
  const { res, status, headers } = await request({ target, method: 'HEAD', key });
  res.resume();
  if (status !== 200) throw new Error(`${key}: HTTP ${status}`);
  return {
    size: Number(headers['content-length'] || 0),
    mtime: Date.parse(headers['last-modified'] || '') || 0,
    storageClass: headers['x-amz-storage-class'] || 'STANDARD',
    contentType: headers['content-type'] || null,
  };
}

/**
 * Every bucket the credentials can see, so one can be picked from a list
 * rather than typed. Needs s3:ListAllMyBuckets, which some roles withhold —
 * the caller is expected to fall back to typing a name.
 */
async function listBuckets({ target }) {
  const { res, status } = await request({ target, bucketless: true });
  if (status !== 200) throw await failure(res, status, 'Listing buckets');
  const text = await readBody(res);
  const owner = unescapeXml(xmlOne(xmlOne(text, 'Owner') || '', 'DisplayName') || '');
  return {
    owner,
    buckets: xmlAll(text, 'Bucket').map((b) => ({
      name: unescapeXml(xmlOne(b, 'Name') || ''),
      createdAt: Date.parse(xmlOne(b, 'CreationDate') || '') || 0,
    })).filter((b) => b.name),
  };
}

/** Which region a bucket lives in — signing fails against the wrong one. */
async function bucketRegion({ target }) {
  const { res, status, headers } = await request({ target, method: 'HEAD' });
  res.resume();
  const region = headers['x-amz-bucket-region'];
  if (!region && status >= 400) throw new Error(`Could not determine the region for ${target.bucket}.`);
  return region || target.region || 'us-east-1';
}

/** A cheap credentials-and-bucket check, so registering one can be verified. */
async function test({ target }) {
  const { res, status } = await request({
    target,
    query: { 'list-type': '2', 'max-keys': '1', prefix: joinPrefix(target.prefix) },
  });
  if (status !== 200) throw await failure(res, status, `Reaching ${target.bucket}`);
  const text = await readBody(res);
  const ep = endpointFor(target);
  return {
    ok: true,
    bucket: target.bucket,
    region: ep.region,
    endpoint: ep.host,
    keys: xmlAll(text, 'Contents').length,
  };
}

module.exports = {
  STORAGE_CLASSES,
  signRequest, encodeKey, canonicalQuery, resolveCredentials, endpointFor, joinPrefix,
  list, prefixInfo, download, upload, remove, copy, head, test, listBuckets, bucketRegion,
};
