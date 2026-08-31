import { describe, expect, it } from 'vitest';

import { serviceEnvSchema } from './service-env.js';

describe('serviceEnv admin-path fields (#210)', () => {
  it('defaults the admin azp allowlist to the local admin-panel client', () => {
    const env = serviceEnvSchema('social').parse({});
    expect(env.ADMIN_CLIENTS).toBe('admin-panel');
    expect(env.ADMIN_REALM).toBe('xitter-local-admin');
  });

  it('accepts the deployed overrides the tofu wiring sets', () => {
    const env = serviceEnvSchema('feed').parse({
      ADMIN_REALM: 'jd-chapman.dev',
      ADMIN_ISSUER: 'https://idp.jd-chapman.dev/realms/jd-chapman.dev',
      ADMIN_CLIENTS: 'xitter-dev-admin-spa',
    });
    expect(env.ADMIN_ISSUER).toBe('https://idp.jd-chapman.dev/realms/jd-chapman.dev');
    // app.module splits the list for auth.guard's azp check
    expect(env.ADMIN_CLIENTS.split(',').map((c) => c.trim())).toEqual(['xitter-dev-admin-spa']);
  });

  it('rejects a non-URL ADMIN_ISSUER rather than failing at request time', () => {
    expect(() => serviceEnvSchema('posts').parse({ ADMIN_ISSUER: 'not-a-url' })).toThrow();
  });
});
