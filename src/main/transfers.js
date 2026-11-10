'use strict';
/**
 * Transfer engine: pipelined SFTP uploads/downloads with progress, plus a
 * queue that serialises work per connection.
 *
 * SFTP reads/writes are capped at ~32KB per packet, so throughput depends
 * entirely on keeping several requests in flight. Each worker owns a strided
 * set of chunks and fully completes its own range, which keeps short reads
 * correct without leaving holes.
 */

const fsx = require('./fsx');
const fsp = require('fs/promises');
const path = require('path');
const { EventEmitter } = require('events');
const { F } = require('./sftp');

const PIPELINE_DEPTH = 16;

function posixJoin(dir, name) {
  if (!dir || dir === '/') return '/' + name;
  return dir.endsWith('/') ? dir + name : dir + '/' + name;
}

/**
 * Run `count` workers that each pull indices off a shared counter.
 * Errors abort the whole group.
 */
async function parallelChunks(count, total, fn) {
  let next = 0;
  let failed = null;
  const take = () => (failed || next >= total ? -1 : next++);
  const workers = [];
  for (let i = 0; i < count; i++) {
    workers.push((async () => {
      for (;;) {
        const idx = take();
        if (idx < 0) return;
        try { await fn(idx); } catch (e) { failed = failed || e; throw e; }
      }
    })());
  }
  const results = await Promise.allSettled(workers);
  const bad = results.find((r) => r.status === 'rejected');
  if (bad) throw bad.reason;
}

/**
 * Download one remote file to a local path.
 *
 * `onPhase` is called for the work that happens after the last byte has been
 * counted — closing the local file, closing the remote handle, restoring the
 * timestamp. On a large file that tail is long enough to see, and without
 * something to say the progress bar sits at 100% looking stuck.
 */
async function downloadFile(sftp, remotePath, localPath, opts = {}) {
  const { onProgress, onPhase, signal, gate, throttle, resume } = opts;
  const attrs = await sftp.stat(remotePath);
  const size = attrs.size ?? 0;
  const chunk = sftp.maxRead;

  await fsx.ensureParentDir(localPath);
  /*
   * Resuming picks up where the local copy stops.
   *
   * Only on an explicit retry: a fresh transfer to an existing path means
   * "replace it", and appending to whatever was there would quietly produce a
   * corrupt file. Writes are positional, so `r+` keeps the bytes already
   * fetched and the chunks below the mark are simply skipped.
   */
  let from = 0;
  if (resume) {
    try {
      const st = await fsp.stat(localPath);
      if (st.isFile() && st.size > 0 && st.size < size) from = st.size;
    } catch { /* nothing there to resume from */ }
  }
  const handle = await sftp.open(remotePath, F.READ);
  const local = await fsp.open(localPath, from ? 'r+' : 'w');
  let done = from;
  if (from) onProgress?.(done, size);

  try {
    if (size === 0) {
      // Unknown or empty size: fall back to a simple sequential drain.
      let offset = from;
      for (;;) {
        if (signal?.aborted) throw new Error('cancelled');
        if (gate) await gate();
        const data = await sftp.readChunk(handle, offset, chunk);
        if (!data || data.length === 0) break;
        await local.write(data, 0, data.length, offset);
        offset += data.length;
        done = offset;
        onProgress?.(done, Math.max(done, size));
        if (throttle) await throttle(data.length);
      }
    } else {
      const chunks = Math.ceil(size / chunk);
      await parallelChunks(PIPELINE_DEPTH, chunks, async (idx) => {
        let offset = idx * chunk;
        const end = Math.min(offset + chunk, size);
        // Already on disk from an interrupted run.
        if (end <= from) return;
        if (offset < from) offset = from;
        while (offset < end) {
          if (signal?.aborted) throw new Error('cancelled');
          if (gate) await gate();
          const data = await sftp.readChunk(handle, offset, end - offset);
          if (!data || data.length === 0) return; // early EOF (file shrank)
          await local.write(data, 0, data.length, offset);
          offset += data.length;
          done += data.length;
          onProgress?.(done, size);
          if (throttle) await throttle(data.length);
        }
      });
    }
  } finally {
    onPhase?.('writing out the file');
    await local.close().catch(() => {});
    await sftp.close(handle).catch(() => {});
  }

  if (attrs.mtime) {
    await fsp.utimes(localPath, attrs.atime || attrs.mtime, attrs.mtime).catch(() => {});
  }
  onPhase?.(null);
  return done;
}

