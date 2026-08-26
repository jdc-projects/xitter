import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv } from '@xitter/config';
import { envSchema } from './env.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('fanout worker env: cross-service URLs (#113)', () => {
  it('keeps the localhost defaults in local/ephemeral envs', () => {
    delete process.env.XITTER_ENV;
    delete process.env.XITTER_PORT_OFFSET;
    const env = parseEnv(envSchema, {});
    expect(env.FEED_INTERNAL_URL).toBe('http://localhost:8104');
    expect(env.SOCIAL_INTERNAL_URL).toBe('http://localhost:8101');
    expect(env.POSTS_INTERNAL_URL).toBe('http://localhost:8102');
  });

  it('fails at boot in a deployed env, naming the missing var', () => {
    process.env.XITTER_ENV = 'dev';
    expect(() =>
      parseEnv(envSchema, {
        FEED_INTERNAL_URL: 'http://feed.xitter-dev.svc:8080',
        POSTS_INTERNAL_URL: 'http://posts.xitter-dev.svc:8080',
      }),
    ).toThrow(/SOCIAL_INTERNAL_URL is required in a deployed environment \(XITTER_ENV=dev\)/);
  });

  it('boots a deployed env with every internal URL set', () => {
    process.env.XITTER_ENV = 'prod';
    const env = parseEnv(envSchema, {
      FEED_INTERNAL_URL: 'http://feed.svc:8080',
      SOCIAL_INTERNAL_URL: 'http://social.svc:8080',
      POSTS_INTERNAL_URL: 'http://posts.svc:8080',
    });
    expect(env.SOCIAL_INTERNAL_URL).toBe('http://social.svc:8080');
  });
});
