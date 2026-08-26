import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv } from '@xitter/config';
import { envSchema } from './env.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('media-process worker env: cross-service URLs (#113)', () => {
  it('keeps the localhost defaults in local/ephemeral envs', () => {
    delete process.env.XITTER_ENV;
    delete process.env.XITTER_PORT_OFFSET;
    const env = parseEnv(envSchema, {});
    expect(env.MEDIA_INTERNAL_URL).toBe('http://localhost:8103');
  });

  it('fails at boot in a deployed env, naming the missing var', () => {
    process.env.XITTER_ENV = 'dev';
    expect(() => parseEnv(envSchema, {})).toThrow(
      /MEDIA_INTERNAL_URL is required in a deployed environment \(XITTER_ENV=dev\)/,
    );
  });

  it('boots a deployed env with the internal URL set', () => {
    process.env.XITTER_ENV = 'dev';
    const env = parseEnv(envSchema, { MEDIA_INTERNAL_URL: 'http://media.svc:8080' });
    expect(env.MEDIA_INTERNAL_URL).toBe('http://media.svc:8080');
  });
});
