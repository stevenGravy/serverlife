#!/usr/bin/env bash
# Fresh credentials for every run: a CA the proxy's certificate chains to (so
# tsh trusts it without --insecure, which ServerLife never passes), and the
# key the runner uses for the plain-OpenSSH target.
set -euo pipefail
cd /shared
# The volume can outlive a run; a stale "ready" marker would let the runner
# start before this run's cluster is up.
find /shared -mindepth 1 -delete

openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 -subj /CN=serverlife-it-ca 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout proxy.key -out proxy.csr -subj /CN=proxy 2>/dev/null
printf 'subjectAltName=DNS:proxy\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' > ext.cnf
openssl x509 -req -in proxy.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out proxy.crt -days 2 -extfile ext.cnf 2>/dev/null
cat proxy.crt ca.crt > proxy-chain.crt

ssh-keygen -q -t ed25519 -N '' -C serverlife-it -f id_ed25519
chmod 644 ./*.crt ./*.key id_ed25519.pub
chmod 600 id_ed25519
echo "setup: certificates and keys written"
