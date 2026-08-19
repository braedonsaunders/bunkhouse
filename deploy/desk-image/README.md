# Desk golden image + in-guest agent

Everything that runs **inside** a per-agent microVM: the golden disk image the
desks boot from, and the guest agent that answers the host over vsock. The
**host** side (Cloud Hypervisor, the desk-runner container) lives in
`apps/web/scripts/desk-runner.mts` and `deploy/desk-runner.compose.yaml`.

## What's here

```
deploy/desk-image/
├── build-golden-image.sh          # builds base.raw + vmlinux + initrd
├── agent/
│   ├── desk-guest-agent.mjs       # the in-guest agent (Node ESM, node built-ins only)
│   ├── atspi-dump.py              # the agent's one subprocess helper: AT-SPI tree -> JSON
│   ├── desk-guest-agent.test.mjs  # self-test; runs anywhere, needs no X server
│   ├── package.json               # marks /opt/desk-agent as ESM inside the image
│   ├── desk-guest-agent.service   # systemd: run the agent as root on a UNIX socket
│   ├── desk-vsock-bridge.service  # systemd: socat vsock:5252 -> that UNIX socket
```

The build stages the dependency-free protocol core from the installed
`apps/web/node_modules/@braedonsaunders/appkit-desk/` package into `/opt/desk-agent/appkit-desk/`.
Run `pnpm install` before building the image; no package source is copied into this repo.

## Building

Runs on a **Linux** host with hardware virtualization and the libguestfs
toolchain:

```sh
sudo apt-get install libguestfs-tools qemu-utils cloud-image-utils
deploy/desk-image/build-golden-image.sh
```

Outputs land in `deploy/desk-image/out/` by default (override with `OUT_DIR=`).
Every step is idempotent — re-running skips the fetch, resize, and kernel
extraction if their outputs already exist; delete an output to force a rebuild.
Cold-boot latency for an L2 nested desk off this image was measured at
~123–138s; do not quote bare-metal figures for a nested deployment.

## Where the outputs go — `BUNKHOUSE_AGENT_DISKS`

Point the runner's `BUNKHOUSE_AGENT_DISKS` at the output directory (the "disks
root"). The runner expects:

```
<disks root>/
├── base.raw        # the golden image (RAW — see below)
├── vmlinux         # guest kernel for Cloud Hypervisor direct-kernel boot
├── initrd          # matching initramfs for the modular Debian kernel
└── overlays/       # per-desk CoW overlays, created by the runner (not the build)
```

**Why RAW, not qcow2.** Each desk runs on a copy-on-write overlay that is a
reflink (`cp --reflink`) of `base.raw`. Reflinks need a RAW source on a
reflink-capable filesystem (XFS/Btrfs), and Cloud Hypervisor cannot follow a
qcow2 backing chain. The build resizes the Debian cloud image into `base.raw`
with `virt-resize --expand`, which grows the root filesystem (resizing the raw
container alone would leave the fs full) and, on this layout, moves the root
onto **partition 3**.

**Kernel cmdline the runner must use:**

```
console=ttyS0 root=/dev/vda3 rw
```

## Architecture: vsock → socat → guest agent

```
 host (desk-runner via Cloud Hypervisor)
        │  vsock, port 5252
        │  framed JSON: 4-byte big-endian length prefix + UTF-8 JSON body
        ▼
 desk-vsock-bridge.service
   socat VSOCK-LISTEN:5252,fork -> UNIX-CONNECT:/run/desk-guest-agent.sock
        │
        ▼
 desk-guest-agent.service
   node /opt/desk-agent/desk-guest-agent.mjs  (root; UNIX socket server)
        │
        ▼
 runGuestAgent({ stream, handlers })   ← the staged @braedonsaunders/appkit-desk core
```

The agent is a plain UNIX-socket server; socat owns all the vsock specifics, so
the security-critical code stays a small framed-JSON handler. It
runs as **root** because it execs arbitrary agent commands on the agent's
behalf. Both units are enabled at build time and start at `multi-user.target`.

## What the agent implements

Real, on node built-ins only (plus the one Python helper, run as a subprocess):

### Machine tier

- `exec` — `execFile` with the caller's cwd/env, a hard `timeoutMs` (SIGKILL on
  timeout), each of stdout/stderr capped at 1 MiB; spawn failures report exit
  127/126 with the message in stderr.
- `job-start` / `job-signal` — detached background processes tracked by UUID;
  a `job-exit` guest event is pushed to the host when a job exits.
- `capabilities` — `{ virtioGpu }`, true only when a `/dev/dri/card*` node is
  backed by a driver named `virtio*`; anything unconfirmed reports false.

### Desktop tier (Phase 5/6)

**Xvfb `:99` + XFCE, X11 all the way down.** `screen-start` brings up
`Xvfb :99 -screen 0 <w>x<h>x24` at exactly the requested size, polls `xdpyinfo`
until the display genuinely answers (and fails loudly with Xvfb's own stderr if
it does not), then starts a session bus with `dbus-launch`, the AT-SPI bus
launcher, and `xfce4-session`. If no window manager has taken the root after a
bounded wait, it starts `xfwm4` and `xfsettingsd` directly rather than leaving a
desk with no titlebars or focus. A second `screen-start` while a screen is up is
a no-op; `screen-stop` tears the session down (SIGTERM, then SIGKILL after a
grace) and is idempotent.

