#!/usr/bin/env bash
#
# build-golden-image.sh — build the Bunkhouse desk golden image.
#
# WHAT THIS PRODUCES (both at the "disks root", the directory this script writes
# into — point BUNKHOUSE_AGENT_DISKS at it):
#   - base.raw   a RAW Debian 12 image, root grown to 20G, with the XFCE desktop
#                set, Chromium, LibreOffice, git, the desktop tier's drivers
#                (Xvfb, xdotool, wmctrl, ImageMagick, ffmpeg, xclip, x11vnc,
#                AT-SPI), PLUS node + socat + the desk guest agent baked in and
#                enabled.
#   - vmlinux    the guest kernel extracted from that image, for Cloud
#                Hypervisor direct-kernel boot.
#   - initrd     the matching initramfs (the modular cloud kernel needs it).
#
# WHY RAW, NOT QCOW2: each desk runs on a copy-on-write overlay that is a
# reflink (`cp --reflink`) of base.raw. Reflinks require a RAW source on a
# reflink-capable filesystem (XFS/Btrfs); Cloud Hypervisor cannot follow a
# qcow2 backing chain, so the base MUST be raw. The overlays live under
# <disks root>/overlays/ and are created by the runner, not here.
#
# CRITICAL — the resize. Expanding the raw *container* alone leaves the
# filesystem full: the partition and fs must be grown too. `virt-resize
# --expand` does that, and on this image layout it also reorders the root onto
# partition 3 — hence the runner boots with root=/dev/vda3 (see the summary at
# the end).
#
# PERFORMANCE: measured L2 nested (VM-in-VM) cold-boot latency for a desk off
# this image is ~123-138s. Do not quote bare-metal figures (spec §4, §8). node,
# socat, and the guest agent are baked in so a desk needs no network install to
# answer over vsock.
#
# REQUIREMENTS (Linux build host): kvm, libguestfs-tools, qemu-utils,
# cloud-image-utils. Every step is idempotent and logged; re-running skips work
# that is already done.

set -euo pipefail

# --- locations --------------------------------------------------------------

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
AGENT_SRC_DIR="${SCRIPT_DIR}/agent"
BASE_IMAGE_TS="${REPO_ROOT}/apps/web/src/lib/base-image.ts"

# Where the outputs land. Override with OUT_DIR=... ; this is the "disks root".
OUT_DIR="${OUT_DIR:-${SCRIPT_DIR}/out}"

DEBIAN_URL="https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2"
CLOUD_QCOW2="${OUT_DIR}/debian-12-genericcloud-amd64.qcow2"
BASE_RAW="${OUT_DIR}/base.raw"
VMLINUX="${OUT_DIR}/vmlinux"
INITRD="${OUT_DIR}/initrd"
ROOT_SIZE="${ROOT_SIZE:-20G}"

# virt-* tools run more reliably without the appliance's own KVM layer here.
export LIBGUESTFS_BACKEND=direct

log() { printf '[build-golden-image] %s\n' "$*"; }
die() { printf '[build-golden-image] ERROR: %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1 (install libguestfs-tools / qemu-utils / cloud-image-utils)"
}

# --- preflight --------------------------------------------------------------

for cmd in qemu-img virt-resize virt-customize virt-get-kernel curl; do
  require_cmd "$cmd"
done

[ -f "${BASE_IMAGE_TS}" ] || die "cannot find base-image.ts at ${BASE_IMAGE_TS}"
[ -f "${AGENT_SRC_DIR}/desk-guest-agent.mjs" ] || die "cannot find the guest agent at ${AGENT_SRC_DIR}"
[ -f "${AGENT_SRC_DIR}/atspi-dump.py" ] || die "cannot find atspi-dump.py at ${AGENT_SRC_DIR}"

mkdir -p "${OUT_DIR}"

