#!/usr/bin/env bash
# One machine, two ways in: sshd on 22 for the plain-OpenSSH tests, and a
# Teleport agent dialling out through the proxy for the cluster tests. Both
# land as the same account, so the two suites are comparable line for line.
set -euo pipefail

useradd -m -s /bin/bash tester
install -d -m 700 -o tester -g tester /home/tester/.ssh
install -m 600 -o tester -g tester /shared/id_ed25519.pub /home/tester/.ssh/authorized_keys

# A second account that has no key at all — only a password — for the
# password test. sshd lets it, and only it, sign in that way.
useradd -m -s /bin/bash pwtester
echo "pwtester:${IT_SSH_PASSWORD:-it-only-Pa55word}" | chpasswd
cat >> /etc/ssh/sshd_config <<'EOF2'

Match User pwtester
    PasswordAuthentication yes
    KbdInteractiveAuthentication no
    PubkeyAuthentication no
EOF2

mkdir -p /run/sshd
/usr/sbin/sshd

exec teleport start -c /it/teleport-node.yaml
