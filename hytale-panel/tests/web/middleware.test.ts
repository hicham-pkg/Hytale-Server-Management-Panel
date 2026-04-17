import { describe, expect, it } from 'vitest';
import { middleware } from '../../packages/web/src/middleware';

function makeRequest(pathname: string, sessionCookie?: string) {
  return {
    nextUrl: { pathname },
    url: `https://panel.example${pathname}`,
    cookies: {
      get: (name: string) =>
        name === 'hytale_session' && sessionCookie ? { value: sessionCookie } : undefined,
    },
  } as any;
}

describe('protected route middleware', () => {
  it('redirects unauthenticated dashboard access to /login', () => {
    const response = middleware(makeRequest('/dashboard'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://panel.example/login');
  });

  it('allows protected routes when the session cookie exists', () => {
    const response = middleware(makeRequest('/dashboard', 'session-123'));

    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});
