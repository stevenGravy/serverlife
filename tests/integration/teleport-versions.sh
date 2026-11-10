#!/usr/bin/env bash
# The latest stable patch on each of Teleport's two newest majors, newest
# first, one per line — e.g.
#
#   18.11.3
#   17.7.30
#
# The same rule as rev-tech's teleport-api-scripts release (two newest majors,
# rolls forward on its own when a new major ships), read from Teleport's apt
# repository rather than GitHub: GitHub releases lag what Teleport actually
# ships by months (v18.10.0 there when 18.11.3 was out), and the integration
# image installs from the same CDN this repository indexes.
#
#   COUNT=1 teleport-versions.sh     only the newest
set -euo pipefail

count=${COUNT:-2}
repo=https://apt.releases.teleport.dev/ubuntu/dists/noble/stable

latest_in() {
  curl -fsS "$repo/v$1/binary-amd64/Packages" 2>/dev/null \
    | awk '/^Package: teleport$/ { p = 1; next } /^Package:/ { p = 0 } p && /^Version:/ { print $2 }' \
    | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V | tail -1
}

# Walk up from a major known to exist until two in a row are missing, so a
# skipped number never ends the search early.
found=()
miss=0
for ((major = 15; miss < 2 && major < 100; major++)); do
  v=$(latest_in "$major" || true)
  if [[ -n "$v" ]]; then found+=("$v"); miss=0; else miss=$((miss + 1)); fi
done

if ((${#found[@]} == 0)); then
  echo "teleport-versions: no Teleport versions found at $repo" >&2
  exit 1
fi

printf '%s\n' "${found[@]}" | sort -V -r | head -n "$count"
