'use strict';
/**
 * Multi-exec: run one command across many hosts at once.
 *
 * Each host runs over its own ControlMaster, so a command fans out without
 * re-authenticating anywhere. Results stream back per host as they arrive
 * rather than all at the end, and one slow or dead host never blocks the rest.
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const sshbin = require('./sshbin');

let runSeq = 0;

/**
 * The stages of a staged run: `first` hosts on their own — the canary — then
 * batches of `batch` until every host has had its turn. Sizes only; which
 * hosts go in each is the order they were given in.
 */
function planStages(n, { first = 1, batch = 5 } = {}) {
  const out = [];
  if (n <= 0) return out;
  const f = Math.max(1, Math.min(n, Math.floor(Number(first)) || 1));
  const b = Math.max(1, Math.floor(Number(batch)) || 5);
  out.push(f);
  for (let left = n - f; left > 0; left -= b) out.push(Math.min(b, left));
  return out;
}

class MultiExecRun extends EventEmitter {
  constructor(id, targets, command, opts = {}) {
    super();
    this.id = id;
    this.command = command;
    this.concurrency = Math.max(1, opts.concurrency || 8);
    this.timeout = opts.timeout || 120000;
    this.stopOnError = !!opts.stopOnError;
    /*
     * Retries: a host that fails is tried again, up to `retries` more times,
     * `retryDelay` seconds apart — for the blip, the lock held a moment too
     * long, the service still coming up. Only its last try counts: a stage,
     * "stop on error" and the totals all see how it ended.
     */
    this.retries = Math.max(0, Math.min(10, Math.floor(Number(opts.retries)) || 0));
    this.retryDelay = Math.max(0, Math.min(3600, Number(opts.retryDelay ?? 10)));
    this._wakers = new Set();
    /*
     * Staged: run on a few hosts first and look before going wider. Between
     * stages the run waits for a decision — the next stage, the rest at once,
     * or stop — and a stage with a failure stops it there unless told to go
     * on. `stages` is null for an ordinary run, which goes everywhere at once.
     */
    this.stages = opts.stages ? {
      first: opts.stages.first, batch: opts.stages.batch,
      pause: opts.stages.pause !== false, stopOnFail: opts.stages.stopOnFail !== false,
    } : null;
    this.stageSizes = [];
    this.stageIndex = 0;
    this.paused = null;            // { reason: 'review'|'failed', failed, ok } while waiting
    this._decide = null;
    this.cancelled = false;
    this.startedAt = Date.now();
    this.endedAt = null;
    this.procs = new Map();

    this.results = new Map();
    for (const t of targets) {
      this.results.set(t.connId, {
        connId: t.connId,
        label: t.label,
        status: 'pending',      // pending|running|prompting|retrying|done|error|timeout|cancelled
        exitCode: null,
        stdout: '',
        stderr: '',
        startedAt: null,
        endedAt: null,
        durationMs: null,
        stage: null,
        attempt: 0,
        attempts: 1 + this.retries,
        tries: [],              // earlier tries: { status, exitCode, durationMs, error }
        retryAt: null,
        promptText: null,       // set while status is 'prompting' — see _spawnInteractive
        _execId: null,          // the interactive exec this host's prompt (if any) answers to
      });
    }
    this.targets = targets;
  }

  view() {
    return {
      id: this.id,
      command: this.command,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      running: this.endedAt === null,
      retries: this.retries,
      retryDelay: this.retryDelay,
      staged: this.stages ? {
        sizes: this.stageSizes, index: this.stageIndex, pause: this.stages.pause,
        stopOnFail: this.stages.stopOnFail, paused: this.paused,
      } : null,
      results: [...this.results.values()].map((r) => ({ ...r })),
    };
  }

  _emit() { this.emit('update', this.view()); }

  async start() {
    if (this.stages) await this._staged();
    else await this._runAll(this.targets);
    this.endedAt = Date.now();
    this.paused = null;
    this._emit();
    this.emit('done', this.view());
  }

