import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { isProtectedPath } from './lib/auth-session';

export function middleware(request: NextRequest) {
  if (!isProtectedPath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const hasSessionCookie = Boolean(request.cookies.get('hytale_session')?.value);
  if (hasSessionCookie) {
    return NextResponse.next();
  }

  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/console/:path*',
    '/whitelist/:path*',
    '/bans/:path*',
    '/backups/:path*',
    '/crashes/:path*',
    '/audit/:path*',
    '/settings/:path*',
  ],
};
