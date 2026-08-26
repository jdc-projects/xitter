import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { crossServiceUrlSchema, isDeployedEnv, parseEnv } from './index.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('isDeployedEnv', () => {
  it.each(['dev', 'prod'])('treats %s as deployed', (env) => {
    expect(isDeployedEnv(env)).toBe(true);
  });

  it.each([undefined, 'local', 'ci', 't9'])(
    'treats %s as ephemeral (local defaults apply)',
    (env) => {
      expect(isDeployedEnv(env)).toBe(false);
    },
  );

  it('reads XITTER_ENV from the process by default', () => {
    process.env.XITTER_ENV = 'dev';
    expect(isDeployedEnv()).toBe(true);
    delete process.env.XITTER_ENV;
    expect(isDeployedEnv()).toBe(false);
  });
});

describe('crossServiceUrlSchema (#113: deployed envs fail fast on unset URLs)', () => {
  // One frozen schema, exercised in both modes: the strict/local decision
  // happens at parse time so an exported schema serves either environment.
  const schema = z.object({
    XITTER_MEDIA_URL: crossServiceUrlSchema('XITTER_MEDIA_URL', 'media'),
  });

  it('applies the localhost default in local/ephemeral envs', () => {
    delete process.env.XITTER_ENV;
    expect(parseEnv(schema, {})).toEqual({ XITTER_MEDIA_URL: 'http://localhost:8103' });
  });

  it('keeps an explicit env override locally', () => {
    delete process.env.XITTER_ENV;
    expect(parseEnv(schema, { XITTER_MEDIA_URL: 'http://edge:8080' })).toEqual({
      XITTER_MEDIA_URL: 'http://edge:8080',
    });
  });

  it('fails at boot in a deployed env, naming the missing var and the fix', () => {
    process.env.XITTER_ENV = 'dev';
    expect(() => parseEnv(schema, {})).toThrow(
      /XITTER_MEDIA_URL is required in a deployed environment \(XITTER_ENV=dev\).*ECONNREFUSED.*workloads\.tf/s,
    );
  });

  it('treats an empty value as missing in a deployed env', () => {
    process.env.XITTER_ENV = 'prod';
    expect(() => parseEnv(schema, { XITTER_MEDIA_URL: '' })).toThrow(
      /XITTER_MEDIA_URL is required in a deployed environment/,
    );
  });

  it('accepts a set URL in a deployed env', () => {
    process.env.XITTER_ENV = 'dev';
    expect(parseEnv(schema, { XITTER_MEDIA_URL: 'http://media.xitter-dev.svc:8080' })).toEqual({
      XITTER_MEDIA_URL: 'http://media.xitter-dev.svc:8080',
    });
  });

  it('still rejects a malformed URL in a deployed env', () => {
    process.env.XITTER_ENV = 'dev';
    expect(() => parseEnv(schema, { XITTER_MEDIA_URL: 'not-a-url' })).toThrow(
      /XITTER_MEDIA_URL: Invalid URL/,
    );
  });
});