  async _staged() {
    this.stageSizes = planStages(this.targets.length, this.stages);
    let at = 0;
    for (let i = 0; i < this.stageSizes.length; i++) {
      if (this.cancelled) return;
      this.stageIndex = i;
      const group = this.targets.slice(at, at + this.stageSizes[i]);
      at += this.stageSizes[i];
      for (const t of group) { const r = this.results.get(t.connId); if (r) r.stage = i + 1; }
      await this._runAll(group);
      if (this.cancelled || i === this.stageSizes.length - 1) return;
      const rs = group.map((t) => this.results.get(t.connId));
      const failed = rs.filter((r) => r && r.status !== 'done').length;
      const ok = rs.length - failed;
      const stop = failed && this.stages.stopOnFail;
      if (!stop && !this.stages.pause) continue;
      this.paused = { reason: stop ? 'failed' : 'review', failed, ok };
      this._emit();
      const choice = await new Promise((resolve) => { this._decide = resolve; });
      this._decide = null;
      this.paused = null;
      if (choice === 'stop') { this.cancel(); return; }
      // The rest at once: no more pauses, and a failure no longer stops it —
      // that is what was asked for.
      if (choice === 'all') this.stages = { ...this.stages, pause: false, stopOnFail: false };
      this._emit();
    }
  }

  /** Answer a paused staged run: 'next', 'all' or 'stop'. */
  decide(choice) {
    if (this._decide) this._decide(choice);
  }

  async _runAll(list) {
    const queue = [...list];
    const workers = [];
    const runNext = async () => {
      for (;;) {
        if (this.cancelled) return;
        const t = queue.shift();
        if (!t) return;
        await this._runWithRetries(t);
        if (this.stopOnError) {
          const r = this.results.get(t.connId);
          if (r && r.status !== 'done') { this.cancel(); return; }
        }
      }
    };
    for (let i = 0; i < Math.min(this.concurrency, list.length); i++) workers.push(runNext());
    await Promise.all(workers);
  }

  /** Run on one host, and again while it fails and tries are left. */
  async _runWithRetries(target) {
    const rec = this.results.get(target.connId);
    if (!rec) return;
    for (let attempt = 1; attempt <= 1 + this.retries; attempt++) {
      if (this.cancelled) return;
      rec.attempt = attempt;
      await this._runOne(target);
      if (rec.status === 'done' || rec.status === 'cancelled' || this.cancelled) return;
      if (attempt > this.retries) return;
      // What this try said is kept; the next one starts with a clean slate.
      rec.tries.push({
        status: rec.status, exitCode: rec.exitCode, durationMs: rec.durationMs,
        error: (rec.stderr || '').trim().split('\n').slice(-3).join('\n').slice(0, 400),
      });
      rec.status = 'retrying';
      rec.retryAt = Date.now() + this.retryDelay * 1000;
      this._emit();
      await this._sleep(this.retryDelay * 1000);
      rec.retryAt = null;
    }
  }