XFCE is a conventional desktop that computer-use models drive
familiar desktops measurably better than tiling compositors. XFCE 4.18 is
X11-native, so there is **no Wayland compositor and no XWayland** in this path:
XWayland exists to run X11 clients *under Wayland*, the reverse of this stack.

**Perception is pixels-primary with opportunistic AT-SPI.** `observe`
always returns a real, unscaled PNG of `:99` (`import -window root`), the EWMH
window list (`wmctrl -lp`, with each window's `appId` read from
`/proc/<pid>/comm`), and the focused window (`xdotool getactivewindow`, falling
back to `getwindowfocus`). It *additionally* asks `atspi-dump.py` for the
focused window's accessibility tree — and if python3, pyatspi, the bus, or the
application does not cooperate, it returns `a11y: null` **and still returns the
pixels**. Accessibility never gates seeing. Window enumeration is treated the
same way: a failure there is logged and yields an empty list, not a failed
observation.

The tree is anchored to the **pid** of the X-focused window, not to "whatever
AT-SPI calls active": xfwm4 registers a 5×5 off-screen proxy window that reports
`STATE_ACTIVE`, and dumping that is technically correct and completely useless.
The helper ranks candidate windows (matching pid first, then active, then
showing) and ignores degenerate ones.

A11y node ids are structural paths (`"0/3/1"` = second child of the fourth child
of the root). They are stable *within one observation only* — `a11y-invoke`
re-walks the tree from the application the last `observe` described, so observe
immediately before invoking. Every walk is bounded three ways: depth 12, 2000
nodes, and a wall-clock budget; exceeding a bound truncates the tree rather than
failing it.

**The coordinate contract is identity.** Input coordinates are in the
pixel space of the most recent `observe()`, one to one, because nothing in the
chain scales: Xvfb runs at exactly the requested size, `import` captures that
framebuffer unscaled, `observe` reports the dimensions read out of the captured
PNG's own header, and `xdotool` addresses the same root window. There is no
scaling step in the agent and none may be added; input outside the screen is
rejected with an explicit message so a breach is loud rather than a click that
lands slightly off. `move`, `click`, `type`, `key`, `scroll` (X11 wheel buttons
4/5/6/7, one click per 40px of delta) and `drag` (press, eight interpolated
moves, release — released even if a move fails) all go through `xdotool` with
argument arrays; nothing from the wire ever reaches a shell.

One trap is worth knowing about, because it is invisible until it bites:
**`xdotool mousemove --sync` never returns when the pointer is already at the
target**. It waits for the pointer to move *away* from where it was, and moving
twice to the same place is completely ordinary for an agent (observe, move,
look, click) — measured in a real XFCE session, that call hangs until the
agent's timeout kills it and looks exactly like a dead desk. The agent therefore
never uses `--sync`; ordering is guaranteed instead by chaining the move and the
click into one `xdotool` invocation, i.e. one X connection, whose requests the
server processes in order.

**Frames are damage-skipped.** `frames-start` captures at the requested
fps and hashes each PNG (SHA-256); an identical consecutive frame is *not*
emitted, so a still screen costs one hash per tick and no transport. A keepalive
re-emits every 5s so a subscriber who joined during a still period is never left
blank. The loop is single-flight — the next tick is scheduled only after the
current capture finishes — so a slow capture or consumer cannot pile up work.
Frames carry the screen's real dimensions; a differing requested size is logged
and ignored rather than rescaled.

**Handover is localhost-only with a guest-side TTL.**
`handover-begin` starts `x11vnc` bound to `127.0.0.1:5900` (`-localhost -nopw
-forever -shared`, plus `-viewonly` when the scope is `view`), waits until the
port actually accepts, and returns `vnc://127.0.0.1:5900` — the **runner** owns
exposing it outward. A guest-side timer kills x11vnc when `ttlMs` elapses even
if `handover-end` never arrives; `handover-end` is idempotent, and stopping the
screen stops the handover and the frame loop too.

The **masking rules are enforced host-side** by `@braedonsaunders/appkit-desk`, which drops
input events, frames, window focus and clipboard reads while a handover is
active. The guest deliberately does not re-implement that — and deliberately
keeps *no record of handover input at all*: x11vnc injects through XTEST without
passing through the agent, so there is no path by which a person's keystrokes
could reach the ledger from this side.

### Binaries the desktop tier requires

`Xvfb`, `xdpyinfo`, `xprop` (x11-utils), `dbus-launch` (dbus-x11),
`xfce4-session`, `xfwm4`, `xfsettingsd` (xfce4-settings), `at-spi-bus-launcher`
(at-spi2-core), `import` (imagemagick), `wmctrl`, `xdotool`, `xclip`, `x11vnc`,
and `python3` with `python3-pyatspi`. All are declared in
`apps/web/src/lib/base-image.ts` (the single source of truth for image contents)
and re-asserted by the build script.

## Testing the agent

```sh
node deploy/desk-image/agent/desk-guest-agent.test.mjs
```

Runs anywhere — macOS included — with **no X server**. It starts the agent on a
temp socket with an empty `PATH`, checks the machine tier still works, and
asserts that every desktop handler fails fast with a readable message (and that
`screen-start` reports why Xvfb never came up) instead of hanging the host.
