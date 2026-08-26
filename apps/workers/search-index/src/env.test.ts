import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv } from '@xitter/config';
import { envSchema } from './env.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('search-index worker env: cross-service URLs (#113)', () => {
  it('keeps the localhost defaults in local/ephemeral envs', () => {
    delete process.env.XITTER_ENV;
    delete process.env.XITTER_PORT_OFFSET;
    const env = parseEnv(envSchema, {});
    expect(env.SEARCH_INTERNAL_URL).toBe('http://localhost:8105');
    expect(env.SOCIAL_INTERNAL_URL).toBe('http://localhost:8101');
  });

  it('fails at boot in a deployed env, naming the missing var', () => {
    // search-index's SOCIAL_INTERNAL_URL is exactly the gap tofu had: the
    // author-name refresh silently targeted localhost in every deployed env
    // until #113 wired it (infra workloads.tf worker_extra_env).
    process.env.XITTER_ENV = 'dev';
    expect(() =>
      parseEnv(envSchema, { SEARCH_INTERNAL_URL: 'http://search.xitter-dev.svc:8080' }),
    ).toThrow(/SOCIAL_INTERNAL_URL is required in a deployed environment \(XITTER_ENV=dev\)/);
  });

  it('boots a deployed env with both internal URLs set', () => {
    process.env.XITTER_ENV = 'prod';
    const env = parseEnv(envSchema, {
      SEARCH_INTERNAL_URL: 'http://search.svc:8080',
      SOCIAL_INTERNAL_URL: 'http://social.svc:8080',
    });
    expect(env.SOCIAL_INTERNAL_URL).toBe('http://social.svc:8080');
  });
});