  /** A wait that a cancel cuts short. */
  _sleep(ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this._wakers.delete(done); resolve(); };
      const timer = setTimeout(done, ms);
      this._wakers.add(done);
    });
  }

  async _runOne(target) {
    const rec = this.results.get(target.connId);
    if (!rec || this.cancelled) return;
    /*
     * A host whose connection is down — it never came up, or it dropped —
     * is dialled again first: with retries on, a host that failed to connect
     * is the most worth trying again.
     */
    if (target.conn && target.conn.state !== 'connected') {
      rec.status = 'running';
      rec.startedAt = Date.now();
      rec.stdout = ''; rec.stderr = ''; rec.exitCode = null;
      this._emit();
      try { await target.conn.connect(); } catch { /* reported below */ }
      if (target.conn.state !== 'connected') {
        rec.status = 'error';
        rec.stderr = target.conn.error || 'not connected';
        rec.endedAt = Date.now();
        rec.durationMs = rec.endedAt - rec.startedAt;
        this._emit();
        return;
      }
    }
    return this._spawnOne(target);
  }

  _spawnOne(target) {
    if (target.transport === 'tsh') return this._spawnInteractive(target);
    return new Promise((resolve) => {
      const rec = this.results.get(target.connId);
      if (!rec || this.cancelled) return resolve();
      rec.status = 'running';
      rec.startedAt = Date.now();
      rec.stdout = ''; rec.stderr = ''; rec.exitCode = null;
      rec.endedAt = null; rec.durationMs = null;
      this._emit();

      // `-T` keeps ssh from allocating a TTY, so stdout/stderr stay separate
      // and the remote command sees a clean non-interactive environment.
      const args = target.sshArgs(['-T', target.target, this.command]);
      const p = spawn(sshbin.findSsh(), args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: target.procEnv ? target.procEnv() : undefined,
      });
      this.procs.set(target.connId, p);

      let killedBy = null;
      const timer = setTimeout(() => { killedBy = 'timeout'; p.kill('SIGKILL'); }, this.timeout);

      const cap = (field) => (d) => {
        rec[field] += d.toString();
        if (rec[field].length > 400000) rec[field] = rec[field].slice(-400000);
        this._emit();
      };
      p.stdout.on('data', cap('stdout'));
      p.stderr.on('data', cap('stderr'));

      p.on('error', (e) => {
        rec.stderr += e.message;
      });

      p.on('close', (code) => {
        clearTimeout(timer);
        this.procs.delete(target.connId);
        rec.exitCode = code;
        rec.endedAt = Date.now();
        rec.durationMs = rec.endedAt - rec.startedAt;
        if (killedBy === 'timeout') rec.status = 'timeout';
        else if (this.cancelled) rec.status = 'cancelled';
        else rec.status = code === 0 ? 'done' : 'error';
        this._emit();
        resolve();
      });
    });
  }

  /**
   * The tsh-transport branch: per-session MFA, a leaf cluster, or no
   * OpenSSH client on this machine — none of which the plain, non-interactive
   * `spawn()` above can get through, since a prompt has no pty to appear on
   * or be answered from. Runs through the real `Connection`'s own
   * `execInteractive` in-process — this file already holds `target.conn`,
   * no IPC needed — which is exactly the pty-backed path the interactive
   * master already uses for MFA. `answer()` below routes a typed response
   * in from the dock's per-host prompt.
   */
  async _spawnInteractive(target) {
    const rec = this.results.get(target.connId);
    if (!rec || this.cancelled) return;
    rec.status = 'running';
    rec.startedAt = Date.now();
    rec.stdout = ''; rec.stderr = ''; rec.exitCode = null;
    rec.endedAt = null; rec.durationMs = null;
    rec.promptText = null;
    this._emit();

    const execId = 'mx' + target.connId;
    rec._execId = execId;
    const onData = ({ execId: id, data }) => {
      if (id !== execId) return;
      rec.stdout += data;
      if (rec.stdout.length > 400000) rec.stdout = rec.stdout.slice(-400000);
      this._emit();
    };
    const onPrompt = ({ execId: id, text }) => {
      if (id !== execId) return;
      rec.status = 'prompting';
      rec.promptText = text.trim().slice(-200);
      this._emit();
    };
    target.conn.on('exec-data', onData);
    target.conn.on('exec-prompt', onPrompt);
    try {
      const r = await target.conn.execInteractive(this.command, { execId, timeout: this.timeout });
      rec.exitCode = r.exitCode;
      rec.endedAt = Date.now();
      rec.durationMs = rec.endedAt - rec.startedAt;
      if (this.cancelled) rec.status = 'cancelled';
      else if (r.exitCode === null) rec.status = 'timeout';
      else {
        rec.status = r.exitCode === 0 ? 'done' : 'error';
        if (r.error) rec.stderr += r.error;
      }
    } finally {
      target.conn.off('exec-data', onData);
      target.conn.off('exec-prompt', onPrompt);
      rec._execId = null;
      this._emit();
    }
  }

  /** Answer a prompt on one host mid-run — the MFA code or tap it is waiting on. */
  answer(connId, data) {
    const rec = this.results.get(connId);
    const t = this.targets.find((x) => x.connId === connId);
    if (rec?._execId && t) t.conn.writeExec(rec._execId, data);
  }

  cancel() {
    this.cancelled = true;
    for (const [, p] of this.procs) { try { p.kill('SIGKILL'); } catch { /* the process may already have exited */ } }
    for (const r of this.results.values()) {
      // A still-waiting interactive exec is not something a kill() on
      // `this.procs` reaches — that map only ever held the plain-spawn path.
      if (r._execId) {
        const t = this.targets.find((x) => x.connId === r.connId);
        if (t) t.conn.killExec(r._execId);
      }
      if (['pending', 'running', 'retrying', 'prompting'].includes(r.status)) r.status = 'cancelled';
    }
    for (const wake of [...this._wakers]) wake();
    // A paused run waiting for a decision has been given one.
    if (this._decide) this._decide('stop');
    this._emit();
  }
}

