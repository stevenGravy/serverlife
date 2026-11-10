# Uninstalling ServerLife

Removing the application is one step. Removing everything it wrote is a few
more, and worth knowing about because some of it — saved profiles, macros, S3
credentials — is yours and not recoverable once deleted.

Two things ServerLife never owns, and you should not delete on its account:

- **`~/.ssh/`** — your keys and config. ServerLife reads them, and only writes
  inside a marked block (see [SSH config](#ssh-config-entries)).
- **`~/.tsh/`** (or whatever `TELEPORT_HOME` points at) — Teleport's own
  certificates. Deleting it logs you out of every cluster, in every tool,
  including `tsh` itself.

---

## 1. Remove the application

### macOS

Quit ServerLife first, then:

```sh
rm -rf /Applications/ServerLife.app
```

Or drag it from Applications to the Trash.

### Windows

**Settings → Apps → Installed apps → ServerLife → Uninstall**, or *Add or
remove programs* from the Start menu. That runs the uninstaller the installer
registered.

If you used the portable `.zip` instead, delete the folder you unpacked.

### Linux

Depends on how it was installed:

```sh
sudo apt remove serverlife        # .deb (Debian, Ubuntu)
sudo dpkg -r serverlife           # .deb, without apt
rm ~/Applications/ServerLife*.AppImage   # AppImage: just the file
rm -rf ~/serverlife-linux-x64     # tarball: the folder you unpacked
```

An AppImage may also have left a desktop entry and icon if you let its
integration prompt add one:

```sh
rm -f ~/.local/share/applications/serverlife*.desktop
rm -f ~/.local/share/icons/hicolor/*/apps/serverlife.png
```

---

## 2. Remove your settings and saved data

This is the directory that holds `sessions.json` — saved profiles and folders,
macros, layouts, S3 bucket registrations, saved Teleport clusters, saved access
requests, session history, window state and all preferences.

| Platform | Path |
| --- | --- |
| macOS | `~/Library/Application Support/ServerLife` |
| Windows | `%APPDATA%\ServerLife` |
| Linux | `~/.config/ServerLife` |

```sh
# macOS
rm -rf ~/Library/Application\ Support/ServerLife

# Linux
rm -rf ~/.config/ServerLife
```

```powershell
# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:APPDATA\ServerLife"
```

**Keep this directory** if you are reinstalling, moving to a newer version, or
testing a build — everything you have set up is in it. To keep a copy before
deleting, rename it rather than removing it:

```sh
mv ~/Library/Application\ Support/ServerLife ~/Library/Application\ Support/ServerLife.bak
```

You can also export your settings to a single file from inside the app — Saved →
*Export…* — before uninstalling, which is the portable way to carry them to
another machine.

### What is inside, if you want to be selective

| File | Holds |
| --- | --- |
| `sessions.json` | Everything above. Plain JSON; readable before you delete it |
| `control-token` | The token for [local automation](#local-automation-mcp) |
| `Cache/`, `GPUCache/`, `Local Storage/`, `Code Cache/` | Chromium's own caches. Safe to delete at any time |

---

## 3. Remove the stored secrets

S3 secret keys are the only secrets ServerLife keeps, and they are never written
in the clear: each is encrypted by the OS keystore and the ciphertext lives in
`sessions.json`. Deleting that file makes them unrecoverable, which is usually
all you need.

The key the OS holds is managed by Electron, under the app's name:

- **macOS** — Keychain Access → login keychain → search `ServerLife`. Delete the
  `ServerLife Safe Storage` item if present.
- **Windows** — the ciphertext is protected by DPAPI against your user account;
  there is no separate item to remove.
- **Linux** — your keyring (GNOME Keyring / KWallet) may hold a `ServerLife`
  entry; remove it with Seahorse or `secret-tool`.

Nothing else is stored: ServerLife has no password of its own, and SSH
authentication is always your keys, your agent, or `tsh`.

---

## 4. Runtime files

Sockets, multiplexed SSH control sockets and the generated Teleport
`ssh_config` files live in a per-user directory under the system temp path, and
are recreated on demand:

| Platform | Path |
| --- | --- |
| macOS, Linux | `$TMPDIR/serverlife-<your uid>/`, `$TMPDIR/serverlife-*.sock`, and `$TMPDIR/serverlife-s3-*` scratch directories from bucket transfers |
| Windows | `%TEMP%\serverlife-*`, plus a named pipe that disappears with the app |

```sh
rm -rf "${TMPDIR:-/tmp}"/serverlife-*
```

The operating system clears these on reboot anyway. Delete them only after
quitting the app — a live SSH connection's control socket is in there.

---

## 5. SSH config entries

If you ever used *Add a server*, ServerLife wrote those hosts into
`~/.ssh/config` inside a marked block:

```
# >>> ServerLife managed hosts >>>
# Edited by ServerLife; entries outside these markers are left alone.
Host example
    HostName example.internal
    User ubuntu
# <<< ServerLife managed hosts <<<
```

Delete the block, markers included, to remove them. **Everything outside those
two markers was written by you or another tool** — ServerLife never touches it,
and neither should an uninstall.

Hosts you added this way work with plain `ssh` too, so it is reasonable to keep
them.

---

## 6. Local automation (MCP)

If you turned on *Local automation* in Settings and registered the bridge with
an MCP client, the client keeps its own record. For Claude Code:

```sh
claude mcp remove serverlife
```

The token file goes with the settings directory in step 2, and the socket with
the runtime files in step 4.

---

## 7. Teleport, deliberately left alone

ServerLife runs `tsh`; it does not install or own it. After uninstalling:

- your `tsh` login stays valid — nothing is logged out;
- `~/.tsh` (or your `TELEPORT_HOME` directories) are untouched;
- `tsh` itself, and Teleport Connect if you have it, are unaffected.

To end your Teleport sessions as well, that is `tsh logout` — separate from
uninstalling this app.

---

## Uninstalling completely, in one go

Everything above, for someone who wants none of it left. **This deletes your
saved profiles, macros and S3 registrations.**

```sh
# macOS
osascript -e 'tell application "ServerLife" to quit'
rm -rf /Applications/ServerLife.app
rm -rf ~/Library/Application\ Support/ServerLife
rm -rf "${TMPDIR:-/tmp}"/serverlife-*
claude mcp remove serverlife 2>/dev/null || true
# then remove the "ServerLife Safe Storage" item in Keychain Access
```

```sh
# Linux
sudo apt remove serverlife 2>/dev/null || true
rm -rf ~/.config/ServerLife
rm -rf "${TMPDIR:-/tmp}"/serverlife-*
rm -f ~/.local/share/applications/serverlife*.desktop
claude mcp remove serverlife 2>/dev/null || true
```

```powershell
# Windows (PowerShell) — uninstall from Apps & features first
Remove-Item -Recurse -Force "$env:APPDATA\ServerLife"
Remove-Item -Recurse -Force "$env:TEMP\serverlife-*" -ErrorAction SilentlyContinue
claude mcp remove serverlife
```

Then, if you want them gone, tidy the `~/.ssh/config` block from step 5 by hand.
