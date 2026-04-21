import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiPost, apiRequest, setCsrfToken } from '../../packages/web/src/lib/api-client';

describe('web api client', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: {
          get: () => 'application/json',
        },
        text: async () => JSON.stringify({ success: true, data: { ok: true } }),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setCsrfToken('');
  });

  it('sends an explicit empty JSON object for body-less POST requests', async () => {
    setCsrfToken('csrf-token');

    await apiPost('/api/auth/setup-totp');

    expect(fetch).toHaveBeenCalledWith('/api/auth/setup-totp', {
      method: 'POST',
      body: '{}',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': 'csrf-token',
      },
    });
  });

  it('surfaces structured route errors from a non-2xx JSON response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        headers: {
          get: () => 'application/json',
        },
        text: async () => JSON.stringify({
          success: false,
          data: {
            message: 'Helper socket unavailable inside API container',
            degraded: true,
            dependency: 'helper',
          },
        }),
      })
    );

    const result = await apiRequest('/api/server/start', { method: 'POST', body: '{}' });

    expect(result).toEqual({
      success: false,
      error: 'Helper socket unavailable inside API container',
      statusCode: 503,
      degraded: true,
      dependency: 'helper',
    });
  });

  it('preserves 202 Accepted success payloads for async job enqueue routes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 202,
        headers: {
          get: () => 'application/json',
        },
        text: async () => JSON.stringify({
          success: true,
          data: {
            job: {
              id: '550e8400-e29b-41d4-a716-4466554400aa',
              type: 'create',
              status: 'queued',
            },
          },
        }),
      })
    );

    const result = await apiRequest('/api/backups/create', { method: 'POST', body: '{}' });

    expect(result).toEqual({
      success: true,
      data: {
        job: {
          id: '550e8400-e29b-41d4-a716-4466554400aa',
          type: 'create',
          status: 'queued',
        },
      },
      statusCode: 202,
    });
  });
});
