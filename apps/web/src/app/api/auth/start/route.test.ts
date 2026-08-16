import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route.js';

const originalEnv = { ...process.env };

function setCapEnv(enabled: string) {
  process.env.XITTER_CAP_ENABLED = enabled;
  process.env.XITTER_CAP_SITE_URL = 'https://cap.example';
  process.env.XITTER_CAP_VERIFY_URL = 'https://cap.example';
  process.env.XITTER_CAP_SITE_KEY = 'site-key';
  process.env.XITTER_CAP_SECRET_KEY = 'secret-key';
  process.env.XITTER_WEB_BASE_URL = 'http://localhost:8280';
  process.env.XITTER_KEYCLOAK_URL = 'http://localhost:8290';
  process.env.XITTER_VALKEY_URL = 'redis://localhost:6579';
}

function startRequest(fields: Record<string, string> = {}): Request {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return new Request('http://localhost:8280/api/auth/start', { method: 'POST', body: form });
}

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

describe('POST /api/auth/start', () => {
  it('blocks the OIDC redirect when captcha verification fails', async () => {
    setCapEnv('true');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 200 })),
    );

    const response = await POST(startRequest({ next: '/feed', capToken: 'bad-token' }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('/login?error=captcha');
  });

  it('blocks the redirect when captcha is enabled but the token is missing', async () => {
    setCapEnv('true');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(startRequest({ next: '/feed' }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('/login?error=captcha');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
