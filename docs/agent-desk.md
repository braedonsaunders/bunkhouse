# The agent desk: build specification

**Status:** design settled, not started. **Branch:** `claude/agent-computer-use-capability-gb9ewj`.

This document is a handoff. It is written for an engineer (or another Claude session) with
no prior context on the conversation that produced it. It contains the full design, the
decisions behind it, what to build, in what order, and what to leave alone.

Read §3 (Settled decisions) before proposing anything. Those decisions were each argued and
chosen deliberately. Several of them look wrong at first glance and are explained here
precisely so they are not relitigated. If you believe one is genuinely mistaken, raise it
with the operator rather than quietly building the other thing.

---

## 1. What this replaces, and why

Bunkhouse today gives an agent three separate execution surfaces:

| Surface | Where it runs | File |
| --- | --- | --- |
| `run_shell` | bubblewrap sandbox, in a separate `shell-runner` container | `apps/web/src/lib/shell-sandbox.ts` |
| `run_tool` | bubblewrap, via `@appkit/agent-tools` | `apps/web/src/lib/tools.ts` |
| `browser_*` | headless Chromium via puppeteer, in the `web`/`worker` container | `apps/web/src/lib/browser-use.ts` |
| `run_script` | QuickJS WASM, in-process | `apps/web/src/lib/workspace.ts` |

The confinement is good. `@appkit/process-sandbox` is a careful piece of work — namespaces,
capability dropping, `prlimit` ceilings the child cannot raise, fail-closed on unsupported
hosts, `verifyProcessSandbox()` at boot. Nothing here is a criticism of it.

The problem is what the agent can *reach*. It has no persistent browser identity (a fresh
puppeteer profile every run, so no logins survive), no way to keep a process running past a
command, no downloads (`Browser.setDownloadBehavior: 'deny'`), no GUI, and no path between
the browser and the shell — the browser cannot put a file where the shell can process it.

The goal is a general-purpose Linux machine per agent: terminal, arbitrary software,
a real desktop when needed, persistent across runs, that starts fast enough to feel
always-on and costs little enough to run at company headcount.

### Known-good things being preserved

- **Doctrine #9** (`AGENTS.md`): gated abilities produce replayable session records in the
  observatory. The ledger gets *more* important here, not less — see §3.19.
- **Doctrine #4**: autonomy is a dial per agent × action category, enforced in the runtime,
  never in prompts.
- **Immutable history**: ledgers are append-only with the `reject_immutable_ledger_change()`
  trigger (see `migrations/0047_immutable_ledgers.sql`).
- **Strict tenant isolation**: RLS-enforced, never query discipline alone.
- **Fail-closed capability detection**: `browserSupported()` / `shellSupported()` withhold
  the abilities entirely rather than offering broken ones. The desk follows this exactly.

---

## 2. The architecture in one page

Each agent gets **one Debian machine** in a Cloud Hypervisor microVM.

It boots **headless** — kernel, filesystem, terminal, network, roughly 200-400MB. All agent
execution happens there: `run_shell`, tools, the browser. The desktop environment is
installed in the base image but **is not running**.

When an agent hits work that genuinely needs a screen, it calls `open_desktop` with a stated
reason. The compositor and DE start *on the machine it is already using*. One filesystem,
one identity, one ledger.

```
Hyper-V host (Windows, full admin access)
│
├── Dokploy VM (existing)                    ── web, worker, voice-agent, postgres, redis
│                                               NO nested virt, NO agent execution
│
└── Desk host VM (new, dedicated)            ── nested virt ON, static RAM
    │
    ├── desk-runner container (/dev/kvm)
    │   ├── Cloud Hypervisor ── agent A microVM ── headless by default
    │   │                        └── screen (XFCE) started on demand
    │   ├── Cloud Hypervisor ── agent B microVM
    │   └── egress-proxy      ── all guest traffic DNAT'd here
    │
    └── /data/agent-disks     ── golden base image + per-agent CoW overlays
        /data/shared          ── company shared folder (virtio-fs)
```

