#!/usr/bin/env bash
# Wait for the cluster, install Linux dependencies, log tsh in, run the suite.
set -euo pipefail
cd /app

for _ in $(seq 120); do
  [ -f /shared/ready ] && break
  sleep 1
done
[ -f /shared/ready ] || { echo "runner: the cluster never became ready" >&2; exit 1; }

# The plain-OpenSSH target, reached by alias the way an ssh_config host is.
mkdir -p ~/.ssh && chmod 700 ~/.ssh
cat > ~/.ssh/config <<'EOF'
Host opensshnode
    HostName node
    User tester
    IdentityFile /shared/id_ed25519
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
    UserKnownHostsFile ~/.ssh/known_hosts_it
EOF

# node-pty is the one native module the tested code needs; built here for
# this Node, not Electron. Electron itself is never downloaded.
npm ci --no-audit --no-fund --loglevel=error

# From a scratch directory, not /app: /app is the developer's own checkout,
# and anything that writes to its working directory (tsh 17's remote-to-remote
# scp did) must not land in it.
mkdir -p /tmp/it-cwd && cd /tmp/it-cwd
node /app/tests/integration/login.mjs
exec node --test --test-concurrency=1 --test-timeout=300000 /app/tests/integration/*.test.mjs
