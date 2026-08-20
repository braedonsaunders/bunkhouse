import { runTsx } from './run-tsx.mjs'

const tests = [
  'authorization',
  'redaction',
  'governance',
  'approval-presentation',
  'compaction',
  'breaker',
  'call-tones',
  'duties',
  'org',
  'assignment',
  'tools',
  'mailbox',
  'netsuite-shim',
  'http-system',
  'system-credentials',
  'internal-addresses',
  'call-speech-gate',
  'memory-query',
  'memory-resilience',
  'call-speech-acts',
  'skills',
  'backdrop',
  'page-reading',
  'desk',
  'desk-marks',
  'chat-replay',
  'duty-delivery',
  'chat',
  'chat-dispatch',
  'lifecycle',
  'product-ui',
  'acp-boundary',
  'release-discipline',
]

for (const name of tests) {
  const code = await runTsx([`scripts/${name}.test.mts`], {
    nodeOptions: ['--import=./scripts/pin-test-env.mjs', '--conditions=react-server'],
  })
  if (code !== 0) process.exit(code)
}