class MultiExec extends EventEmitter {
  constructor(manager) {
    super();
    this.manager = manager;
    this.runs = new Map();
  }

  /**
   * @param connIds ids of already-created connections
   * @param command the shell command to run on each
   */
  async run(connIds, command, opts = {}) {
    const targets = [];
    for (const id of connIds) {
      const conn = this.manager.get(id);
      if (!conn) continue;
      // Ensure the master is up before fanning out; connecting in parallel is
      // fine because each connection has its own control socket.
      targets.push({
        connId: id,
        label: conn.label,
        target: conn.target,
        /*
         * Without `transport` copied here, `_spawnOne`'s `target.transport
         * === 'tsh'` check always compared `undefined === 'tsh'` — false —
         * so multi-exec against any tsh-transport host (per-session MFA, a
         * leaf cluster, or no OpenSSH client at all) silently fell through
         * to the plain-ssh branch and dialled with a bare, config-less
         * `ssh`, which cannot reach a Teleport node. Not an MFA-specific
         * bug: multi-exec was non-functional for those hosts regardless.
         */
        transport: conn.transport,
        sshArgs: (extra) => conn.sshArgs(extra),
        tshArgs: (extra, command) => conn.tshArgs(extra, command),
        conn,
      });
    }

    await Promise.all(targets.map((t) => t.conn.connect().catch(() => {})));
    const live = targets.filter((t) => t.conn.state === 'connected');
    const dead = targets.filter((t) => t.conn.state !== 'connected');

    const runId = 'run' + (++runSeq);
    const run = new MultiExecRun(runId, targets, command, opts);
    // With retries, a host that did not connect is tried again like any other
    // failure; without, it is reported now and left out.
    if (!run.retries) {
      for (const d of dead) {
        const r = run.results.get(d.connId);
        r.status = 'error';
        r.stderr = d.conn.error || 'not connected';
        r.endedAt = Date.now();
      }
      run.targets = live;
    }

    this.runs.set(runId, run);
    run.on('update', (v) => this.emit('update', v));
    run.on('done', (v) => this.emit('done', v));
    run.start();
    return run.view();
  }

  cancel(runId) {
    const r = this.runs.get(runId);
    if (r) r.cancel();
  }

  /** Go on with a paused staged run: 'next' stage, 'all' the rest, or 'stop'. */
  decide(runId, choice) {
    const r = this.runs.get(runId);
    if (r) r.decide(choice);
  }

  /** Answer a prompt on one host of a run — the MFA code or tap it is waiting on. */
  answer(runId, connId, data) {
    const r = this.runs.get(runId);
    if (r) r.answer(connId, data);
  }

  get(runId) {
    const r = this.runs.get(runId);
    return r ? r.view() : null;
  }

  list() { return [...this.runs.values()].map((r) => r.view()); }

  clear() {
    for (const [id, r] of [...this.runs]) if (r.endedAt) this.runs.delete(id);
  }
}

module.exports = { MultiExec, MultiExecRun, planStages };