/** Upload one local file to a remote path. See downloadFile for `onPhase`. */
async function uploadFile(sftp, localPath, remotePath, opts = {}) {
  const { onProgress, onPhase, signal, gate, throttle, resume } = opts;
  const st = await fsp.stat(localPath);
  const size = st.size;
  const chunk = sftp.maxWrite;

  const mode = st.mode & 0o777;
  // The same resume rule as a download, from the other end: what the server
  // already has, and only when a retry asked for it. Without TRUNC, so the
  // bytes already there survive.
  let from = 0;
  if (resume) {
    try {
      const rst = await sftp.stat(remotePath);
      if ((rst.size ?? 0) > 0 && rst.size < size) from = rst.size;
    } catch { /* not there yet */ }
  }
  const handle = from
    ? await sftp.open(remotePath, F.WRITE | F.CREAT, { mode })
    : await sftp.open(remotePath, F.WRITE | F.CREAT | F.TRUNC, { mode });
  const local = await fsp.open(localPath, 'r');
  let done = from;
  if (from) onProgress?.(done, size);

  try {
    const chunks = Math.max(1, Math.ceil(size / chunk));
    await parallelChunks(PIPELINE_DEPTH, chunks, async (idx) => {
      let offset = idx * chunk;
      const end = Math.min(offset + chunk, size);
      if (end <= from) return;
      if (offset < from) offset = from;
      if (offset >= end && size > 0) return;
      const len = end - offset;
      if (len <= 0) return;
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await local.read(buf, 0, len, offset);
      if (bytesRead <= 0) return;
      if (signal?.aborted) throw new Error('cancelled');
      if (gate) await gate();
      await sftp.writeChunk(handle, offset, buf.subarray(0, bytesRead));
      done += bytesRead;
      onProgress?.(done, size);
      if (throttle) await throttle(bytesRead);
    });
  } finally {
    // The last write returning is not the file being on the disk: the server
    // flushes on CLOSE, and for a large file that is where the seconds go.
    onPhase?.('the server is closing the file');
    await local.close().catch(() => {});
    await sftp.close(handle).catch(() => {});
  }

  // An overwrite keeps the existing file's mode through TRUNC, so this is what
  // makes the uploaded copy match the local one — and the timestamp is what
  // lets a later sync see the two as the same file rather than sending it
  // again every run.
  onPhase?.('setting permissions');
  await sftp.chmod(remotePath, mode).catch(() => {});
  if (st.mtimeMs) {
    const secs = Math.floor(st.mtimeMs / 1000);
    await sftp.utimes(remotePath, Math.floor((st.atimeMs || st.mtimeMs) / 1000), secs).catch(() => {});
  }
  onPhase?.(null);
  return done;
}

/**
 * Thrown by planUpload()/planDownload() when `signal` was aborted mid-walk —
 * a marker, not a real failure, so a caller can tell "this was a deliberate
 * cancel" apart from an actual error (a permission denial, a vanished path)
 * without string-matching a message.
 */
class PlanCancelled extends Error {
  constructor() { super('Cancelled'); this.name = 'PlanCancelled'; }
}

/**
 * Walk a local directory into a flat file list with remote destinations.
 * `signal`, when given, is checked at each directory boundary — not an
 * instant mid-syscall abort, but bounded to "finish this directory, then
 * stop" rather than walking the rest of a huge tree for nothing once a
 * cancel has already been asked for.
 */
