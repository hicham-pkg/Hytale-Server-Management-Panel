import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfig } from '../config';

/**
 * Panel update checker.
 *
 * Polls the GitHub Releases API for the configured repo and reports whether a
 * newer panel release is available. Read-only — never installs anything.
 *
 * Token handling:
 *   GITHUB_UPDATE_TOKEN is read from the API container's env. It is sent only
 *   on the outbound request to api.github.com as an Authorization header. It
 *   is NEVER included in any response payload, log line, or audit-log detail.
 *
 * Caching:
 *   Successful results are cached in-process for `panelUpdateCacheMinutes`.
 *   `force=true` bypasses the cache. Failures are not cached so a transient
 *   GitHub outage doesn't get pinned in.
 */

export interface UpdateStatus {
  currentVersion: string;
  currentCommit?: string;
  latestVersion: string | null;
  latestTag: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  prerelease: boolean;
  checkedAt: string;
  fromCache: boolean;
  error?: string;
}

const GITHUB_API_BASE = 'https://api.github.com';
const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT = 'hytale-panel-update-checker';

let cachedStatus: { status: UpdateStatus; expiresAt: number } | null = null;
let warnedAboutMissingVersion = false;

/**
 * Resolve the running panel version.
 *
 * Source of truth (in priority order):
 *   1. process.env.PANEL_VERSION    — explicit deploy-time override
 *   2. <api package>/package.json   — the API workspace's version field
 *
 * Why the api workspace's package.json: the repo's root package.json is
 * `private: true` with no version field (it's a pnpm-workspace orchestrator).
 * The five workspace package.jsons (api/helper/web/shared/scripts) share a
 * single version and are bumped together at every release (see commit
 * 8845097 / tag v1.1.0). The api workspace is the natural runtime source
 * because it's the package this code actually runs in: when the API container
 * is built via `pnpm deploy`, `packages/api/package.json` ends up at
 * `/app/package.json`, which is what the path resolution below targets.
 *
 * Override with `PANEL_VERSION` only when the runtime can't read its own
 * package.json (binary release, custom bundler that strips JSON, etc.) or
 * when you want the panel to advertise a build label that differs from the
 * api package's recorded version (e.g. `1.1.0+rebuild.3`).
 */
export function getCurrentVersion(): string {
  if (process.env.PANEL_VERSION) {
    return process.env.PANEL_VERSION;
  }

  // dist/services/update-checker.service.js  →  ../../package.json (api pkg)
  // src/services/update-checker.service.ts   →  ../../package.json (api pkg)
  const candidates = [
    path.resolve(__dirname, '..', '..', 'package.json'),
    path.resolve(__dirname, '..', 'package.json'),
  ];

  for (const candidate of candidates) {
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      // try next candidate
    }
  }

  if (!warnedAboutMissingVersion) {
    // eslint-disable-next-line no-console
    console.warn(
      '[update-checker] could not resolve panel version from package.json; ' +
        'set PANEL_VERSION at deploy time to silence this warning',
    );
    warnedAboutMissingVersion = true;
  }
  return 'unknown';
}

/**
 * Compare two semver-shaped strings. Returns -1 if a<b, 0 if equal, 1 if a>b.
 * Tolerates a leading "v" and ignores prerelease suffixes (treats them as
 * earlier than the same MAJOR.MINOR.PATCH without suffix).
 */
export function compareSemver(a: string, b: string): number {
  const parse = (s: string): { core: number[]; pre: string } => {
    const stripped = s.trim().replace(/^v/i, '');
    const [core, pre = ''] = stripped.split('-', 2);
    const parts = core.split('.').map((p) => {
      const n = parseInt(p, 10);
      return Number.isFinite(n) ? n : 0;
    });
    while (parts.length < 3) parts.push(0);
    return { core: parts.slice(0, 3), pre };
  };

  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i++) {
    if (A.core[i] !== B.core[i]) {
      return A.core[i] < B.core[i] ? -1 : 1;
    }
  }
  // Same core — released > prerelease
  if (A.pre === B.pre) return 0;
  if (!A.pre && B.pre) return 1;
  if (A.pre && !B.pre) return -1;
  return A.pre < B.pre ? -1 : 1;
}

