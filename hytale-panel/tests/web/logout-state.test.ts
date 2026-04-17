import { describe, expect, it, vi } from 'vitest';
import { performLogout } from '../../packages/web/src/lib/auth-session';

describe('client logout state clearing', () => {
  it('clears client auth state after a successful logout request', async () => {
    const logoutRequest = vi.fn().mockResolvedValue({ success: true });
    const clearClientAuthState = vi.fn();

    await performLogout(logoutRequest, clearClientAuthState);

    expect(logoutRequest).toHaveBeenCalledTimes(1);
    expect(clearClientAuthState).toHaveBeenCalledTimes(1);
  });

  it('still clears client auth state if the logout request fails', async () => {
    const logoutRequest = vi.fn().mockRejectedValue(new Error('network failure'));
    const clearClientAuthState = vi.fn();

    await expect(performLogout(logoutRequest, clearClientAuthState)).rejects.toThrow('network failure');
    expect(clearClientAuthState).toHaveBeenCalledTimes(1);
  });
});