async function planUpload(localPath, remoteDir, signal) {
  const st = await fsp.stat(localPath);
  const base = path.basename(localPath);
  if (st.isFile()) {
    return { files: [{ local: localPath, remote: posixJoin(remoteDir, base), size: st.size }], dirs: [] };
  }
  const files = [];
  const dirs = [];
  async function walk(lp, rp) {
    if (signal?.aborted) throw new PlanCancelled();
    dirs.push(rp);
    const entries = await fsp.readdir(lp, { withFileTypes: true });
    for (const e of entries) {
      if (signal?.aborted) throw new PlanCancelled();
      const l = path.join(lp, e.name);
      const r = posixJoin(rp, e.name);
      if (e.isDirectory()) await walk(l, r);
      else if (e.isFile()) {
        const s = await fsp.stat(l).catch(() => null);
        if (s) files.push({ local: l, remote: r, size: s.size });
      }
    }
  }
  await walk(localPath, posixJoin(remoteDir, base));
  return { files, dirs };
}

/** Walk a remote directory into a flat file list with local destinations. Same cancellation shape as planUpload() above. */
async function planDownload(sftp, remotePath, localDir, knownEntry, signal) {
  const base = remotePath.split('/').filter(Boolean).pop() || 'download';
  let type = knownEntry?.type;
  if (!type || type === 'symlink') {
    const a = await sftp.stat(remotePath);
    type = (a.mode & 0o170000) === 0o040000 ? 'directory' : 'file';
  }
  if (type !== 'directory') {
    const a = await sftp.stat(remotePath);
    return { files: [{ remote: remotePath, local: path.join(localDir, base), size: a.size ?? 0 }], dirs: [] };
  }
  const files = [];
  const dirs = [];
  async function walk(rp, lp) {
    if (signal?.aborted) throw new PlanCancelled();
    dirs.push(lp);
    const entries = await sftp.list(rp);
    for (const e of entries) {
      if (signal?.aborted) throw new PlanCancelled();
      const l = path.join(lp, e.name);
      if (e.type === 'directory') await walk(e.path, l);
      else if (e.type === 'file') files.push({ remote: e.path, local: l, size: e.size });
    }
  }
  await walk(remotePath, path.join(localDir, base));
  return { files, dirs };
}

let jobSeq = 0;

/**
 * Per-connection transfer queue. Emits 'update' with a serialisable job view
 * so the renderer can render a live transfer panel.
 */
class TransferQueue extends EventEmitter {
  constructor(getSftp) {
    super();
    this.getSftp = getSftp;
    this.jobs = new Map();
    this.running = false;
    this.order = [];
    /**
     * Bytes per second across the whole queue, 0 for no limit.
     *
     * One bucket rather than one per job, because the thing being protected is
     * the link: two transfers at "2 MB/s each" is 4 MB/s of someone else's
     * video call.
     */
    this.limit = 0;
    this._window = { at: 0, bytes: 0 };
    /**
     * Whether the queue as a whole is held.
     *
     * Separate from each job's own flag so that a file dropped in while
     * everything is paused waits with the rest — starting it immediately is
     * the opposite of what "pause all" was asked to do.
     */
    this.allPaused = false;
  }

  setLimit(bytesPerSecond) {
    this.limit = Math.max(0, Number(bytesPerSecond) || 0);
    this._emit();
    return this.limit;
  }

  /** Hold a transfer between chunks while it is paused. */
  _gateFor(job) {
    return () => {
      if (!job.paused) return undefined;
      // One promise per pause, resolved by resume(); the transfer simply waits
      // inside its chunk loop, which keeps every handle open and means
      // resuming costs nothing.
      if (!job._gateWaiters) job._gateWaiters = [];
      return new Promise((resolve) => job._gateWaiters.push(resolve));
    };
  }

