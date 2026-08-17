# The desk-runner image — the app image, plus the one thing it deliberately lacks.
#
# The bunkhouse app image (root Dockerfile) ships NO virtual machine monitor:
# chromium, libreoffice and the rest of the agent-facing tooling moved into the
# guest base image, and cloud-hypervisor/qemu-img were never added, because the
# containers that hold the provider keys, the session secret and the database
# must not also be able to boot a microVM (docs/agent-desk.md §3.5, §6.3).
#
# The desk-runner is the sole exception: it is the only container that maps
# /dev/kvm and whose entire job is to spawn per-agent microVMs. So rather than
# fatten the app image for every service, this image layers just the VMM tooling
# on top of it — same app code, plus the hypervisor, in the one place that needs
# it.
#
# @appkit/desk's plan.ts looks for its tools at fixed paths (DEFAULT_VMM_PATH /
# DEFAULT_QEMU_IMG_PATH): cloud-hypervisor at /usr/bin/cloud-hypervisor and
# qemu-img at /usr/bin/qemu-img. This image puts them exactly there.

ARG BUNKHOUSE_TAG=latest
FROM ghcr.io/braedonsaunders/bunkhouse:${BUNKHOUSE_TAG}

# qemu-img (from qemu-utils) is how the runner materialises each desk's raw
# overlay; the reflink copy of the raw base itself is a plain `cp`, already in
# coreutils. Nothing else from the qemu suite is wanted here — keep it minimal.
#
# iproute2 and iptables are the other half of a desk: the runner creates each
# guest's TAP with `ip` and puts the transparent-egress rules in front of it
# with `iptables` (docs/agent-desk.md §3.11). They are useless without the
# NET_ADMIN this container is granted in deploy/desk-runner.compose.yaml, and
# the runner refuses to serve any desk at all if either is missing — an
# unfiltered desk is a root shell with an open route out.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    qemu-utils \
    iproute2 \
    iptables \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/*

# Cloud Hypervisor v53.0 — pinned. The published `cloud-hypervisor-static` is a
# self-contained x86_64 binary, so no extra runtime libraries are needed.
ARG CLOUD_HYPERVISOR_VERSION=v53.0
RUN curl -fsSL \
    "https://github.com/cloud-hypervisor/cloud-hypervisor/releases/download/${CLOUD_HYPERVISOR_VERSION}/cloud-hypervisor-static" \
    -o /usr/bin/cloud-hypervisor \
  && chmod +x /usr/bin/cloud-hypervisor

# Identical to how the desk-runner service runs in deploy/desk-runner.compose.yaml:
# tsx runs the runner script under the react-server condition.
CMD ["sh", "-c", "NODE_OPTIONS=--conditions=react-server exec apps/web/node_modules/.bin/tsx apps/web/scripts/desk-runner.mts"]
