import { describe, expect, it } from 'vitest';
import { ADMIN_ROLES, isAdminRole } from './admin.js';

describe('isAdminRole', () => {
  it('accepts each admin role', () => {
    for (const role of ADMIN_ROLES) {
      expect(isAdminRole([role])).toBe(true);
    }
  });

  it('rejects role-less and non-admin principals', () => {
    expect(isAdminRole([])).toBe(false);
    expect(isAdminRole(['demo-user'])).toBe(false);
    expect(isAdminRole(['user', 'editor'])).toBe(false);
  });

  it('ignores casing variants (roles are exact realm role names)', () => {
    expect(isAdminRole(['System-Admin'])).toBe(false);
  });
});
