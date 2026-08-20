/**
 * Admin-role gate, shared by the admin panel login (isAdminRole), the
 * service AuthGuard's admin-gated internal routes, and the realm
 * provisioner (which assigns the roles). One source so panel and APIs can
 * never disagree on what "admin" means (ADR 0006: only the system-admin and
 * app-admin roles may log in to admin/CMS).
 */
export const ADMIN_ROLES = ['system-admin', 'app-admin'] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];

/** True when the token's realm roles include any admin role. */
export function isAdminRole(roles: readonly string[]): boolean {
  return roles.some((role) => (ADMIN_ROLES as readonly string[]).includes(role));
}
