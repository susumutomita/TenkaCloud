import type { Session } from 'next-auth';

const APPLICATION_ADMIN_ROLES = [
  'admin',
  'platform-admin',
  'tenant-admin',
  'organizer',
] as const;

export function parseAuthSkipRoles(envValue?: string): string[] {
  if (!envValue) {
    return ['participant'];
  }

  const roles = envValue
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);

  return roles.length > 0 ? roles : ['participant'];
}

export function hasApplicationAdminRole(
  sessionOrRoles: Session | string[] | null | undefined,
): boolean {
  const roles = Array.isArray(sessionOrRoles)
    ? sessionOrRoles
    : sessionOrRoles?.roles;

  if (!roles || roles.length === 0) {
    return false;
  }

  return APPLICATION_ADMIN_ROLES.some((role) => roles.includes(role));
}
