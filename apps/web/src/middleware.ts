import { NextResponse, type NextRequest } from 'next/server'
import { getSessionCookie } from 'better-auth/cookies'

// Every route requires a signed-in user. This edge check is a fast
// cookie-presence gate that shapes navigation (no session cookie → /login);
// it deliberately does NOT validate the session — forging a cookie gets you
// nothing, because every data path revalidates server-side via requireUser()
// inside resolveTenantId(). Exempt: the login screen, the Better Auth API
// (sign-in must reach it), the /meet/[token] guest rooms (an outside guest
// has no account by design — the invitation token is the credential, and it
// is revalidated on every read and every action), and static assets.

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
    // Everything except /login, /meet/*, /api/auth/*, /dev-scene, Next
    // internals, and static files. /dev-scene renders UI components against no
    // data at all — there is nothing behind it to protect, and putting it
    // behind the sign-in is what stopped these being looked at before they
    // shipped.
    '/((?!login|meet|api/auth|dev-scene|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?|ttf|map)$).*)',
  ],
}