  /**
   * Spend `n` bytes of the second's allowance, waiting if it has run out.
   *
   * A plain sliding window: crude next to a token bucket, and exactly as
   * accurate as anyone cares about for "don't saturate the uplink".
   */
  _throttleFor() {
    return (n) => {
      if (!this.limit) return undefined;
      /*
       * Serialised through one chain.
       *
       * A transfer runs sixteen chunk requests at once, and an unserialised
       * window let each of them see "over budget", wait the same second in
       * parallel and then reset the window — which came out at four times the
       * limit. Queuing the accounting behind itself makes the allowance mean
       * what it says.
       */
      this._chain = (this._chain || Promise.resolve()).then(async () => {
        const now = Date.now();
        if (now - this._window.at >= 1000) this._window = { at: now, bytes: 0 };
        this._window.bytes += n;
        if (this._window.bytes > this.limit) {
          const wait = Math.max(0, 1000 - (now - this._window.at));
          if (wait) await new Promise((r) => setTimeout(r, wait));
          this._window = { at: Date.now(), bytes: 0 };
        }
      });
      return this._chain;
    };
  }

  add(job) {
    const id = 'job' + (++jobSeq);
    const rec = {
      id,
      kind: job.kind,               // 'upload' | 'download' | 'cross'
      customRun: job.customRun || null,
      label: job.label,
      items: job.items,             // [{local, remote, size}]
      dirs: job.dirs || [],
      /*
       * What the user actually picked, before it was flattened into files.
       * A tree's file list starts at some arbitrary leaf — often a dotfile
       * several levels down — so nothing in `items` can say "this came from
       * /home/ubuntu/web" once the walk has happened.
       */
      roots: job.roots || [],
      totalBytes: job.items.reduce((a, b) => a + (b.size || 0), 0),
      doneBytes: 0,
      fileIndex: 0,
      fileCount: job.items.length,
      currentFile: null,
      // What is happening when it is no longer about bytes: the tail of a
      // transfer, so a full progress bar can say why it is not finished yet.
      phase: null,
      status: 'queued',             // queued|running|done|error|cancelled
      // Held between chunks rather than torn down, so resuming is instant and
      // nothing has to be re-authenticated or re-opened.
      paused: false,
      // Set by retry(): pick up where the interrupted copy stopped.
      resume: false,
      error: null,
      startedAt: null,
      endedAt: null,
      rate: 0,
      _abort: new AbortController(),
      _lastTick: 0,
      _lastBytes: 0,
    };
    if (this.allPaused) rec.paused = true;
    this.jobs.set(id, rec);
    this.order.push(id);
    this._emit();
    this._pump();
    return id;
  }

  /**
   * A placeholder job, visible (and cancellable) immediately — before the
   * directory walk that fills in its file list has even started. The walk
   * for a big tree can take a real stretch of time with nothing in `add()`'s
   * shape to show for it yet; this is that shape's "nothing to show" state,
   * made visible instead of invisible. Call finishPlanning() once the walk
   * completes to turn it into a real queued job, or failPlanning() if it
   * errors out instead. Returns the new job's id and its own AbortController
   * signal — not the job record itself, so callers never reach into the
   * queue's own internals to get at it.
   */
  addPlanning({ kind, label }) {
    const id = 'job' + (++jobSeq);
    const rec = {
      id, kind, customRun: null, label,
      items: [], dirs: [], roots: [],
      totalBytes: 0, doneBytes: 0, fileIndex: 0, fileCount: 0, currentFile: null,
      phase: null,
      status: 'planning',           // see add()'s own status comment — this precedes 'queued'
      paused: false, resume: false, error: null,
      startedAt: null, endedAt: null, rate: 0,
      _abort: new AbortController(),
      _lastTick: 0, _lastBytes: 0,
    };
    this.jobs.set(id, rec);
    this.order.push(id);
    this._emit();
    return { id, signal: rec._abort.signal };
  }

  /** The walk behind a planning job finished — turn it into a real, runnable job. A no-op if it's gone, or already cancelled, while planning. */
  finishPlanning(id, { label, items, dirs, roots } = {}) {
    const j = this.jobs.get(id);
    if (!j || j.status !== 'planning') return;
    if (label != null) j.label = label;
    j.items = items || [];
    j.dirs = dirs || [];
    j.roots = roots || [];
    j.totalBytes = j.items.reduce((a, b) => a + (b.size || 0), 0);
    j.fileCount = j.items.length;
    j.status = 'queued';
    if (this.allPaused) j.paused = true;
    this._emit();
    this._pump();
  }

