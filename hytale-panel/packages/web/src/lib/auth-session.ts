export const PROTECTED_ROUTE_PREFIXES = [
  '/dashboard',
  '/console',
  '/whitelist',
  '/bans',
  '/backups',
  '/crashes',
  '/audit',
  '/settings',
] as const;

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

export async function performLogout(
  logoutRequest: () => Promise<unknown>,
  clearClientAuthState: () => void
): Promise<void> {
  try {
    await logoutRequest();
  } finally {
    clearClientAuthState();
  }
}
