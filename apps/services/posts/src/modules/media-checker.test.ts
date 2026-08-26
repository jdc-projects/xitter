import { describe, expect, it } from 'vitest';
import type { MediaAsset } from '@xitter/api-contracts';
import { MediaServiceChecker } from './media-checker.js';

const CHECKER_OPTS = {
  baseUrl: 'http://media.local:8104',
  tokenUrl: 'http://keycloak.local:8090/realms/xitter-demo/protocol/openid-connect/token',
  clientId: 'svc-posts',
  clientSecret: 'svc-posts-local-secret',
};

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const MEDIA_ID = '00000000-0000-4000-8000-0000000003d1';

const asset = (overrides: Partial<MediaAsset> = {}): MediaAsset => ({
  id: MEDIA_ID,
  ownerId: OWNER,
  status: 'ready',
  variants: [],
  createdAt: '2026-08-18T00:00:00.000Z',
  ...overrides,
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/**
 * Attach-validation wiring against a faked media upstream: token fetch,
 * internal-lookup request shape, and fail-closed 503s when media cannot
 * answer (posts with images are rejected rather than guessing).
 */
describe('MediaServiceChecker', () => {
  it('POSTs the internal lookup with an M2M token and returns the resolved items', async () => {
    const tokenCalls: string[] = [];
    const lookups: { url: string; body: unknown; method?: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/token')) {
        tokenCalls.push(url);
        return jsonResponse({ access_token: 'm2m-token', expires_in: 300 });
      }
      lookups.push({ url, body: JSON.parse(String(init?.body)), method: init?.method });
      expect(init?.headers).toMatchObject({ authorization: 'Bearer m2m-token' });
      return jsonResponse({ items: [asset()] });
    };

    const checker = new MediaServiceChecker({ ...CHECKER_OPTS, fetchImpl });
    await expect(checker.resolveForAttach(OWNER, [MEDIA_ID])).resolves.toEqual([asset()]);
    await expect(checker.resolveForAttach(OWNER, [MEDIA_ID])).resolves.toEqual([asset()]);

    expect(tokenCalls).toHaveLength(1); // client-credentials token is cached
    expect(lookups).toHaveLength(2); // one lookup per call
    expect(lookups[0]).toEqual({
      url: 'http://media.local:8104/api/media/internal/media/lookup',
      body: { ownerId: OWNER, mediaIds: [MEDIA_ID] },
      method: 'POST',
    });
  });

  it('fails closed with a 503 envelope when media is unreachable', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED 10.42.7.19:8104');
    };
    const checker = new MediaServiceChecker({ ...CHECKER_OPTS, fetchImpl });

    await expect(checker.resolveForAttach(OWNER, [MEDIA_ID])).rejects.toMatchObject({
      status: 503,
      response: { error: { code: 'INTERNAL' } },
    });
  });

  it('fails closed when media answers with an error status', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith('/token')) {
        return jsonResponse({ access_token: 't', expires_in: 300 });
      }
      return new Response('{"error":{"code":"INTERNAL","message":"boom"}}', { status: 503 });
    };
    const checker = new MediaServiceChecker({ ...CHECKER_OPTS, fetchImpl });

    await expect(checker.resolveForAttach(OWNER, [MEDIA_ID])).rejects.toMatchObject({
      status: 503,
      response: { error: { code: 'INTERNAL' } },
    });
  });
});
