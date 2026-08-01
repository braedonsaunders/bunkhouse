import { NextResponse, type NextRequest } from 'next/server'
import { getSessionCookie } from 'better-auth/cookies'

// Fast cookie-presence gate for navigation. Every data path independently
// validates the real session and tenant membership before touching data.
export function proxy(request: NextRequest) {
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
    '/((?!login|meet|api/auth|dev-scene|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?|ttf|map)$).*)',
  ],
}