interface GithubReleaseResponse {
  tag_name?: string;
  name?: string;
  html_url?: string;
  published_at?: string;
  prerelease?: boolean;
  draft?: boolean;
}

/**
 * Confirm a release URL actually points at the configured repo on github.com.
 * The frontend renders this URL as a clickable link; we don't want a malformed
 * GitHub response (or a token misconfigured against a different repo) to
 * surface a link that takes admins anywhere except the panel's own release
 * page. Returns the original URL if it passes, otherwise null.
 */
export function safeReleaseUrl(url: string | null | undefined, repo: string): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.host !== 'github.com') return null;
  // Require the path to begin with /{owner}/{repo}/ — strict prefix match so
  // /{owner}-evil/{repo}/... or /{owner}/{repo}-evil/... cannot slip through.
  const expectedPrefix = `/${repo}/`;
  if (!parsed.pathname.startsWith(expectedPrefix)) return null;
  return url;
}

async function fetchLatestRelease(repo: string, token: string | undefined): Promise<GithubReleaseResponse> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${GITHUB_API_BASE}/repos/${repo}/releases/latest`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      // Don't echo response bodies that could contain rate-limit details with
      // remaining tokens or anything sensitive — just the status.
      throw new Error(`GitHub API responded ${res.status}`);
    }

    const json = (await res.json()) as GithubReleaseResponse;
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns the current update status. Uses cache unless `force` is true.
 * Always includes currentVersion. On API failure, returns a status with
 * `error` set and the rest of the fields nulled — never throws.
 */
export async function getUpdateStatus(options: { force?: boolean } = {}): Promise<UpdateStatus> {
  const config = getConfig();
  const now = Date.now();

  if (!options.force && cachedStatus && cachedStatus.expiresAt > now) {
    return { ...cachedStatus.status, fromCache: true };
  }

  const currentVersion = getCurrentVersion();
  const currentCommit = process.env.PANEL_BUILD_COMMIT;

  const baseStatus: UpdateStatus = {
    currentVersion,
    currentCommit,
    latestVersion: null,
    latestTag: null,
    updateAvailable: false,
    releaseUrl: null,
    releaseName: null,
    publishedAt: null,
    prerelease: false,
    checkedAt: new Date(now).toISOString(),
    fromCache: false,
  };

  try {
    const release = await fetchLatestRelease(
      config.panelUpdateRepo,
      config.githubUpdateToken,
    );

    if (release.draft) {
      // Draft releases are not visible via /releases/latest in practice, but
      // be defensive: treat as "no release".
      const status: UpdateStatus = { ...baseStatus, error: 'Latest release is a draft' };
      // Don't cache an error.
      return status;
    }

    const latestTag = release.tag_name ?? null;
    const latestVersion = latestTag ? latestTag.replace(/^v/i, '') : null;
    const updateAvailable =
      !!latestVersion &&
      currentVersion !== 'unknown' &&
      compareSemver(latestVersion, currentVersion) > 0;

    const status: UpdateStatus = {
      ...baseStatus,
      latestTag,
      latestVersion,
      updateAvailable,
      releaseUrl: safeReleaseUrl(release.html_url, config.panelUpdateRepo),
      releaseName: release.name ?? null,
      publishedAt: release.published_at ?? null,
      prerelease: release.prerelease === true,
    };

    cachedStatus = {
      status,
      expiresAt: now + config.panelUpdateCacheMinutes * 60_000,
    };
    return status;
  } catch (err) {
    // Normalize the error message — we don't want to surface raw fetch errors
    // (which can contain hostnames, ports, or token-bearing URL fragments).
    const message =
      err instanceof Error && /GitHub API responded (\d+)/.test(err.message)
        ? err.message
        : 'GitHub release check failed';
    return { ...baseStatus, error: message };
  }
}

/** Test-only: drop the cache. Not exported via the route layer. */
export function _resetCacheForTests(): void {
  cachedStatus = null;
  warnedAboutMissingVersion = false;
}