# --- the apt package set ----------------------------------------------------
#
# Read the desktop set straight out of base-image.ts so this build never drifts
# from the declared manifest: every `aptPackage: '...'` there is a Debian
# package the golden image must contain (spec §3.16 — that file is the single
# source of truth for image contents).
#
# On top of it the build adds what only the build knows about:
#
#   nodejs socat   the guest agent itself and the vsock bridge it sits behind.
#
# ...and it INSISTS on the desktop tier's driver set. Every one of these is a
# binary deploy/desk-image/agent/desk-guest-agent.mjs shells out to when a
# screen is open; a golden image missing any of them produces a desk whose
# screen fails one handler at a time, at runtime, in a microVM. They are all
# declared in base-image.ts, and are repeated here so an accidental deletion
# there is caught at build time rather than in production.
#
#   xvfb            the headless X server the session runs on (:99)
#   x11-utils       xdpyinfo / xprop — display-ready and window-manager probes
#   xdotool         all input injection, and the focused-window query
#   wmctrl          the EWMH window list behind observe().windows
#   imagemagick     `import` — the unscaled root-window PNG capture for observe()
#   ffmpeg          x11grab — the long-lived capture behind the live frame stream
#   xclip           clipboard read/write
#   x11vnc          the handover server, bound to guest localhost only
#   at-spi2-core    the accessibility bus (opportunistic perception, §3.10)
#   python3-pyatspi the binding atspi-dump.py uses to read that tree
#   dbus-x11        dbus-launch — the session bus XFCE and AT-SPI both need
#   xfce4-settings  xfsettingsd, started directly if xfce4-session did not

mapfile -t DESKTOP_PACKAGES < <(grep -oE "aptPackage: '[^']+'" "${BASE_IMAGE_TS}" | sed -E "s/aptPackage: '([^']+)'/\1/" | sort -u)
[ "${#DESKTOP_PACKAGES[@]}" -gt 0 ] || die "found no aptPackage entries in ${BASE_IMAGE_TS}"

DESKTOP_TIER_PACKAGES=(
  xvfb
  x11-utils
  xdotool
  wmctrl
  imagemagick
  ffmpeg
  xclip
  x11vnc
  at-spi2-core
  python3-pyatspi
  dbus-x11
  xfce4-settings
)

for pkg in "${DESKTOP_TIER_PACKAGES[@]}"; do
  found=no
  for declared in "${DESKTOP_PACKAGES[@]}"; do
    [ "${declared}" = "${pkg}" ] && found=yes && break
  done
  [ "${found}" = yes ] || log "WARNING: ${pkg} is not declared in base-image.ts; installing it anyway (declare it, §3.16)"
done

mapfile -t APT_PACKAGES < <(printf '%s\n' "${DESKTOP_PACKAGES[@]}" "${DESKTOP_TIER_PACKAGES[@]}" nodejs socat | sort -u)
log "apt packages: ${APT_PACKAGES[*]}"

# --- step 1: fetch the Debian cloud image -----------------------------------

if [ -f "${CLOUD_QCOW2}" ]; then
  log "step 1: debian cloud image already present, skipping fetch"
else
  log "step 1: fetching ${DEBIAN_URL}"
  curl -fSL --retry 3 -o "${CLOUD_QCOW2}.part" "${DEBIAN_URL}"
  mv "${CLOUD_QCOW2}.part" "${CLOUD_QCOW2}"
fi

# --- step 2: resize into a RAW disk -----------------------------------------
#
# Grow to a fresh RAW disk and expand the root filesystem into it. virt-resize
# reads the qcow2 source and writes the raw target directly. Root ends up on
# partition 3 on this layout.

if [ -f "${BASE_RAW}" ]; then
  log "step 2: ${BASE_RAW} already exists, skipping resize (delete it to rebuild)"
else
  log "step 2: creating ${ROOT_SIZE} RAW disk and expanding the root fs into it"
  qemu-img create -f raw "${BASE_RAW}.part" "${ROOT_SIZE}"
  # --expand /dev/sda1: grow the original root partition; virt-resize lays the
  # result out with root on partition 3 (see the boot cmdline in the summary).
  virt-resize --expand /dev/sda1 "${CLOUD_QCOW2}" "${BASE_RAW}.part"
  mv "${BASE_RAW}.part" "${BASE_RAW}"
fi

# --- step 3: customize the image --------------------------------------------
#
# Stage the guest agent tree so it lands at exactly /opt/desk-agent, then in one
# virt-customize invocation: install packages, copy the agent in, install and
# enable both systemd units, create the agent user, and pin the boot target to
# multi-user.
#
# multi-user stays deliberate now that the desktop tier is implemented: a desk
# boots headless and cheap (§3.2, §3.15), and the X session only exists once the
# agent's screenStart brings up Xvfb and xfce4-session on demand. Nothing here
# starts a display manager.

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "${STAGE_DIR}"' EXIT
mkdir -p "${STAGE_DIR}/desk-agent"
# The agent + its vendored @appkit/desk modules + the package.json that marks
# /opt/desk-agent as ESM (there is no parent package.json inside the guest).
cp "${AGENT_SRC_DIR}/desk-guest-agent.mjs" "${STAGE_DIR}/desk-agent/"
cp "${AGENT_SRC_DIR}/package.json" "${STAGE_DIR}/desk-agent/"
cp -R "${AGENT_SRC_DIR}/appkit-desk" "${STAGE_DIR}/desk-agent/"
# The AT-SPI reader the agent shells out to for opportunistic accessibility
# (§3.10). It must land beside the agent: the agent resolves it relative to its
# own path, so /opt/desk-agent/atspi-dump.py is the contract.
cp "${AGENT_SRC_DIR}/atspi-dump.py" "${STAGE_DIR}/desk-agent/"
chmod 0755 "${STAGE_DIR}/desk-agent/atspi-dump.py"

