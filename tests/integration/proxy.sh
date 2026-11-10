#!/usr/bin/env bash
# Auth and proxy, then the CI user: a role, a user, and a password set through
# the same reset link a person would follow — so the runner's `tsh login` makes
# an ordinary profile, the kind ServerLife reads on a laptop.
set -euo pipefail

teleport start -c /it/teleport-proxy.yaml &
pid=$!

for _ in $(seq 60); do
  tctl status >/dev/null 2>&1 && break
  sleep 1
done
tctl status >/dev/null

tctl create -f /it/ci-user.yaml

link=$(tctl users reset ci | grep -oE 'https://[^ ]+')
token=${link##*/}
token=${token%%\?*}
password=$(printf '%s' "${CI_PASSWORD:-serverlife-it-password}" | base64 -w0)
# v17 wants the CSRF token a browser would carry: the `__Host-grv_csrf` cookie
# the reset page sets, echoed back in a header. v18 no longer asks, and does
# not mind it. curl writes an HttpOnly cookie on a line starting `#HttpOnly_`,
# so this reads by field rather than skipping lines that look like comments.
jar=$(mktemp)
curl -fsS --cacert /shared/ca.crt -c "$jar" -o /dev/null "https://proxy:3080/web/reset/$token"
csrf=$(awk -F'\t' '$6 == "__Host-grv_csrf" { print $7 }' "$jar")
curl -fsS --cacert /shared/ca.crt -b "$jar" -X PUT https://proxy:3080/v1/webapi/users/password/token \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $csrf" \
  -d "{\"token\":\"$token\",\"password\":\"$password\"}" >/dev/null
rm -f "$jar"

touch /shared/ready
echo "proxy: cluster up, user ci ready"
wait "$pid"
