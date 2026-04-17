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
        headers: {
          get: () => 'application/json',
        },
        text: async () => JSON.stringify({
          success: false,
          data: { message: 'Helper socket unavailable inside API container' },
        }),
      })
    );

    const result = await apiRequest('/api/server/start', { method: 'POST', body: '{}' });

    expect(result).toEqual({
      success: false,
      error: 'Helper socket unavailable inside API container',
    });
  });
});