  /** The walk itself failed (a permission error partway through a tree, say) — surfaced the same way a failed byte-transfer already is, not a silent disappearance. */
  failPlanning(id, message) {
    const j = this.jobs.get(id);
    if (!j || j.status !== 'planning') return;
    j.status = 'error';
    j.error = message || 'Could not read the file list';
    j.endedAt = Date.now();
    this._emit();
  }

  cancel(id) {
    const j = this.jobs.get(id);
    if (!j) return;
    // A paused job is waiting on its gate; let it go so it can see the abort.
    j.paused = false;
    this._release(j);
    j._abort.abort();
    if (j.status === 'queued' || j.status === 'planning') { j.status = 'cancelled'; j.endedAt = Date.now(); }
    this._emit();
  }

  _release(j) {
    const waiters = j._gateWaiters || [];
    j._gateWaiters = [];
    for (const w of waiters) w();
  }

  pause(id) {
    const j = this.jobs.get(id);
    if (!j || !['queued', 'running'].includes(j.status)) return;
    j.paused = true;
    this._emit();
  }

  resume(id) {
    const j = this.jobs.get(id);
    if (!j || !j.paused) return;
    // Letting one job go means the queue is no longer wholly held.
    this.allPaused = false;
    j.paused = false;
    this._release(j);
    this._emit();
    // A queued job that was paused has to be picked up again.
    this._pump();
  }

  pauseAll() {
    this.allPaused = true;
    for (const j of this.jobs.values()) {
      if (['queued', 'running'].includes(j.status)) j.paused = true;
    }
    this._emit();
  }

  resumeAll() {
    this.allPaused = false;
    for (const j of this.jobs.values()) {
      if (j.paused) { j.paused = false; this._release(j); }
    }
    this._emit();
    this._pump();
  }

  /**
   * Run a failed or cancelled job again, picking up any partial files.
   *
   * The same job rather than a new one: it already knows its item list, its
   * directories and what it was called, and keeping the row means the history
   * of "this failed, then it worked" stays in one place.
   */
  retry(id) {
    const j = this.jobs.get(id);
    if (!j || !['error', 'cancelled'].includes(j.status)) return;
    j._abort = new AbortController();
    j.status = 'queued';
    j.paused = false;
    j.resume = true;
    j.error = null;
    j.phase = null;
    j.doneBytes = 0;
    j.fileIndex = 0;
    j.currentFile = null;
    j.startedAt = null;
    j.endedAt = null;
    j.rate = 0;
    j._lastBytes = 0;
    this._emit();
    this._pump();
  }

  /**
   * Move a queued job earlier or later. Only among the queued ones: reordering
   * around a job that is already running would say something untrue about what
   * happens next.
   */
  move(id, delta) {
    const at = this.order.indexOf(id);
    if (at < 0) return;
    const j = this.jobs.get(id);
    if (!j || !['queued'].includes(j.status)) return;
    const target = Math.max(0, Math.min(this.order.length - 1, at + (delta < 0 ? -1 : 1)));
    if (target === at) return;
    const other = this.jobs.get(this.order[target]);
    if (other && other.status === 'running') return;
    this.order.splice(at, 1);
    this.order.splice(target, 0, id);
    this._emit();
  }

  clearFinished() {
    for (const [id, j] of [...this.jobs]) {
      if (['done', 'error', 'cancelled'].includes(j.status)) {
        this.jobs.delete(id);
        this.order = this.order.filter((x) => x !== id);
      }
    }
    this._emit();
  }

  view() {
    return this.order
      .map((id) => this.jobs.get(id))
      .filter(Boolean)
      .map((j) => ({
        id: j.id, kind: j.kind, label: j.label,
        // Paused is a state of its own to anything watching, even though the
        // job is still sitting inside its run.
        status: j.paused && ['queued', 'running'].includes(j.status) ? 'paused' : j.status,
        paused: !!j.paused,
        resumed: !!j.resume,
        totalBytes: j.totalBytes, doneBytes: j.doneBytes,
        fileIndex: j.fileIndex, fileCount: j.fileCount,
        currentFile: j.currentFile, phase: j.phase, error: j.error, rate: j.rate,
        startedAt: j.startedAt, endedAt: j.endedAt,
        limit: this.limit,
      }));
  }