log "step 3: customizing ${BASE_RAW}"
virt-customize -a "${BASE_RAW}" \
  --run-command 'apt-get update' \
  --install "$(IFS=,; echo "${APT_PACKAGES[*]}")" \
  --run-command 'mkdir -p /opt' \
  --copy-in "${STAGE_DIR}/desk-agent:/opt" \
  --copy-in "${AGENT_SRC_DIR}/desk-guest-agent.service:/etc/systemd/system" \
  --copy-in "${AGENT_SRC_DIR}/desk-vsock-bridge.service:/etc/systemd/system" \
  --run-command 'id -u agent >/dev/null 2>&1 || useradd -m -s /bin/bash agent' \
  --run-command 'systemctl enable desk-guest-agent.service desk-vsock-bridge.service' \
  --run-command 'systemctl set-default multi-user.target' \
  --run-command 'apt-get clean'

# --- step 4: extract the kernel and initramfs -------------------------------
#
# Cloud Hypervisor does a direct-kernel boot, so it needs the raw vmlinux out of
# the image, not the disk's own bootloader. The Debian cloud kernel is modular:
# it loads virtio_blk from the initramfs, and boots to a "VFS: Unable to mount
# root fs" panic without one — so we stage the initrd beside it. virt-get-kernel
# emits both files in one pass.

if [ -f "${VMLINUX}" ] && [ -f "${INITRD}" ]; then
  log "step 4: ${VMLINUX} and ${INITRD} already exist, skipping (delete them to refresh)"
else
  log "step 4: extracting the guest kernel and initramfs"
  KTMP="$(mktemp -d)"
  virt-get-kernel -a "${BASE_RAW}" -o "${KTMP}"
  KERNEL_FILE="$(find "${KTMP}" -name 'vmlinuz-*' -type f | sort | tail -n1)"
  [ -n "${KERNEL_FILE}" ] || die "virt-get-kernel produced no vmlinuz-* file"
  cp "${KERNEL_FILE}" "${VMLINUX}.part"
  mv "${VMLINUX}.part" "${VMLINUX}"
  INITRD_FILE="$(find "${KTMP}" -name 'initramfs-*' -o -name 'initrd.img-*' | sort | tail -n1)"
  [ -n "${INITRD_FILE}" ] || die "virt-get-kernel produced no initramfs file"
  cp "${INITRD_FILE}" "${INITRD}.part"
  mv "${INITRD}.part" "${INITRD}"
  rm -rf "${KTMP}"
fi

# --- step 5: summary --------------------------------------------------------

BASE_SIZE="$(du -h "${BASE_RAW}" | cut -f1)"
VMLINUX_SIZE="$(du -h "${VMLINUX}" | cut -f1)"
INITRD_SIZE="$(du -h "${INITRD}" | cut -f1)"

cat <<SUMMARY

[build-golden-image] DONE.

  disks root : ${OUT_DIR}
  base.raw   : ${BASE_RAW}  (${BASE_SIZE}, RAW — overlays are reflink copies of this)
  vmlinux    : ${VMLINUX}  (${VMLINUX_SIZE})
  initrd     : ${INITRD}  (${INITRD_SIZE}, modular virtio needs it or the guest panics)

  Point the runner at this directory:
    BUNKHOUSE_AGENT_DISKS=${OUT_DIR}

  Kernel cmdline the runner must boot with (root moved to partition 3 by
  virt-resize):

    console=ttyS0 root=/dev/vda3 rw

  Baked in: node + socat + the desk guest agent (enabled units
  desk-guest-agent.service and desk-vsock-bridge.service). The desk answers the
  host over vsock port 5252 on first boot with no network install.

  Desktop tier: /opt/desk-agent/atspi-dump.py ships beside the agent, and the
  session's binaries (Xvfb, xdotool, wmctrl, import, ffmpeg, xclip, x11vnc,
  dbus-launch, xfsettingsd) are installed. The desk still boots to multi-user;
  the screen starts only when the host asks for one.
SUMMARY
