/**
 * This machine, shaped like a connection — for tmux and nothing else.
 *
 * The tmux layer asks three things of whatever it runs over: run a command and
 * report what it printed (`execResult`), start one with a terminal in front
 * of it (`spawnCommandPty`), and say what kind of link it is (`transport`).
 * Answering those for the local machine is all it takes for every tmux
 * feature — attach, the session list, splits, windows, reattaching after a
 * restart — to work on this laptop exactly as on a server, with no second
 * implementation to keep in step.
 *
 * Not on Windows: tmux has no native build there, and a session inside WSL is
 * a server in all but name, reached as one.
 */

const os = require('os');
const { execFile } = require('child_process');
const pty = require('node-pty');

const LOCAL_ID = 'local';
const SUPPORTED = process.platform !== 'win32';

/*
 * The environment a tmux command should see. Homebrew's bin directories are
 * added because an app started from the Dock gets launchd's PATH, which has
 * neither; TMUX is removed because a ServerLife launched from inside tmux
 * would otherwise make every `tmux new-session` refuse to nest.
 */
function localEnv(extra = {}) {
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    PATH: (process.env.PATH || '') + ':/usr/local/bin:/opt/homebrew/bin',
    ...extra,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

class LocalHost {
  constructor() {
    this.id = LOCAL_ID;
    this.transport = 'local';
    this.label = 'this machine';
    this.homeDir = os.homedir();
  }

  execResult(command, opts = {}) {
    return new Promise((resolve) => {
      if (!SUPPORTED) {
        resolve({ stdout: '', stderr: 'tmux is not available on Windows', error: new Error('unsupported') });
        return;
      }
      execFile('/bin/sh', ['-c', command], {
        timeout: opts.timeout || 20000, maxBuffer: 8 * 1024 * 1024, env: localEnv(), cwd: this.homeDir,
      }, (err, stdout, stderr) => resolve({
        stdout: String(stdout || ''), stderr: String(stderr || ''), error: err || null,
      }));
    });
  }

  exec(command, opts = {}) {
    return this.execResult(command, opts).then(({ stdout, stderr, error }) => {
      if (error) throw new Error(stderr.trim() || error.message);
      return stdout;
    });
  }

  spawnCommandPty({ command, cols = 100, rows = 30 }) {
    if (!SUPPORTED) throw new Error('tmux is not available on Windows');
    if (!command) throw new Error('no command given');
    return pty.spawn('/bin/sh', ['-c', command], {
      name: 'xterm-256color', cols, rows, cwd: this.homeDir, env: localEnv(),
    });
  }
}

module.exports = { LOCAL_ID, SUPPORTED, LocalHost, localEnv };
