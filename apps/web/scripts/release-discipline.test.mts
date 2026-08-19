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
