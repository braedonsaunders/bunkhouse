import { NextResponse, type NextRequest } from 'next/server'
import { getSessionCookie } from 'better-auth/cookies'

// Every route requires a signed-in user. This edge check is a fast
// cookie-presence gate that shapes navigation (no session cookie → /login);
// it deliberately does NOT validate the session — forging a cookie gets you
// nothing, because every data path revalidates server-side via requireUser()
// inside resolveTenantId(). Exempt: the login screen, the Better Auth API
// (sign-in must reach it), and static assets.

export function middleware(request: NextRequest) {
  const sessionCookie = getSessionCookie(request)
  if (!sessionCookie) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}

export const config = {
  matcher: [
    // Everything except /login, /api/auth/*, Next internals, and static files.
    '/((?!login|api/auth|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?|ttf|map)$).*)',
  ],
}
