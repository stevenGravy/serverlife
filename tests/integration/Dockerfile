# One image for every role in the integration stack: the Teleport auth and
# proxy, the node (OpenSSH and a Teleport agent side by side), and the runner
# that drives ServerLife's main-process modules against both.
#
# Teleport comes from the CDN tarball rather than the published container
# image. The image registry rate-limits anonymous pulls hard enough to fail a
# release, and the tarball also puts tsh, tctl and teleport at exactly the
# version under test on every role — the client is part of what is tested.
FROM node:22-bookworm

ARG TELEPORT_VERSION
RUN test -n "$TELEPORT_VERSION" || { echo "TELEPORT_VERSION is required" >&2; exit 1; }

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server openssh-client tmux ca-certificates curl openssl \
 && rm -rf /var/lib/apt/lists/*

RUN arch=$(dpkg --print-architecture) \
 && curl -fsSL "https://cdn.teleport.dev/teleport-v${TELEPORT_VERSION}-linux-${arch}-bin.tar.gz" | tar -xz -C /tmp \
 && cp /tmp/teleport/teleport /tmp/teleport/tctl /tmp/teleport/tsh /usr/local/bin/ \
 && rm -rf /tmp/teleport \
 && tsh version --client

ENV TELEPORT_VERSION=${TELEPORT_VERSION}
