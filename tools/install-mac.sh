#!/bin/sh
# Install a downloaded ServerLife DMG on macOS.
#
# The releases are ad-hoc signed and not notarised under an Apple Developer
# account, and a file downloaded by a browser arrives with a quarantine flag.
# On macOS 15 and later that combination gives you "Apple could not verify
# ServerLife is free of malware", with Move to Trash as the default button —
# and the old Control-click → Open escape hatch is gone.
#
# This copies the app out of the image and clears the quarantine flag before
# the first launch, which is the same decision as Privacy & Security → "Open
# Anyway", made from the command line.
#
# It is worth understanding what you are doing: you are choosing to run a
# binary macOS could not verify. Do it for builds you produced, or downloaded
# from your own releases and checked against SHA256SUMS.txt.
#
#   ./tools/install-mac.sh ~/Downloads/ServerLife-0.1.14-macOS-arm64.dmg
#
set -eu

DMG="${1:-}"
DEST="${2:-/Applications}"

if [ -z "$DMG" ] || [ ! -f "$DMG" ]; then
  echo "usage: $0 <path-to-dmg> [install-dir]" >&2
  exit 64
fi

echo "==> Mounting $(basename "$DMG")"
MOUNT=$(hdiutil attach "$DMG" -nobrowse -readonly | sed -n 's|.*\(/Volumes/.*\)$|\1|p' | tail -1)
if [ -z "${MOUNT:-}" ]; then
  echo "Could not mount the image." >&2
  exit 1
fi
cleanup() { hdiutil detach "$MOUNT" -quiet 2>/dev/null || true; }
trap cleanup EXIT

APP=$(find "$MOUNT" -maxdepth 1 -name '*.app' | head -1)
if [ -z "$APP" ]; then
  echo "No .app inside the image." >&2
  exit 1
fi
NAME=$(basename "$APP")

# A running copy would keep its old bundle alive and behave oddly afterwards.
if pgrep -f "$DEST/$NAME/Contents/MacOS/" >/dev/null 2>&1; then
  echo "==> Quitting the running ${NAME%.app}"
  osascript -e "tell application \"${NAME%.app}\" to quit" 2>/dev/null || true
  sleep 3
fi

echo "==> Copying to $DEST/$NAME"
rm -rf "$DEST/$NAME"
# ditto rather than cp: it preserves the bundle's symlinks, permissions and
# extended attributes, and a mangled bundle fails to launch for reasons that
# look nothing like the real cause.
ditto "$APP" "$DEST/$NAME"

echo "==> Clearing the quarantine flag"
xattr -dr com.apple.quarantine "$DEST/$NAME" 2>/dev/null || true

echo "==> Checking the signature"
if codesign --verify --deep --strict "$DEST/$NAME" 2>/dev/null; then
  # Ad-hoc builds report "Signature=adhoc"; a certificate-signed one names its
  # authority instead. Report whichever is there rather than an empty pair of
  # brackets.
  WHO=$(codesign -dv "$DEST/$NAME" 2>&1 | sed -n 's/^Signature=//p')
  [ -n "$WHO" ] || WHO=$(codesign -dvv "$DEST/$NAME" 2>&1 | sed -n 's/^Authority=//p' | head -1)
  echo "    signature intact${WHO:+ ($WHO)}"
else
  echo "    WARNING: signature did not verify — the copy may be damaged." >&2
fi

VERSION=$(defaults read "$DEST/$NAME/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo unknown)
LEFT=$(xattr -p com.apple.quarantine "$DEST/$NAME" 2>/dev/null || true)
echo
echo "Installed ${NAME%.app} $VERSION in $DEST"
[ -n "$LEFT" ] && echo "note: a quarantine flag is still set ($LEFT)" || echo "No quarantine flag — it will open without a Gatekeeper prompt."
