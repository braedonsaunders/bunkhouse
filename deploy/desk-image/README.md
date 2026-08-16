# Desk golden image + in-guest agent

Everything that runs **inside** a per-agent microVM: the golden disk image the
desks boot from, and the guest agent that answers the host over vsock. The
**host** side (Cloud Hypervisor, the desk-runner container) lives elsewhere and
is not built here — see `apps/web/scripts/desk-runner.mts` and
`docs/agent-desk.md` for the whole design.

## What's here

```
deploy/desk-image/
├── build-golden-image.sh          # builds base.raw + vmlinux
├── agent/
│   ├── desk-guest-agent.mjs       # the in-guest agent (Node ESM, node built-ins only)
│   ├── package.json               # marks /opt/desk-agent as ESM inside the image
│   ├── desk-guest-agent.service   # systemd: run the agent as root on a UNIX socket
│   ├── desk-vsock-bridge.service  # systemd: socat vsock:5252 -> that UNIX socket
│   └── appkit-desk/               # vendored, dependency-free @appkit/desk protocol core
│       ├── guest-agent.js         #   runGuestAgent() — binds the pure core to a stream
│       ├── protocol.js            #   framed-JSON encode/decode/validate
│       └── events.js              #   (type-only; kept so the tree is self-contained)
```

The `appkit-desk/` copies come from `apps/web/node_modules/@appkit/desk/`. They
are committed so the image tree is self-contained: the build copies this whole
`agent/` directory to `/opt/desk-agent/` in the guest, and it must run there
without an npm install.

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
~123–138s; do not quote bare-metal figures (spec §4, §8).

## Where the outputs go — `BUNKHOUSE_AGENT_DISKS`

Point the runner's `BUNKHOUSE_AGENT_DISKS` at the output directory (the "disks
root"). The runner expects:

```
<disks root>/
├── base.raw        # the golden image (RAW — see below)
├── vmlinux         # guest kernel for Cloud Hypervisor direct-kernel boot
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
 runGuestAgent({ stream, handlers })   ← the vendored @appkit/desk core
```

The agent is a plain UNIX-socket server; socat owns all the vsock specifics, so
the security-critical code stays a small framed-JSON handler (spec §5.1, §8). It
runs as **root** because it execs arbitrary agent commands on the agent's
behalf. Both units are enabled at build time and start at `multi-user.target`.

## What the agent implements

Real, on node built-ins only:

- `exec` — `execFile` with the caller's cwd/env, a hard `timeoutMs` (SIGKILL on
  timeout), each of stdout/stderr capped at 1 MiB; spawn failures report exit
  127/126 with the message in stderr.
- `job-start` / `job-signal` — detached background processes tracked by UUID;
  a `job-exit` guest event is pushed to the host when a job exits.
- `capabilities` — `{ virtioGpu: false }` (headless base image).

## The screen tier is stubbed (pending Phase 5)

`screenStart`, `screenStop`, `observe`, `input`, `a11yInvoke`, `launch`,
`clipboardRead`, `clipboardWrite`, `framesStart`, `framesStop`, `handoverBegin`,
and `handoverEnd` all throw **"desktop tier is not enabled in this base image"**.
The protocol core turns a handler throw into a clean error response, so the host
surfaces a tidy failure instead of a hang. Phase 5 (spec §7) replaces these
stubs with real wlroots/AT-SPI implementations in a screen-tier image that bakes
in the compositor. The XFCE/Chromium/LibreOffice packages are already installed
in `base.raw`; only the in-guest driver is deferred.
