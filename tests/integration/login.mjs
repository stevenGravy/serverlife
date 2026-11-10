/**
 * `tsh login` as the CI user, answered through a pty.
 *
 * tsh will not read a password from a pipe ("cannot perform password login
 * without a terminal"), so it gets the same kind of terminal ServerLife gives
 * its own ssh masters: node-pty. The result is an ordinary profile in
 * ~/.tsh — what every module under test reads on a real laptop — rather than
 * an identity file the app never sees in practice.
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require_ = createRequire(import.meta.url);
const pty = require_('node-pty');

const proxy = process.env.IT_PROXY || 'proxy:3080';
const password = process.env.CI_PASSWORD || 'serverlife-it-password';
const LOGIN_OUTPUT = '/tmp/tsh-login.out';

const term = pty.spawn('tsh', ['login', `--proxy=${proxy}`, '--user=ci', '--auth=local'], {
  name: 'xterm-256color', cols: 120, rows: 30, env: process.env,
});

let out = '';
let answered = false;
term.onData((d) => {
  out += d;
  if (!answered && /password/i.test(out)) {
    answered = true;
    term.write(password + '\r');
  }
});

const timer = setTimeout(() => {
  process.stderr.write(`tsh login timed out:\n${out}\n`);
  term.kill();
  process.exit(1);
}, 60000);

term.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (exitCode !== 0) {
    process.stderr.write(`tsh login exited ${exitCode}:\n${out}\n`);
    process.exit(1);
  }
  process.stdout.write(`tsh login: logged in to ${proxy} as ci\n`);
  // Kept for teleport.test.mjs, which checks ServerLife's version verdict
  // against whether tsh itself warned.
  writeFileSync(LOGIN_OUTPUT, out);
  if (process.env.IT_LOGIN_VERBOSE) process.stdout.write(out + '\n');
});
