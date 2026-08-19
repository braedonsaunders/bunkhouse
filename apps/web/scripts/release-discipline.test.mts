import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

test('the registry-gap dependency is content-addressed', async () => {
  const artifacts = {
    'vendor/appkit/braedonsaunders-appkit-ai-1.1.0-05f281b688b5.tgz': 'b6c48b7720b26fd25cb5b1ac59b2539b6cf8b734aa774f54f121f3936608056f',
    'vendor/appkit/braedonsaunders-appkit-sync-1.1.0-05f281b688b5.tgz': 'a382a449fca82abe3f987ccdb9e956e03ab631b25d6d03499d928c08457d8201',
  }
  for (const [path, expected] of Object.entries(artifacts)) {
    const artifact = await readFile(new URL(path, repo))
    assert.equal(createHash('sha256').update(artifact).digest('hex'), expected)
  }
})
