import { toNextJsHandler } from '@braedonsaunders/appkit-auth/next'
import { getAuth } from '@/lib/auth'

// Better Auth catch-all. Handlers are built lazily so importing this module
// at build time never forces auth configuration (secret, database) to exist.

let handlers: ReturnType<typeof toNextJsHandler> | undefined

function getHandlers() {
  handlers ??= toNextJsHandler(getAuth())
  return handlers
}

export function GET(request: Request) {
  return getHandlers().GET(request)
}

export function POST(request: Request) {
  return getHandlers().POST(request)
}
