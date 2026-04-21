import { describe, expect, it } from 'vitest';
import { isAdminOnlyPath, isProtectedPath } from '../../packages/web/src/lib/auth-session';

describe('auth session route classification', () => {
  it('classifies protected routes correctly', () => {
    expect(isProtectedPath('/dashboard')).toBe(true);
    expect(isProtectedPath('/dashboard/live')).toBe(true);
    expect(isProtectedPath('/login')).toBe(false);
  });

  it('classifies admin-only routes correctly', () => {
    expect(isAdminOnlyPath('/audit')).toBe(true);
    expect(isAdminOnlyPath('/settings/users')).toBe(true);
    expect(isAdminOnlyPath('/backups')).toBe(false);
    expect(isAdminOnlyPath('/dashboard')).toBe(false);
  });
});
