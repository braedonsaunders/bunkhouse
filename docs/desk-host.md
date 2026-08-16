# The desk host and the guest base image

Each agent gets one Debian machine in a Cloud Hypervisor microVM. The microVMs run inside the desk host: a dedicated Hyper-V VM with nested virtualisation enabled, separate from the Dokploy VM on purpose — enabling nested virtualisation means powering the VM off and pinning its RAM, and doing that to the VM holding provider keys, the session secret, and the database is the wrong trade. The desk host runs `deploy/desk-runner.compose.yaml` and nothing else of Bunkhouse's.

## Preparing the desk host VM

Run on the Hyper-V host, from an administrator PowerShell, against the new dedicated VM — not the Dokploy VM:

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

Requires Intel VT-x with EPT, or AMD-V with NPT on recent Windows builds. Verify inside the guest before deploying anything:

```bash
ls -l /dev/kvm && grep -cE 'vmx|svm' /proc/cpuinfo
```

No `/dev/kvm`, or a zero flag count, means the preparation did not take. Fix that before touching the compose file; nothing downstream works without it.

## What the golden base image contains

One maintained base image; each agent's desk is a copy-on-write overlay on top of it, holding `/home` and anything the agent installs. Patch the base once and every desk inherits it on next boot.

- Debian stable, matching the app image's lineage.
- A conventional desktop environment — XFCE or LXQt, decided at image-build time on measured footprint — plus XWayland. Installed, not running: a desk boots headless and the screen starts on demand.
- Chromium, with a persistent per-agent profile.
- A terminal and a file manager.
- LibreOffice.
- git.
- The CLI tools from the base-image manifest (`@appkit/agent-tools` declares them, version-pinned, with health checks and an operator-visible shelf).

These are agent tools, and they live here rather than in the app image: the containers that hold the keys ship only what the server itself needs.

## The three cost tiers

The agent is expected to stay as low on this ladder as it can. Escalation to a screen requires a stated reason and is recorded.

| Tier | What it is | Cost |
| --- | --- | --- |
| 0 | Existing abilities — `create_document`, `create_spreadsheet`, `web_search`, `read_webpage`, `run_script`, mail, memory | Ordinary model calls |
| 1 | The headless machine — shell, filesystem, tools, browser with a persistent profile | Ordinary model calls + a small resident VM |
| 2 | The screen — GUI apps, desktop automation | A vision call per step where no accessibility tree is available |

Headless desks are cheap (roughly 200-400MB resident); desks with a screen open are not (about 1.2GB and up). Size the concurrency cap against screen-open desks, and watch the queue depth — work beyond the cap queues rather than overcommitting the host.

## Expect a performance tax

Cloud Hypervisor on the desk host is L2 virtualisation — a VMM inside a Hyper-V guest. The sub-second boot figures published for these VMMs are measured on bare metal; nested will be slower. Measure boot and resume on the real host before quoting latency to anyone, and never promise bare-metal figures in the UI or the docs.
