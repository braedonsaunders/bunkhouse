import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'))

/** Run a TypeScript entry point with explicit Node options on every OS. */
export function runTsx(args, options = {}) {
  const nodeOptions = [...(options.nodeOptions ?? [])]
  const inherited = process.env.NODE_OPTIONS?.trim()
  const child = spawn(process.execPath, [tsxCli, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      ...options.env,
      NODE_OPTIONS: [inherited, ...nodeOptions].filter(Boolean).join(' '),
    },
    stdio: 'inherit',
    windowsHide: false,
  })

  const signalHandlers = new Map()
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => child.kill(signal)
    signalHandlers.set(signal, handler)
    process.once(signal, handler)
  }

  const cleanup = () => {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
  }

  return new Promise((resolve, reject) => {
    child.once('error', (error) => {
      cleanup()
      reject(error)
    })
    child.once('exit', (code, signal) => {
      cleanup()
      resolve(code ?? (signal ? 1 : 0))
    })
  })
}

async function main(argv) {
  const nodeOptions = []
  const tsxArgs = []
  for (const arg of argv) {
    if (arg.startsWith('--node-option=')) nodeOptions.push(arg.slice('--node-option='.length))
    else tsxArgs.push(arg)
  }
  if (tsxArgs.length === 0) throw new Error('A TypeScript entry point is required.')
  process.exitCode = await runTsx(tsxArgs, { nodeOptions })
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
