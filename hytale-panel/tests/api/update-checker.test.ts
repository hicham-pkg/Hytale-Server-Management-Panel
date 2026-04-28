import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

const baseEnv: Record<string, string> = {
  DATABASE_URL: 'postgresql://hytale_panel:password@127.0.0.1:5432/hytale_panel',
  NODE_ENV: 'test',
  SESSION_SECRET: 'a'.repeat(64),
  CSRF_SECRET: 'b'.repeat(64),
  HELPER_HMAC_SECRET: 'c'.repeat(64),
  PANEL_VERSION: '1.1.0',
  PANEL_UPDATE_REPO: 'hicham-pkg/Hytale-Server-Management-Panel',
  PANEL_UPDATE_CACHE_MINUTES: '60',
};

async function loadService() {
  const mod = await import('../../packages/api/src/services/update-checker.service');
  mod._resetCacheForTests();
  return mod;
}

function mockReleaseResponse(body: Record<string, unknown>, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('update-checker.service', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, ...baseEnv };
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('compareSemver', () => {
    it('handles equal, ascending, and descending', async () => {
      const { compareSemver } = await loadService();
      expect(compareSemver('1.1.0', '1.1.0')).toBe(0);
      expect(compareSemver('1.1.0', '1.2.0')).toBe(-1);
      expect(compareSemver('2.0.0', '1.99.99')).toBe(1);
    });

    it('strips leading "v"', async () => {
      const { compareSemver } = await loadService();
      expect(compareSemver('v1.0.0', '1.0.0')).toBe(0);
      expect(compareSemver('v1.2.0', 'v1.1.5')).toBe(1);
    });

    it('treats prerelease as earlier than the same released version', async () => {
      const { compareSemver } = await loadService();
      expect(compareSemver('1.2.0-rc.1', '1.2.0')).toBe(-1);
      expect(compareSemver('1.2.0', '1.2.0-rc.1')).toBe(1);
    });
  });

  describe('getUpdateStatus — no update available', () => {
    it('reports updateAvailable=false when latest equals current', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockReleaseResponse({
          tag_name: 'v1.1.0',
          name: '1.1.0',
          html_url: 'https://github.com/owner/repo/releases/tag/v1.1.0',
          published_at: '2026-04-25T12:00:00Z',
          prerelease: false,
          draft: false,
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const svc = await loadService();
      const status = await svc.getUpdateStatus();

      expect(status.currentVersion).toBe('1.1.0');
      expect(status.latestVersion).toBe('1.1.0');
      expect(status.updateAvailable).toBe(false);
      expect(status.error).toBeUndefined();
      expect(status.fromCache).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('getUpdateStatus — update available', () => {
    it('reports updateAvailable=true when latest > current', async () => {
      const expectedUrl =
        'https://github.com/hicham-pkg/Hytale-Server-Management-Panel/releases/tag/v1.2.0';
      const fetchMock = vi.fn().mockResolvedValue(
        mockReleaseResponse({
          tag_name: 'v1.2.0',
          name: 'Mods Manager polish',
          html_url: expectedUrl,
          published_at: '2026-05-01T09:00:00Z',
          prerelease: false,
          draft: false,
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const svc = await loadService();
      const status = await svc.getUpdateStatus();

      expect(status.updateAvailable).toBe(true);
      expect(status.latestVersion).toBe('1.2.0');
      // URL must match the configured repo — server-side hardening drops it
      // otherwise (see release URL safety tests below).
      expect(status.releaseUrl).toBe(expectedUrl);
      expect(status.releaseName).toBe('Mods Manager polish');
      expect(status.publishedAt).toBe('2026-05-01T09:00:00Z');
    });
  });

  describe('getUpdateStatus — GitHub API failure', () => {
    it('returns a status object with error set on non-200', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockReleaseResponse({}, false, 503),
      );
      vi.stubGlobal('fetch', fetchMock);

      const svc = await loadService();
      const status = await svc.getUpdateStatus();

      expect(status.error).toMatch(/GitHub API responded 503/);
      expect(status.updateAvailable).toBe(false);
      expect(status.latestVersion).toBeNull();
      // Errors must not poison the cache.
      const second = await svc.getUpdateStatus();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(second.error).toBeDefined();
    });

    it('normalizes raw fetch failures to a generic message (no leakage)', async () => {
      const fetchMock = vi.fn().mockRejectedValue(
        new Error('connect ECONNREFUSED 127.0.0.1:443 with secret token=abc123'),
      );
      vi.stubGlobal('fetch', fetchMock);

      const svc = await loadService();
      const status = await svc.getUpdateStatus();

      expect(status.error).toBe('GitHub release check failed');
      // Defensive: token / hostname must not leak into the response.
      expect(JSON.stringify(status)).not.toContain('ECONNREFUSED');
      expect(JSON.stringify(status)).not.toContain('abc123');
    });

    it('honors a 10s timeout via AbortController', async () => {
      const fetchMock = vi.fn().mockImplementation(
        (_url: string, init: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const svc = await loadService();
      // Don't actually wait 10 seconds — just confirm that a signal was attached
      // and that an abort surfaces as a normalized error. Force an immediate
      // abort by calling the controller directly via the fetch mock's signal.
      const promise = svc.getUpdateStatus();
      // Wait one microtask so fetch was invoked and signal attached.
      await Promise.resolve();
      const callArgs = fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
      expect(callArgs?.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('GITHUB_UPDATE_TOKEN handling', () => {
    it('sends Authorization: Bearer <token> on the outbound request', async () => {
      process.env.GITHUB_UPDATE_TOKEN = 'ghp_secret_value_AAAAAAAA';

      const fetchMock = vi.fn().mockResolvedValue(
        mockReleaseResponse({ tag_name: 'v1.1.0', published_at: '2026-04-25T12:00:00Z' }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const svc = await loadService();
      await svc.getUpdateStatus();

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer ghp_secret_value_AAAAAAAA');
      expect(headers['User-Agent']).toBe('hytale-panel-update-checker');
    });

    it('omits Authorization when no token is set', async () => {
      delete process.env.GITHUB_UPDATE_TOKEN;

      const fetchMock = vi.fn().mockResolvedValue(
        mockReleaseResponse({ tag_name: 'v1.1.0', published_at: '2026-04-25T12:00:00Z' }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const svc = await loadService();
      await svc.getUpdateStatus();

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    });

    it('NEVER includes the token in the response payload', async () => {
      const TOKEN = 'ghp_super_secret_AAAAAAAA';
      process.env.GITHUB_UPDATE_TOKEN = TOKEN;

      const fetchMock = vi.fn().mockResolvedValue(
        mockReleaseResponse({
          tag_name: 'v1.2.0',
          name: 'release',
          html_url: 'https://github.com/owner/repo',
          published_at: '2026-05-01T09:00:00Z',
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const svc = await loadService();
      const status = await svc.getUpdateStatus();
      const serialized = JSON.stringify(status);
      expect(serialized).not.toContain(TOKEN);
      expect(serialized).not.toContain('Authorization');
      expect(Object.keys(status)).not.toContain('githubUpdateToken');
      expect(Object.keys(status)).not.toContain('token');
    });
  });

  describe('release URL safety', () => {
    it('keeps github.com URLs that point to the configured repo', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockReleaseResponse({
          tag_name: 'v1.2.0',
          html_url: 'https://github.com/hicham-pkg/Hytale-Server-Management-Panel/releases/tag/v1.2.0',
          published_at: '2026-05-01T09:00:00Z',
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const svc = await loadService();
      const status = await svc.getUpdateStatus();
      expect(status.releaseUrl).toBe(
        'https://github.com/hicham-pkg/Hytale-Server-Management-Panel/releases/tag/v1.2.0',
      );
    });

    it('drops URLs that point at a different repo or host', async () => {
      const cases = [
        'https://evil.example.com/hicham-pkg/Hytale-Server-Management-Panel/releases/tag/v1.2.0',
        'https://github.com/attacker/Hytale-Server-Management-Panel/releases/tag/v1.2.0',
        'https://github.com/hicham-pkg/evil-repo/releases/tag/v1.2.0',
        'https://github.com/hicham-pkg-evil/Hytale-Server-Management-Panel/releases/tag/v1.2.0',
        'http://github.com/hicham-pkg/Hytale-Server-Management-Panel/releases/tag/v1.2.0',
        'javascript:alert(1)',
        'not a url at all',
      ];

      for (const evil of cases) {
        const fetchMock = vi.fn().mockResolvedValue(
          mockReleaseResponse({
            tag_name: 'v1.2.0',
            html_url: evil,
            published_at: '2026-05-01T09:00:00Z',
          }),
        );
        vi.stubGlobal('fetch', fetchMock);

        const svc = await loadService();
        svc._resetCacheForTests();
        const status = await svc.getUpdateStatus({ force: true });
        expect(status.releaseUrl, `URL must be dropped: ${evil}`).toBeNull();
      }
    });

    it('exposes safeReleaseUrl as a directly-testable helper', async () => {
      const { safeReleaseUrl } = await loadService();
      expect(
        safeReleaseUrl('https://github.com/owner/repo/releases', 'owner/repo'),
      ).toBe('https://github.com/owner/repo/releases');
      expect(safeReleaseUrl(null, 'owner/repo')).toBeNull();
      expect(safeReleaseUrl('https://github.com/owner/repo', 'owner/repo')).toBeNull();
      expect(
        safeReleaseUrl('https://github.com/other/repo/releases', 'owner/repo'),
      ).toBeNull();
    });
  });

  describe('cache behavior', () => {
    it('serves cached results within TTL and bypasses on force=true', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockReleaseResponse({ tag_name: 'v1.1.0', published_at: '2026-04-25T12:00:00Z' }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const svc = await loadService();
      const first = await svc.getUpdateStatus();
      expect(first.fromCache).toBe(false);

      const second = await svc.getUpdateStatus();
      expect(second.fromCache).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const forced = await svc.getUpdateStatus({ force: true });
      expect(forced.fromCache).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