**Three cost tiers**, cheapest first. The agent is expected to stay as low as it can:

| Tier | What it is | Cost |
| --- | --- | --- |
| 0 | Existing abilities — `create_document`, `create_spreadsheet`, `web_search`, `read_webpage`, `run_script`, mail, memory | Ordinary model calls |
| 1 | The headless machine — shell, filesystem, tools, browser with a persistent profile | Ordinary model calls + a small resident VM |
| 2 | The screen — GUI apps, desktop automation | A vision call per step where no accessibility tree is available |

Tier 0 already exists and is *better at its job* than tier 2 would be. An agent that drives
LibreOffice through a GUI to build a spreadsheet is doing badly; `create_spreadsheet` exists,
produces a genuine XLSX, and cannot break the formatting. The escalation gate in §3.17 is
what keeps agents honest about this.

---

## 3. Settled decisions

Each is numbered for reference. **Do not reopen these without talking to the operator.**

### 3.1 The microVM replaces bubblewrap for all agent execution — hard cutover

The desk has a terminal. If `run_shell` kept executing in the bwrap sandbox while the
desk's terminal ran in the VM, the agent would have **two shells over two different
filesystems** — write a file in one, cannot see it in the other. Agents hit this constantly
and it reads as the product being broken.

Hard cutover was chosen over a phased dual path: the desk becomes the only agent execution
surface. Deployments without KVM lose shell and computer use entirely, exactly as they lose
them today without bubblewrap or Chromium installed.

`@appkit/process-sandbox` stays in AppKit for trusted non-agent workers. Bunkhouse's agent
path stops depending on it.

### 3.2 One VM per agent; the screen is a service started on demand

Not two machines, not a separate desktop VM. The compositor and DE are installed in the base
image and started inside the already-running guest. This is what keeps §3.1's single
filesystem intact while making the expensive tier optional.

### 3.3 Per-agent desks, plus one shared company folder

Grok Bot gives each *account* one computer shared by all its bots — shared files, cookies and
logins — and its own documentation states the per-bot screens are "separate work surfaces,
not separate security boundaries." That sharing is what security researchers are pointing at:
a bot that reads a hostile page can be steered toward any other authenticated session on the
machine.

Bunkhouse keeps a real boundary per employee. Cross-agent handoff goes through the files
ledger and `delegate_to_colleague`, which audit, plus one explicitly governed shared folder
(§3.11). Do not collapse desks into a per-tenant machine to make handoffs easier.

### 3.4 Persistence: disk first, memory snapshot later and only if measured

Disk persists — home, browser profile, installed packages, dotfiles. The desk cold-boots on
resume and applications restart.

Memory snapshot (restore into the exact moment: half-typed form, open document) is deferred.
It requires UFFD demand paging to be fast and sparse, plus post-restore network reconnection
and clock correction. Build disk persistence, measure how often a cold boot actually costs
an agent anything, then decide.

### 3.5 Desk host: a dedicated Hyper-V VM, not the Dokploy VM

Enabling nested virtualisation requires powering the L1 VM off and disabling Dynamic Memory
(static RAM only). Doing that to the VM that holds provider keys, the session secret and the
database is the wrong trade — and it is the same trade `deploy/shell-runner.compose.yaml`
already argues against in its own header comment:

> The obvious fix — grant all three to web, worker and voice-agent — is the wrong trade.
> Those are the containers that execute model-directed code and drive a browser across the
> open web […] Removing the outer confinement from the most exposed containers in order to
> enable an inner sandbox is backwards.

### 3.6 Cloud Hypervisor, not Firecracker

Both are Rust, KVM-based, fast-booting. Firecracker was built for serverless functions and
**deliberately has no virtio-gpu**. For a graphical desktop that means software rendering
(llvmpipe) for everything.

Cloud Hypervisor has the richer device model including virtio-gpu. Given the whole point is
a real desktop running real software, the device model is the deciding factor. Firecracker's
more mature snapshot/UFFD tooling would have mattered if §3.4 had gone the other way; it did
not.

