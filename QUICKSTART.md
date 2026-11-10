# Quickstart

Get ServerLife installed and running in a few minutes. For the full install
notes, requirements and troubleshooting, see [README.md](README.md#install).

## 1. Download

Grab the build for your platform from the
[releases page](https://github.com/stevenGravy/serverlife/releases):

| Platform | File |
|---|---|
| macOS (Apple Silicon) | `ServerLife-<version>-macOS-arm64.dmg` |
| Linux x64 | `ServerLife-<version>-linux-x64.AppImage` or `.deb` |
| Linux arm64 | `ServerLife-<version>-linux-arm64.AppImage` or `.deb` |
| Windows x64 | `ServerLife-<version>-windows-x64.exe` |

> [!IMPORTANT]
> **The builds are not signed with a paid developer certificate**, so every
> OS warns about them on first run. This is expected — the warning is about
> the missing signature, not anything found in the app. Each platform's way
> through it is below.

Every release also has a `SHA256SUMS.txt`. Worth checking before you tell
your OS to trust an unsigned binary:

```sh
shasum -a 256 ~/Downloads/ServerLife-*                 # macOS
sha256sum ~/Downloads/ServerLife-*                      # Linux
Get-FileHash .\ServerLife-<version>-windows-x64.exe     # Windows (PowerShell)
```

Compare the result with the matching line in `SHA256SUMS.txt` on the release
page.

## 2. Install

### macOS

The `.dmg` is **ad-hoc signed and not notarised**, so macOS 15+ shows
*"Apple could not verify 'ServerLife' is free of malware…"* with **Move to
Trash** as the default button. Control-click → *Open* no longer works around
this for unnotarised apps — two things do:

**Option 1 — install from the command line** (clears the quarantine flag
before the first launch, so no warning ever appears):

```sh
V=<version>   # the version you downloaded
hdiutil attach ~/Downloads/ServerLife-$V-macOS-arm64.dmg
ditto "/Volumes/ServerLife $V-arm64/ServerLife.app" /Applications/ServerLife.app
hdiutil detach "/Volumes/ServerLife $V-arm64"
xattr -dr com.apple.quarantine /Applications/ServerLife.app
open -a ServerLife
```

Or run `install-mac.sh`, attached to every release, which does the same and
checks the result:

```sh
gh release download --repo stevenGravy/serverlife serverlife-v<version> -p install-mac.sh
chmod +x install-mac.sh
./install-mac.sh ~/Downloads/ServerLife-<version>-macOS-arm64.dmg
```

**Option 2 — let macOS block it once, then allow it:**

1. Open the DMG and drag ServerLife to Applications.
2. Open it. At the warning, press **Done** — *not* Move to Trash.
3. **System Settings → Privacy & Security**, scroll to the line about
   ServerLife, press **Open Anyway**, and confirm.

### Windows

The installer is unsigned, so SmartScreen shows *"Windows protected your
PC"*. Press **More info**, then **Run anyway** — nothing else is needed.

The `.exe` is a per-user installer and needs no administrator rights. The
`.zip` is the same app unpacked, for running without installing.

### Linux

```sh
sudo apt install ./ServerLife-<version>-linux-amd64.deb   # Debian, Ubuntu
```

Or the AppImage, which only needs the execute bit:

```sh
chmod +x ServerLife-<version>-linux-x86_64.AppImage
./ServerLife-<version>-linux-x86_64.AppImage
```

On a minimal system an AppImage may need FUSE (`sudo apt install libfuse2`),
or run it with `--appimage-extract-and-run`.

## 3. First run

0. The first launch offers a guided tour — sixteen steps pointing at each
   part of the window. Find it again later in **Help → Take the Tour…**
1. Log in to Teleport if you use it: `tsh login --proxy=your.proxy.com`
2. Launch ServerLife. The sidebar fills with your Teleport nodes, every
   `Host` in `~/.ssh/config`, and your Kubernetes clusters.
3. Double-click a host — a terminal opens and the file browser attaches to
   the same connection.
4. Drag a file from Finder/Explorer onto the file browser to upload it.

For everything else — features, keyboard shortcuts, building from source,
and the full list of requirements — see [README.md](README.md).
