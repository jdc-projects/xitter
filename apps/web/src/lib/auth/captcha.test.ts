import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyCaptcha } from './captcha.js';

function mockCapEnv() {
  process.env.XITTER_CAP_ENABLED = 'true';
  process.env.XITTER_CAP_VERIFY_URL = 'https://cap.example';
  process.env.XITTER_CAP_SITE_KEY = 'site-key';
  process.env.XITTER_CAP_SECRET_KEY = 'secret-key';
}

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

describe('verifyCaptcha', () => {
  it('accepts a successful siteverify reply', async () => {
    mockCapEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(verifyCaptcha('good-token')).resolves.toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cap.example/site-key/siteverify');
    expect(JSON.parse(String(init.body))).toEqual({ secret: 'secret-key', response: 'good-token' });
  });

  it('rejects when the API answers success: false (invalid token)', async () => {
    mockCapEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 200 })),
    );
    await expect(verifyCaptcha('already-used-token')).resolves.toBe(false);
  });

  it('rejects on API errors (404 Token not found)', async () => {
    mockCapEnv();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Token not found', { status: 404 })),
    );
    await expect(verifyCaptcha('unknown-token')).resolves.toBe(false);
  });

  it('rejects on network failures - verification fails closed', async () => {
    mockCapEnv();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(verifyCaptcha('any-token')).resolves.toBe(false);
  });

  it('rejects empty tokens or missing keys without calling the API', async () => {
    mockCapEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(verifyCaptcha('')).resolves.toBe(false);

    delete process.env.XITTER_CAP_SECRET_KEY;
    await expect(verifyCaptcha('some-token')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
