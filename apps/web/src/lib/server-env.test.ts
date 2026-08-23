import { afterEach, describe, expect, it } from 'vitest';
import { webEnv } from './server-env.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('webEnv captcha config', () => {
  it('fails fast when captcha is enabled without keys or urls', () => {
    process.env.XITTER_CAP_ENABLED = 'true';
    expect(() => webEnv()).toThrow(/XITTER_CAP_ENABLED=true requires/);
  });

  it('accepts a fully-configured captcha', () => {
    process.env.XITTER_CAP_ENABLED = 'true';
    process.env.XITTER_CAP_SITE_URL = 'https://cap.example';
    process.env.XITTER_CAP_VERIFY_URL = 'https://cap.example';
    process.env.XITTER_CAP_SITE_KEY = 'site-key';
    process.env.XITTER_CAP_SECRET_KEY = 'secret-key';

    expect(webEnv().cap).toMatchObject({
      enabled: true,
      siteUrl: 'https://cap.example',
      siteKey: 'site-key',
    });
  });

  it('leaves captcha urls empty by default - no hardcoded endpoints', () => {
    expect(webEnv().cap).toMatchObject({ enabled: false, siteUrl: '', verifyUrl: '' });
  });

  it('fails fast when a deployed environment (CAP_REQUIRED) boots without captcha', () => {
    process.env.XITTER_CAP_REQUIRED = 'true';
    expect(() => webEnv()).toThrow(/XITTER_CAP_REQUIRED=true but captcha is not enabled/);
  });

  it('boots a CAP_REQUIRED environment with a fully-configured captcha', () => {
    process.env.XITTER_CAP_REQUIRED = 'true';
    process.env.XITTER_CAP_ENABLED = 'true';
    process.env.XITTER_CAP_SITE_URL = 'https://cap.example';
    process.env.XITTER_CAP_VERIFY_URL = 'https://cap.example';
    process.env.XITTER_CAP_SITE_KEY = 'site-key';
    process.env.XITTER_CAP_SECRET_KEY = 'secret-key';

    expect(webEnv().cap.enabled).toBe(true);
  });

  it('keeps captcha optional when CAP_REQUIRED is unset (local stacks)', () => {
    expect(webEnv().cap.enabled).toBe(false);
  });
});