  _emit() { this.emit('update', this.view()); }

  async _pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const next = this.order.map((id) => this.jobs.get(id))
          .find((j) => j && j.status === 'queued' && !j.paused);
        if (!next) break;
        await this._run(next);
      }
    } finally {
      this.running = false;
    }
  }

  async _run(job) {
    job.status = 'running';
    job.startedAt = Date.now();
    job._lastTick = Date.now();
    this._emit();

    let timer = setInterval(() => {
      const now = Date.now();
      const dt = (now - job._lastTick) / 1000;
      if (dt > 0.2) {
        job.rate = (job.doneBytes - job._lastBytes) / dt;
        job._lastBytes = job.doneBytes;
        job._lastTick = now;
      }
      this._emit();
    }, 400);

    try {
      // Server-to-server jobs bring their own executor.
      if (job.customRun) {
        await job.customRun({
          onProgress: (done, total) => {
            job.doneBytes = done;
            if (total) job.totalBytes = total;
          },
          setFile: (name, index) => {
            job.currentFile = name;
            if (index) job.fileIndex = index;
          },
          setPhase: (p) => { job.phase = p; this._emit(); },
          signal: job._abort.signal,
          gate: this._gateFor(job),
          throttle: this._throttleFor(),
        });
        job.status = 'done';
        job.phase = null;
        job.doneBytes = job.totalBytes;
        return;
      }

      const sftp = await this.getSftp();
      if (job.kind === 'upload') {
        for (const d of job.dirs) {
          await sftp.mkdir(d).catch(() => {}); // ignore "already exists"
        }
      } else {
        for (const d of job.dirs) await fsx.ensureDir(d).catch(() => {});
      }

      let base = 0;
      for (let i = 0; i < job.items.length; i++) {
        if (job._abort.signal.aborted) throw new Error('cancelled');
        const item = job.items[i];
        job.fileIndex = i + 1;
        job.currentFile = job.kind === 'upload' ? item.local : item.remote;
        this._emit();
        const onProgress = (d) => { job.doneBytes = base + d; };
        // Straight out rather than on the next tick: the point of the phase is
        // to explain a pause, so it has to appear when the pause starts.
        const onPhase = (p) => { job.phase = p; this._emit(); };
        const common = {
          onProgress,
          onPhase,
          signal: job._abort.signal,
          gate: this._gateFor(job),
          throttle: this._throttleFor(),
          resume: job.resume,
        };
        if (job.kind === 'upload') {
          await uploadFile(sftp, item.local, item.remote, common);
        } else {
          await downloadFile(sftp, item.remote, item.local, common);
        }
        base += item.size || 0;
        job.doneBytes = base;
      }
      job.status = 'done';
      job.phase = null;
      job.doneBytes = job.totalBytes;
      // Only a retry resumes; a job that finishes has nothing to pick up.
      job.resume = false;
    } catch (e) {
      job.status = job._abort.signal.aborted ? 'cancelled' : 'error';
      job.error = e.message;
    } finally {
      clearInterval(timer);
      job.endedAt = Date.now();
      // A finished job is announced separately from the progress stream, so
      // whatever wants to keep a record of it does not have to watch every
      // tick and work out which rows have just changed state.
      if (job.status === 'done') {
        this.emit('finished', {
          kind: job.kind,
          label: job.label,
          items: job.items.map((i) => ({ local: i.local, remote: i.remote, size: i.size || 0 })),
          dirs: [...job.dirs],
          roots: [...job.roots],
          bytes: job.totalBytes,
          endedAt: job.endedAt,
        });
      }
      this._emit();
    }
  }
}

module.exports = {
  downloadFile, uploadFile, planUpload, planDownload, TransferQueue, posixJoin, PlanCancelled,
};
