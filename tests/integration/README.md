# Integration tests

ServerLife's main-process modules — `connections.js`, `sftp.js`, `transfers.js`,
`syncdirs.js`, `tmuxctl.js`, `crosstransfer.js` and `teleport.js` — run
against a real OpenSSH server and a real Teleport cluster in Docker. Nothing
is mocked; the modules are loaded from `src/main` the way the app loads them.

```sh
make test-integration                           # newest Teleport release
make test-integration TELEPORT_VERSION=17.7.30  # any other
make test-integration TELEPORT_VERSION=17.7.30 TELEPORT_CLIENT_VERSION=18.11.3
                                                # a v18 tsh against a v17 cluster
tests/integration/teleport-versions.sh          # what the release tests against
```

Needs Docker. Takes a few minutes, most of it the first `npm ci` and image
build. The stack is removed afterwards, pass or fail.

## What runs

| Service  | What it is |
| --- | --- |
| `setup`  | A throwaway CA, the proxy's certificate, an SSH key — fresh each run |
| `proxy`  | Teleport auth + proxy, cluster `sltest`, user `ci` with role `serverlife-ci` |
| `node`   | `node1`: sshd on 22 **and** a Teleport agent, both landing as `tester` |
| `runner` | Node 22, `ssh`, and `tsh` at the version under test; logs in, runs the suite |

Images are built from the Teleport CDN tarball. The cluster and node use
`TELEPORT_VERSION`; the runner's tsh is `TELEPORT_CLIENT_VERSION`, which
defaults to the same version.

- **`targets.test.mjs`** runs every test twice — once as the ssh_config alias
  `opensshnode`, once as the Teleport node — so a difference between the two
  paths is a failure with the path's name on it: connecting, exec, a terminal,
  upload/download with mtimes, synchronise, removing a non-empty folder, tmux
  detach and reattach.
- **`teleport.test.mjs`** is the tsh side: client and cluster versions (and
  that ServerLife's verdict on them agrees with tsh's own login warning),
  `tsh status`, `tsh ls` labels and heartbeat, clusters, `tsh config`, live
  sessions, recordings and their transcripts, `tsh scp`, and server-to-server
  copies (direct over tsh, and by relay from the OpenSSH host).
- **`password.test.mjs`** reaches `pwtester@node` — an account with no key,
  only a password — the way Quick connect reaches a typed-in address. The
  prompt is answered on the connection's terminal as a person would, exec and
  files then work with no second prompt, a wrong password fails with an error
  rather than a hang, and the password is nowhere afterwards: not in the log,
  not in a file under the temp folder, `~/.ssh` or `~/.config`, and not
  remembered — the next connection asks again.

## How the cluster is made usable unattended

- **No `--insecure`.** ServerLife never passes it, so the proxy has a real
  certificate from the run's CA and every process trusts it through
  `SSL_CERT_FILE`.
- **No second factor.** `second_factor: "off"` is refused by Teleport unless
  the auth service runs with `TELEPORT_ALLOW_NO_SECOND_FACTOR=true`. That is set
  on the `proxy` container only; never copy it to a real cluster.
- **A real login.** The password is set through the user's reset link (the
  web API a person's browser would call), and `tsh login` is answered through
  a pty in `login.mjs`. tsh will not read a password from a pipe. The result is
  an ordinary `~/.tsh` profile, which is what ServerLife reads on a laptop, not
  an identity file it never sees in practice.

## In the release

`.github/workflows/serverlife-release.yml` runs this before the release is
created, for the two newest Teleport majors — each against its own tsh, and
both mismatches (a tsh one major ahead of the cluster, and one behind). A
failure in any of the four stops the release. *Run workflow* takes a
`teleport_version` to test one version, matched, instead.

The runner works from a scratch directory, not the mounted checkout, so a
tool that writes to its working directory cannot leave files in your tree.

## Found so far

- **tsh 17 "copied" server-to-server onto the laptop.** Remote-to-remote
  `tsh scp` exits 0 on tsh 17 having read the destination as a local path:
  the files went into a folder named `tester@node1:` in the working directory
  and never reached the destination, while ServerLife reported the copy done.
  The direct route now needs tsh 18; older ones relay.
- **Version mismatches were silent.** tsh warns about an unsupported client
  only during login, and ServerLife's in-app login discarded that output. A
  tsh two majors ahead (18 on a 16 cluster) cannot log in at all, failing
  with `ssh: no key found`. ServerLife now works out the verdict itself
  (`teleport.compatibility`), shows it after login, and adds it to a failed
  Teleport connection.
- **tmux on plain OpenSSH hosts: blank sessions, and none listed to
  reattach.** Without a UTF-8 locale, tmux replaces tabs in `-F` output with
  `_`, and every format `tmuxctl.js` reads is tab-separated. A new session had
  no panes, and `list-sessions` returned nothing on a host that had sessions.
  Fixed by running both with `-u`.
- **Teleport's SFTP removes a non-empty folder whole** (18.11.3), where
  OpenSSH refuses. Not a ServerLife bug: synchronise already checks a folder is
  empty before removing it. The suite reports both servers' behaviour on every
  run, and fails if OpenSSH ever stops refusing.