### 3.7 Golden base image + per-agent copy-on-write overlay

One maintained base; each agent gets a CoW overlay holding `/home` and anything it installs.
Patch the base once and every desk inherits it on next boot. Per-agent disk cost is only the
delta. Agent installs persist.

Rejected: full per-agent images (gigabytes each, no central patching) and ephemeral overlays
(an agent's `apt install` evaporating overnight contradicts "it can do anything").

### 3.8 Debian stable as the guest base

Matches the existing image lineage (`Dockerfile` is `node:24-bookworm-slim`), predictable
security cadence, large set of packaged desktop software that does not move underneath a
pinned base. Ubuntu LTS was the close second on third-party `.deb` support; a rolling base
was rejected as incompatible with a pinned golden image.

### 3.9 A conventional desktop environment — XFCE or LXQt — plus XWayland

This overrides the instinct to pick a tiling compositor. **These models were trained
overwhelmingly on screenshots of conventional desktops.** A familiar desktop is measurably
easier for a model to drive than an unusual one. A panel, a file manager, a settings app and
an app menu are also things a general-purpose desk genuinely needs.

`sway --headless` would have given a structured window tree over IPC (`swaymsg -t get_tree`),
which is excellent for programmatic control — but tiling layouts are unfamiliar to the model
and there is no file manager. XWayland is required in all cases for X11-only software.

### 3.10 Perception: pixels primary, accessibility tree opportunistic

Screenshot plus coordinates is the path that always works, on any software, and is never
unavailable. On top of that, each step checks whether the focused application exposes an
AT-SPI tree over D-Bus; when it does, targeting goes by role and name instead of coordinates
— cheaper and far more reliable. Most GTK and Qt software exposes one, because screen
readers require it.

The agent does not choose between them. The ability decides, transparently.

Accessibility-first with pixel fallback was rejected: when the tree is stale or disagrees
with what is rendered, the agent acts on something the screen is not showing, and that
failure is silent.

### 3.11 Egress: transparent redirect at the TAP device

All guest traffic is DNAT'd on the host into the egress proxy. The guest cannot opt out —
there is no proxy setting to unset, and it covers every application including those that
ignore `HTTP_PROXY`.

This matters because §3.22 gives the agent a root shell inside the guest. Enforcement has to
live outside the boundary the agent controls or it is not enforcement.

The current SSRF protection (`assertPublicHost` in `apps/web/src/lib/research.ts`) guards
top-level navigations and redirect hops only; subresources get a protocol check. The proxy
replaces this with one chokepoint covering every request from every application.

### 3.12 Shared company folder: virtio-fs, read-write, own dial, ledgered

Mounted via virtio-fs (fast, proper POSIX semantics — 9p is not adequate). Writes are
governed by their own `shared_folder` autonomy category and land in the files ledger, so
cross-agent file movement stays auditable. This is the one deliberate hole in the per-agent
boundary and it is governed rather than open.

### 3.13 Live view: capture in-guest, relay through the desk-runner

A small agent inside the guest captures compositor output (wlroots screencopy or the
PipeWire portal), encodes, and the desk-runner relays into LiveKit. Compositor-side capture
gives damage regions, so a still screen costs almost nothing — the same property the current
CDP screencast in `browser-cast.ts` relies on.

Widen the existing track contract in `apps/web/src/lib/agent-screen.ts` from the browser to
the desk. The constants (`AGENT_SCREEN_WIDTH` 1280, `AGENT_SCREEN_HEIGHT` 900,
`AGENT_SCREEN_FPS` 10) and the rationale in that file's comments still apply — run the
compositor at exactly that size so nothing rescales on the way to the call stage.

### 3.14 Handover reuses the same in-guest agent, with input injection

One capture pipe, one transport, WebRTC both directions. Takeover is a mode on the existing
stream: viewer input is forwarded, event recording pauses, frames stop being filed, and the
ledger records the gap and its duration.

**Masking rules are load-bearing.** While a handover is active, keystrokes must never enter
the event stream and frames must not be filed. The ledger records *that* a handover happened,
who took over, why, and for how long — never what they typed. Getting this wrong leaks
credentials into an append-only ledger that cannot be edited.

### 3.15 Leases: idle suspend, hard concurrency cap, queue beyond it

A desk suspends after a set idle period. A concurrent-desk cap sized to host RAM bounds
memory. Work beyond the cap queues rather than overcommitting. The queue depth is an
operator-visible metric worth alerting on.

Headless desks are cheap (200-400MB); desks with a screen open are not (~1.2GB+). Size the
cap against screen-open desks, not headless ones.

### 3.16 `@appkit/agent-tools` becomes the base image manifest

The package's install and execute gates enforce something an agent with a terminal walks
around in one line — see §3.22. But its other properties do not depend on the gate: pinned
exact versions, health checks, revocability, an operator-visible shelf.

So the manifest becomes the declaration of what the golden base image contains. Keep
`defineAgentTool`, the pinning, the health checks and the shelf listing. Drop the runtime
gates from the agent path.

### 3.17 Escalation to a screen: the agent asks, with a reason, recorded

An `open_desktop` ability the agent calls explicitly with a justification, gated by the
`desktop` dial, written to the ledger.

The agent is the only party that knows mid-task that the DOM path failed or the software has
no CLI. It is also the party with an incentive to reach for the most general tool first.
Recording the stated reason means a pattern of opening a screen when a connector existed is
something an operator can see and correct.

Automatic escalation on first `desktop_*` call was rejected: the moment the expensive tier
was entered becomes invisible and no reason is captured.

### 3.18 Cost: per-session step budget, salary as the outer limit

A hard step ceiling per screen session (mirror the browser's existing `MAX_STEPS = 40` in
`browser-use.ts`), with the existing monthly salary budget as the only other limit. No
per-step throttle — the escalation gate in §3.17 already prevents the common runaway.

### 3.19 One `desk_sessions` + typed `desk_events` ledger

On a desk the agent types in a terminal and clicks in a GUI as one continuous piece of work.
Three separate ledgers would force an operator to interleave tables by timestamp to see what
happened, and the seams are where things get missed.

One session row per lease. One append-only event stream with typed rows. Supersedes
`browser_sessions`, `browser_steps` and `shell_sessions`.

Because §3.22 moves governance off per-command approval, **this ledger now carries more of
the governance weight than it used to.** It is not optional and it is not best-effort.

### 3.20 Packaging: `@appkit/desk` + `@appkit/egress-proxy`

Everything about running a desk in one package with policy and recording ports. The proxy
stays separate because it is genuinely useful on its own and because it enforces from
*outside* the guest.

### 3.21 Dials split into `sandbox` and `desktop`

`sandbox` governs having a machine at all — terminal, filesystem, tools. `desktop` governs
opening a screen on it. These replace `shell` and `computer_use`, which described a
distinction that no longer exists in the same shape.

Migration takes the **more restrictive** of an agent's existing levels where they conflict,
so no agent silently gains reach on upgrade.

### 3.22 The dial gates the machine and the screen — governance moves to the exits

Once an agent has a terminal on a full Linux box, per-command shell approval is enforcing
nothing: it can be scripted around in one line. Keeping it would be exactly the false
assurance `AGENTS.md` warns against when it says enforcement lives in the runtime, not in
prompts.

Real governance moves to boundaries that hold against a root shell:

- the egress allowlist, enforced outside the guest (§3.11);
- what is mounted into the VM at all;
- the event ledger (§3.19);
- approval on **outcomes** an operator actually cares about — sending external mail,
  publishing a file, anything money-adjacent. Those already have their own dial categories
  and they are unaffected by any of this.

### 3.23 Quickstart: map `/dev/kvm` when present, fail closed otherwise

Most Linux developer machines have `/dev/kvm` and can pass it into a container. Docker
Desktop on macOS and Windows generally cannot.

The quickstart gains a desk-runner service that maps the device when the host has it. Linux
developers get the full product. Everyone else gets everything except the machine, with a
clear startup message saying why — exactly how the product already behaves without Chromium
or bubblewrap installed. No software-emulation fallback: a TCG-emulated desktop is slow
enough to misrepresent the product worse than omitting it.

---

## 4. Host preparation (do this first, it gates everything)

On the Hyper-V host, for the **new dedicated desk host VM** — not the Dokploy VM:

```powershell
# VM must be OFF to toggle nested virtualisation
Stop-VM -Name 'bunkhouse-desk'
Set-VMProcessor -VMName 'bunkhouse-desk' -ExposeVirtualizationExtensions $true

# Dynamic Memory must be off; ballooning wrecks nested load
Set-VMMemory -VMName 'bunkhouse-desk' -DynamicMemoryEnabled $false -StartupBytes 32GB

# Nested guests need this for their own networking
Get-VMNetworkAdapter -VMName 'bunkhouse-desk' | Set-VMNetworkAdapter -MacAddressSpoofing On

Start-VM -Name 'bunkhouse-desk'
```

Requires Intel VT-x with EPT, or AMD-V with NPT on recent Windows builds. Verify inside the
guest before building anything:

```bash
ls -l /dev/kvm && grep -cE 'vmx|svm' /proc/cpuinfo
```

**Expect a performance tax.** Cloud Hypervisor inside a Hyper-V guest is L2 virtualisation.
The sub-second boot figures published for these VMMs are measured on bare metal; nested will
be slower. Measure on the real host before promising resume latency anywhere in the UI.

---

## 5. AppKit packages

AppKit is a separate repository. In bunkhouse it is consumed as version-pinned tarballs
under `vendor/appkit/`, wired through `pnpm.overrides` in the root `package.json` and
declared in `apps/web/package.json`. New packages follow that same pattern.

**The boundary rule:** AppKit owns mechanism and exposes a port. Bunkhouse supplies the
policy behind the port and owns the record. AppKit never touches a database and knows
nothing about tenants, employees or approvals.

### 5.1 `@appkit/desk` (new)

```ts
// Lifecycle
createDeskHost({ vmmPath, imageRoot, launcherIdentity })   → DeskHost
host.start({ deskId, baseImage, overlayPath, memoryMb, vcpus, network })
                                                            → DeskHandle
host.resume(deskId)  host.suspend(deskId)  host.destroy(deskId)
handle.renewLease(ms)
host.stats()                                                → { resident, queued, capacity }

// Execution (vsock to the in-guest agent)
handle.exec({ command, args, cwd, env, timeoutMs })         → ExecSnapshot
handle.exec({ ..., keepAlive: true })                       → background job, dies with lease
handle.jobs()                                               → running keepAlive processes

// The screen, as a service on a running machine
handle.screen.start({ width, height })                      → ScreenHandle
handle.screen.stop()
handle.screen.running                                       → boolean

// Perception — returns both, caller decides
screen.observe()  → {
  png: Buffer, width: number, height: number,
  a11y: A11yNode | null,        // AT-SPI tree of the focused app, when exposed
  windows: WindowInfo[],
  focused: WindowInfo | null,
}

// Input — coordinates are in observe()'s pixel space, 1:1
screen.input.move(x, y)   screen.input.click(x, y, button)
screen.input.type(text)   screen.input.key(combo)
screen.input.scroll(x, y, dx, dy)   screen.input.drag(from, to)
screen.a11y.invoke(nodeId, action)   // semantic path, when a tree exists

// Apps and clipboard
screen.launch(appId, args)   screen.clipboard.read()   screen.clipboard.write(text)

// Capture and handover
screen.frames({ fps, width, height })                       → AsyncIterable<Frame>
screen.handover.begin({ ttlMs, scope })                     → { url }
screen.handover.end()
// While a handover is active: input events are NOT recorded, frames are NOT emitted
// to the recording port. Only start/end/duration/actor reach the audit port.

// Ports supplied by the consumer
{ policy, onEvent, audit }
```

**Coordinate contract.** Input coordinates are in the pixel space of the most recent
`observe()`, one to one. Any scaling on the way out must be undone on the way in. Getting
this wrong makes every click land slightly off in a way that looks like model failure and is
very hard to diagnose.

**The in-guest agent is the security-critical piece.** It is PID 1's helper inside the
guest, speaking over vsock, and it is the only new attack surface in this design. Keep it
small enough to read in one sitting, give it no parsing it does not need, and unit-test it
hard. Everything else here reuses a boundary that already exists.

**Display backend port.** Provide an adapter interface so CI and non-KVM developer machines
can substitute a fake and the package stays testable without a hypervisor.

### 5.2 `@appkit/egress-proxy` (new)

```ts
createEgressProxy({
  policy: (req: { host, port, protocol, principal }) => 'allow' | 'deny',
  audit:  (entry: EgressAuditEntry) => void,
  listen: { host, port },
})
```

HTTP and CONNECT. The host check happens at CONNECT time from SNI, so TLS is not broken open
by default; optional MITM with a generated CA stays off unless a deployment enables it.
Designed to sit behind a transparent DNAT so the client never knows it is proxied.

Bunkhouse supplies the policy: `assertPublicHost` plus the tenant allowlist.

### 5.3 `@appkit/agent-tools` (repurpose)

Keep `defineAgentTool`, exact version pinning, health checks, the shelf listing and the
Drizzle store for shelf state. Add a `sourceKind: 'apt-package'` and a way to emit a
manifest as base-image build input. Remove the install/execute policy gates from the agent
execution path — they remain in the package for consumers not on a desk.

### 5.4 Unchanged

`@appkit/sandbox` (QuickJS) stays exactly as it is. It backs `run_script` and is the
cheapest tier for pure computation — no VM required. `@appkit/process-sandbox` stays in
AppKit for trusted non-agent workers.

---

## 6. Bunkhouse changes

### 6.1 Migrations

Latest existing migration is `migrations/0052_memory_embeddings.sql`. Follow the existing
conventions: drizzle-style with `--> statement-breakpoint`, immutable ledgers get the
`reject_immutable_ledger_change()` trigger, migrations must be backward-compatible and
preserve tenant data.

**`0053_desk_dials.sql`**
- Add `sandbox`, `desktop`, `shared_folder`, `background_job` to the `action_category` enum
  (`apps/web/src/db/schema/governance.ts`).
- Migrate `autonomy_settings`: `shell` → `sandbox`, `computer_use` → `desktop`. Where an
  agent has both and they differ, take the **more restrictive** level.
- Retire `shell` and `computer_use`. Postgres cannot drop enum values in place; recreate the
  type and remap, or leave them present-but-unused and enforce in `autonomy.ts` — decide
  based on how `0045_tenant_rbac.sql` handled similar cases and stay consistent.
- Mirror in `apps/web/src/lib/autonomy.ts` (`ACTION_CATEGORIES`, `CATEGORY_LABELS`) and
  `packages/runtime/src/types.ts` (`ActionCategory`).

**`0054_desk_ledger.sql`**
- `desk_sessions` — id, tenant, person, run, status, `screen_opened_at`, `screen_reason`,
  started/ended, audit columns. One row per lease.
- `desk_events` — id, tenant, session, seq (unique per session), `kind`, `detail` jsonb,
  `screenshot_file_id`, `at`. Append-only, immutable trigger.
  Event kinds: `shell_command`, `app_launch`, `click`, `type`, `key`, `scroll`, `drag`,
  `window_focus`, `screen_open`, `screen_close`, `file_write`, `shared_write`,
  `egress_blocked`, `handover_begin`, `handover_end`, `job_start`, `job_exit`.
- `background_jobs` — id, tenant, person, session, command, started, status, so an operator
  can find and kill a daemon. A running process nobody can see is the failure mode here.
- Migrate and retire `browser_sessions`, `browser_steps` (`apps/web/src/db/schema/browser.ts`)
  and `shell_sessions` (`apps/web/src/db/schema/workspace.ts`). Existing rows are audit
  history — preserve them, do not delete.

### 6.2 New and changed library code

**New `apps/web/src/lib/desk.ts`** — the desk runtime and its abilities. Registered in
`apps/web/src/lib/agent-abilities.ts` alongside the existing spreads (currently around
lines 826-828), with a `deskSupported()` gate that fails closed exactly as
`browserSupported()` does today.

Abilities:

| Ability | Category | Notes |
| --- | --- | --- |
| `run_shell` | `sandbox` | Now executes in the VM. Keep the name — agents and procedures already reference it. |
| `list_workspace_files`, `read_workspace_file`, `publish_workspace_file` | — | Repoint at the guest filesystem over vsock |
| `open_desktop` | `desktop` | Requires a stated `reason`, recorded |
| `close_desktop` | — | |
| `desktop_screenshot`, `desktop_click`, `desktop_type`, `desktop_key`, `desktop_scroll`, `desktop_drag` | `desktop` | Coordinates in `observe()` space |
| `desktop_windows`, `desktop_focus`, `desktop_open_app` | `desktop` | |
| `request_takeover` | `desktop` | Files an approval, opens a handover |
| `browser_*` | `desktop` | Repointed at the in-guest browser with a persistent profile |
| `run_script` | — | Unchanged, still QuickJS in-process |

**Ability descriptions must steer down the ladder.** Tell the agent explicitly to prefer
tier 0 abilities (`create_document`, `create_spreadsheet`) and connectors over the browser,
and the browser over a screen. This is guidance, not enforcement — enforcement is §3.22 —
but the escalation record in §3.17 makes it reviewable.

**New `apps/web/src/lib/desk-policy.ts`** — lease duration, idle suspend, concurrency cap,
queue. Reads tenant settings the way `getWorkspacePolicy` does today.

**New `apps/web/src/lib/base-image.ts`** — what the golden image contains, in the shape
`tool-catalogue.ts` uses today. Start deliberately short: XFCE or LXQt, XWayland, Chromium,
a terminal, a file manager, LibreOffice, git, the CLI tools already catalogued.

**Changed `apps/web/src/lib/agent-screen.ts`** — widen from browser to desk. Keep the
constants and the reasoning in the comments; the track name changes from `agent-browser`
to something desk-shaped, and `call-stage.tsx` follows.

**Retired:** `apps/web/src/lib/shell-sandbox.ts`, `apps/web/src/lib/browser-use.ts` as an
out-of-VM driver, `apps/web/src/lib/browser-cast.ts` in its current CDP form.

### 6.3 Deployment

- **New `deploy/desk-runner.compose.yaml`** on the dedicated desk host VM, with
  `devices: ['/dev/kvm']`, the agent-disks volume, and the egress-proxy service. Model the
  header comment on `shell-runner.compose.yaml` — it explains *why* the service is separate,
  which is the part future maintainers need.
- **Retire `deploy/shell-runner.compose.yaml`** and the `BUNKHOUSE_SHELL_URL` /
  `BUNKHOUSE_SHELL_TOKEN` pair, replaced by the desk-runner's address and token.
- **`docker-compose.yml`** — add the desk-runner with a conditional `/dev/kvm` mapping, and
  **fix the existing bug**: the quickstart mounts nothing at `/data/agent-homes`, so
  `run_shell`'s promise that "files you create are there next time" is false on the
  one-command path. Only `deploy/dokploy.compose.yaml` binds `agent-workspaces`.
- **`Dockerfile`** — the agent-facing native tools (chromium, libreoffice, bubblewrap,
  tesseract, poppler) move from the app image into the guest base image. The app image keeps
  only what the server itself needs.

### 6.4 Observatory and settings

- Desk session replay: one continuous event stream with screenshots inline, replacing the
  separate browser and shell views.
- Live desk view on the call stage, via the widened track contract.
- Cost per screen session, and escalation reasons, surfaced where an operator will see the
  pattern.
- Queue depth, resident desk count, capacity.
- Background jobs list with a kill action.
- Feature gate: per `AGENTS.md`, the desk belongs on the one authoritative Company Settings
  → Features switchboard, and `desktop` must not be independently available when the parent
  gate is off.

---

## 7. Build order

Each phase should be independently shippable and independently verifiable.

**Phase 1 — the machine.** Desk host VM prepared, desk-runner container, Cloud Hypervisor
booting a Debian base image with a per-agent CoW overlay, vsock guest agent, `exec` working.
No abilities wired yet.
*Done when:* a desk boots, runs a command over vsock, suspends, resumes, and the file it
wrote is still there.

**Phase 2 — cutover.** `run_shell` and the workspace file abilities move to the VM. Egress
proxy in the path with transparent redirect. `shell-runner` retired.
*Done when:* every existing shell-using procedure works unchanged, and a request to a
private address from inside the guest is blocked and appears in the audit.

**Phase 3 — the ledger and the dials.** `0053` and `0054`. `desk_sessions`/`desk_events`,
observatory replay, dial migration.
*Done when:* an operator can replay a session end to end, and no agent's effective
permissions changed on upgrade.

**Phase 4 — the browser moves in.** In-guest Chromium with a persistent profile per agent,
downloads landing in the workspace, `browser_*` repointed.
*Done when:* an agent signs in to a site in one run and is still signed in the next, and a
downloaded file is visible to `run_shell`.

**Phase 5 — the screen.** DE in the base image, `open_desktop`, input, `observe()` with
opportunistic AT-SPI, in-guest capture, live view on the call stage.
*Done when:* an agent opens a screen with a recorded reason, drives a GUI application, and
someone on a call watches it happen.

**Phase 6 — handover.** Input injection on the existing stream, masking, auto-revoke.
*Done when:* a human completes a login the agent could not, and the ledger shows the gap
with no keystrokes in it.

**Phase 7 — shared folder.** virtio-fs mount, `shared_folder` dial, ledger entries.

**Phase 8 — background jobs**, then memory snapshot if and only if cold boot latency proves
to be a real cost.

---

## 8. Risks and non-goals

**The in-guest agent is new attack surface.** Everything else reuses a boundary that already
exists and has been reasoned about. A bug in the vsock handler is a sandbox escape. Keep it
minimal.

**Prompt injection against a machine that stays signed in.** Once the browser profile
persists, a hostile page can try to steer the agent through sessions it already holds. This
is the concrete failure being reported against Grok Bot. The mitigations are structural and
must not be eroded for convenience: per-agent boundaries, per-tenant RLS, the `desktop` dial,
the egress allowlist, and the ledger. If a "shared team desktop" feature is ever requested,
that convenience is precisely the defect.

**Nested virtualisation costs performance.** See §4. Do not quote bare-metal boot figures in
the UI or the docs.

**Desktop automation is less reliable than everything below it.** Clicking pixels fails in
ways querying a DOM does not, and it fails silently. The ladder in §2 is the mitigation and
the escalation record in §3.17 is how you find out it is being ignored.

**Non-goals.** Multi-agent shared desktops. GPU passthrough. Windows or macOS guests.
Memory snapshot before disk persistence is measured. Replacing tier-0 document abilities
with GUI equivalents — `create_spreadsheet` is better at its job than an agent clicking in
LibreOffice, and always will be.

---

## 9. Deliberately deferred

Not decided, not blocking, revisit when the phase arrives:

- Exact idle-suspend duration and concurrency cap — size against the real host.
- XFCE versus LXQt — decide when the base image is built, on measured footprint.
- Whether `desk_events` retention needs a policy separate from the existing workspace
  retention setting.
- Whether the egress proxy should offer opt-in MITM for body-level audit.
- Snapshot format and UFFD strategy, if §3.4's phase 8 ever happens.
