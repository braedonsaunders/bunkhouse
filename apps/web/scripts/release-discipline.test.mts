import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import webPackage from '../package.json' with { type: 'json' }

const repo = new URL('../../../', import.meta.url)
const readRepo = (path: string) => readFile(new URL(path, repo), 'utf8')

test('package commands set Node options through the portable runner', () => {
  for (const [name, command] of Object.entries(webPackage.scripts)) {
    assert.equal(/^NODE_OPTIONS=/.test(command), false, `${name} uses a POSIX-only environment assignment`)
  }
  assert.equal(webPackage.scripts.test, 'node scripts/run-tests.mjs')
})

test('release images cover both server architectures with supply-chain evidence', async () => {
  const release = await readRepo('.github/workflows/release.yml')
  assert.match(release, /platforms: linux\/amd64,linux\/arm64/)
  assert.match(release, /provenance: mode=max/)
  assert.match(release, /sbom: true/)
})

test('host validation names Windows, macOS, and Linux explicitly', async () => {
  const workflow = await readRepo('.github/workflows/cross-platform.yml')
  for (const host of ['ubuntu-latest', 'macos-14', 'windows-latest']) assert.match(workflow, new RegExp(host))
})

test('AppKit dependencies resolve from the public registry', async () => {
  const rootPackage = await readRepo('package.json')
  const lockfile = await readRepo('pnpm-lock.yaml')
  for (const source of [rootPackage, lockfile]) {
    assert.doesNotMatch(source, /vendor\/appkit/)
    assert.doesNotMatch(source, /file:[^\n]*appkit/i)
    assert.doesNotMatch(source, /@appkit\//)
  }
})

test('the desk runner is a CI artifact, not something built on its own host', async () => {
  const compose = await readRepo('deploy/desk-runner.compose.yaml')
  const deploy = await readRepo('.github/workflows/deploy.yml')

  // The whole point. A `build:` here means the desk host needs a source tree to
  // deploy, which in practice meant a repository rsync'd to /opt/bunkhouse-src
  // and a `docker compose up` over SSH — so the runner was the one component
  // with no pipeline. It drifted three weeks behind the app and a merged fix to
  // desk-runner.mts was live nowhere.
  assert.equal(/^\s*build:/m.test(compose), false, 'the desk runner is pulled, never built on the host')
  assert.match(compose, /pull_policy: always/, 'so a redeploy of the same tag still moves')

  // The compose file and CI must name the SAME image. They did not, briefly: CI
  // was switched to publish `<package>:<tag>-desk` and the compose file was left
  // pointing at a `bunkhouse-desk-runner` package that would never exist. The
  // first loose assertion here matched either spelling and sailed past it, so
  // this derives both sides and compares them instead.
  const pkg = /^\s*IMAGE_NAME: (\S+)$/m.exec(deploy)?.[1]
  const suffix = /^\s*DESK_TAG_SUFFIX: (\S+)$/m.exec(deploy)?.[1]
  assert.ok(pkg, 'CI names the package')
  assert.ok(suffix, 'CI names the desk tag suffix')
  const deskImage = /^\s*image: \$\{BUNKHOUSE_IMAGE:-([^}]+)\}:\$\{BUNKHOUSE_TAG:-latest\}(\S*)$/m.exec(compose)
  assert.ok(deskImage, 'the desk service pins its image through BUNKHOUSE_IMAGE/BUNKHOUSE_TAG')
  assert.equal(deskImage[1], pkg, `compose pulls ${deskImage[1]} but CI pushes ${pkg}`)
  assert.equal(deskImage[2], suffix, `compose expects tag suffix "${deskImage[2]}" but CI appends "${suffix}"`)

  // CI has to actually produce the thing the compose file asks for.
  assert.match(deploy, /name: Build and push the desk-runner image/)
  assert.match(deploy, /file: .*deploy\/desk-runner\.Dockerfile/)
  // amd64 only: it boots microVMs on /dev/kvm and there is no arm64 desk host.
  const deskBuild = deploy.slice(deploy.indexOf('Build and push the desk-runner image'))
  assert.match(deskBuild.slice(0, 900), /platforms: linux\/amd64/)

  // Same tag as the app, from the same commit. The runner being a version apart
  // from the app is the failure this replaced.
  const appTag = /\$\{\{ steps\.image-tag\.outputs\.tag \}\}/
  assert.match(deskBuild.slice(0, 900), appTag, 'the runner is tagged from the same resolved tag')

  // A tag of the SAME package, not a new one. A fresh GHCR package is private by
  // default and the desk host pulls anonymously, so a second package would fail
  // to pull on the host until somebody flipped it public by hand.
  assert.match(deploy, /DESK_TAG_SUFFIX: -desk/)
  assert.equal(
    /DESK_IMAGE_NAME: ghcr\.io/.test(deploy),
    false,
    'no separate package, which would need a manual visibility change',
  )

  // And the gap that remains must stay loud rather than passing quietly.
  assert.match(deploy, /Desk runner is drifting/)
  assert.match(deploy, /docs\/desk-runner-deployment\.md/, 'pointing at how to close it')
})

test('the deploy waits for Dokploy before racing it', async () => {
  const deploy = await readRepo('.github/workflows/deploy.yml')

  // The compose-scoped fallback updates the swarm services directly, so running
  // it while Dokploy is still deploying the same stack means two deployments
  // competing. That happened: the step bailed after 60s, Dokploy finished on its
  // own at 4m49s, both succeeded, and the step still reported failure — a red
  // pipeline over a green deployment, which is the outcome most likely to get a
  // real failure ignored.
  const bail = Number(/\[ "\$latest" = "queued" \] && \[ "\$i" -ge (\d+) \]/.exec(deploy)?.[1])
  assert.ok(Number.isFinite(bail), 'the queued bail-out states its threshold')

  // The loop sleeps ten seconds per turn, so the threshold is in units of that.
  const sleepSeconds = Number(/for i in \$\(seq 1 (\d+)\); do\n\s*sleep (\d+)/.exec(deploy)?.[2] ?? 10)
  const patienceSeconds = bail * sleepSeconds
  assert.ok(
    patienceSeconds >= 300,
    `a ${patienceSeconds}s wait is shorter than Dokploy's observed start latency; the fallback would race it`,
  )

  // And it must still be inside the loop's own budget, or the fallback is dead
  // code and a genuinely stuck queue never gets one.
  const iterations = Number(/for i in \$\(seq 1 (\d+)\); do/.exec(deploy)?.[1])
  assert.ok(Number.isFinite(iterations) && bail < iterations, 'the fallback is still reachable')
})
