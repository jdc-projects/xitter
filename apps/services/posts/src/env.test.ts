import { afterEach, describe, expect, it, vi } from 'vitest';

// The env module parses process.env at import time, so each case sets the
// environment then (re)imports - resetModules gives every case a fresh boot.
const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe('posts env: cross-service URLs (#113)', () => {
  it('keeps the localhost defaults in local/ephemeral envs', async () => {
    delete process.env.XITTER_ENV;
    delete process.env.XITTER_PORT_OFFSET;
    delete process.env.XITTER_SOCIAL_URL;
    delete process.env.XITTER_MEDIA_URL;

    const { env } = await import('./env.js');
    expect(env.XITTER_SOCIAL_URL).toBe('http://localhost:8101');
    expect(env.XITTER_MEDIA_URL).toBe('http://localhost:8103');
  });

  it('fails at boot in a deployed env, naming the missing var', async () => {
    process.env.XITTER_ENV = 'dev';
    delete process.env.XITTER_PORT_OFFSET;
    process.env.XITTER_SOCIAL_URL = 'http://social.xitter-dev.svc:8080';
    delete process.env.XITTER_MEDIA_URL;

    await expect(import('./env.js')).rejects.toThrow(
      /XITTER_MEDIA_URL is required in a deployed environment \(XITTER_ENV=dev\)/,
    );
  });

  it('boots a deployed env with both URLs set', async () => {
    process.env.XITTER_ENV = 'dev';
    process.env.XITTER_SOCIAL_URL = 'http://social.xitter-dev.svc:8080';
    process.env.XITTER_MEDIA_URL = 'http://media.xitter-dev.svc:8080';

    const { env } = await import('./env.js');
    expect(env.XITTER_MEDIA_URL).toBe('http://media.xitter-dev.svc:8080');
  });
});
