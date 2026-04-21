import { describe, expect, it } from 'vitest';

describe('web next config security headers', () => {
  it('defines a response CSP header for frontend responses', async () => {
    const mod = await import('../../packages/web/next.config.mjs');
    const headers = await mod.default.headers();

    const rootHeaders = headers.find((entry: { source: string }) => entry.source === '/:path*');
    expect(rootHeaders).toBeDefined();

    const csp = rootHeaders.headers.find((header: { key: string }) => header.key === 'Content-Security-Policy')?.value;
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
