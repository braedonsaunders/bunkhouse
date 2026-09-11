# Deploying the desk runner

The desk runner is the only container that maps `/dev/kvm` and boots per-agent
microVMs. It runs on its own host for a reason given at length in
`deploy/desk-runner.compose.yaml`: nested virtualisation requires powering a VM
off and disabling dynamic memory, and doing that to the machine holding the
provider keys, the session secret and the database is the wrong trade.

Running somewhere else does not mean deploying differently. This document exists
because for a while it did.

## What went wrong, so it is not rebuilt that way

The compose file used to say `build: { context: .., dockerfile: ... }`. A build
needs a source tree, so the desk host acquired one: a copy of the repository
rsync'd to `/opt/bunkhouse-src`, built locally, and brought up with
`docker compose up` over SSH. Three things followed.

- **It drifted.** Every app deploy moved `web` and `worker` and left the runner
  on whatever tag it had been built with. It sat three weeks behind, and a merged
  fix to `apps/web/scripts/desk-runner.mts` was live nowhere. The only notice was
  a line scrolling past in a green job, which is why that is a warning annotation
  now.
- **Its configuration lived in one person's shell.** There was no `.env`, so the
  values came from whatever had been exported when the container was last
  created. A later `docker compose up` silently reverted `BUNKHOUSE_DESK_BIND` to
  `127.0.0.1` — unpublishing the port the app tier reaches the runner on — and
  blanked `BUNKHOUSE_DESK_TOKEN`.
- **Nobody could tell what was deployed.** The running image was
  `deploy-desk-runner`, built at an unrecorded commit from a tree of unrecorded
  provenance.

## How it works now

CI builds the runner image beside the app image, from the same commit, under the
same tag:

```
ghcr.io/braedonsaunders/bunkhouse:<sha>        # the app
ghcr.io/braedonsaunders/bunkhouse:<sha>-desk   # the app + cloud-hypervisor + qemu-img
```

Two deliberate choices there.

It is a separate **image** because only one container may boot microVMs; the app
image ships no VMM so that the containers holding secrets cannot. And it is a
tag of the same **package** rather than a package of its own because a new GHCR
package is private by default and can only be made public by hand afterwards.
`ghcr.io/braedonsaunders/bunkhouse` is public, which is why the desk host needs
no registry credentials — a second package would have meant the first deploy
failing to pull, which is exactly the sort of one-time manual step that left this
component undeployed in the first place.

The compose file `pull`s that image. The desk host needs no source tree, no build
toolchain, and no repository access.

The deploy job's **Point the desk runner at the same image** step pushes the
compose file and `BUNKHOUSE_TAG` to a Dokploy compose application and triggers
it, so the runner moves with every app deploy. It is gated on
`DOKPLOY_DESK_COMPOSE_ID`; without that it warns loudly rather than passing
quietly.

## One-time setup

Everything above is in the repository. What is not, and what makes the warning
appear, is the Dokploy application.

1. **Register the desk host as a Dokploy server.** Dokploy → Settings → Servers →
   Create Server, pointing at the desk host's LAN address. Dokploy connects over
   SSH and installs its agent; add its public key to the `agent` user there.
2. **Create a Docker Compose application** on that server, in the `bunkhouse`
   project. Name it for what it is — `bunkhouse-desk` — and note that the
   existing `bunkhouse-shell` application is the retired bubblewrap runner, not
   this.
3. **Paste `deploy/desk-runner.compose.yaml`** as its compose file. CI overwrites
   this on every deploy, so it only has to be right enough to start.
4. **Set its environment.** These are the values a recreate must not lose:

   | variable | why |
   | --- | --- |
   | `BUNKHOUSE_DESK_TOKEN` | the shared bearer the app tier presents; the same value goes in the app stack, and CI deliberately never rewrites it |
   | `BUNKHOUSE_DESK_BIND` | the host's LAN address. Defaulting this to `127.0.0.1` unpublishes the port and cuts the app tier off the runner |
   | `BUNKHOUSE_AGENT_DISKS_HOST` | the reflink-capable volume holding `base.raw`, `vmlinux` and the overlays |
   | `BUNKHOUSE_TAG` | set by CI on every deploy; any value to start |
   | `BUNKHOUSE_DESK_IDLE_MS` | how long a desk may idle before it is parked. Keep it **below** the tenant desk policy's `leaseMs`, or the lease expires first and this has no effect |
   | `BUNKHOUSE_DESK_PARK_WITH_MEMORY` | `off` to fall back to shutdown parking, for a host tight on the disks volume |

5. **Set `DOKPLOY_DESK_COMPOSE_ID`** as a repository secret, to that
   application's `composeId`. The warning stops and the step starts deploying.

## What the host still has to provide

Not deployable, and worth checking when a desk host is rebuilt:

- `/dev/kvm`, with nested virtualisation enabled on the hypervisor and dynamic
  memory off.
- A **reflink-capable** filesystem (XFS with `reflink=1`, or Btrfs) at
  `BUNKHOUSE_AGENT_DISKS_HOST`. On ext4 `cp --reflink=auto` silently falls back
  to copying the whole base image — about 5 GB per desk, per boot.
- Room for a memory snapshot per parked desk, roughly the guest's RAM, when
  `BUNKHOUSE_DESK_PARK_WITH_MEMORY` is on.

## Verifying a deploy

```sh
curl -s http://<desk-host>:8080/health
```

`ok`, `kvm`, and `vsock` should all be true, `lastError` null. `docker port` on
the container should show the port published on the LAN address rather than on
`127.0.0.1` — that one has broken twice.
