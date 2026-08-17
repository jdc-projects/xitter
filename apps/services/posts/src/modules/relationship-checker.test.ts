import { describe, expect, it } from 'vitest';
import { SocialRelationshipChecker } from './relationship-checker.js';

const CHECKER_OPTS = {
  baseUrl: 'http://social.local:8101',
  tokenUrl: 'http://keycloak.local:8090/realms/xitter-demo/protocol/openid-connect/token',
  clientId: 'svc-posts',
  clientSecret: 'svc-posts-local-secret',
};

const AUTHED_RESPONSE = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/**
 * Block-check wiring against a faked social upstream: token fetch, flags
 * mapping (blocking || blockedBy), and fail-closed on upstream errors.
 */
describe('SocialRelationshipChecker', () => {
  it('fetches an M2M token once and maps blocking flags', async () => {
    const tokenCalls: string[] = [];
    const relationshipCalls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/token')) {
        tokenCalls.push(url);
        return AUTHED_RESPONSE({ access_token: 'm2m-token', expires_in: 300 });
      }
      relationshipCalls.push(url);
      expect(init?.headers).toMatchObject({ authorization: 'Bearer m2m-token' });
      return AUTHED_RESPONSE({ following: false, followedBy: false, blocking: true, blockedBy: false });
    };

    const checker = new SocialRelationshipChecker({ ...CHECKER_OPTS, fetchImpl });
    await expect(checker.blockedEitherWay('a', 'b')).resolves.toBe(true);
    await expect(checker.blockedEitherWay('a', 'b')).resolves.toBe(true);

    expect(tokenCalls).toHaveLength(1); // jwt cache
    expect(relationshipCalls).toHaveLength(2); // one GET per check
    expect(relationshipCalls[0]).toBe(
      'http://social.local:8101/api/social/internal/users/a/relationships/b',
    );
  });

  it('is false when no block exists in either direction', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith('/token')) {
        return AUTHED_RESPONSE({ access_token: 't', expires_in: 300 });
      }
      return AUTHED_RESPONSE({ following: true, followedBy: true, blocking: false, blockedBy: false });
    };
    const checker = new SocialRelationshipChecker({ ...CHECKER_OPTS, fetchImpl });
    await expect(checker.blockedEitherWay('a', 'b')).resolves.toBe(false);
  });

  it('fails closed with a 503 envelope when social is unreachable', async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error('social down');
    };
    const checker = new SocialRelationshipChecker({ ...CHECKER_OPTS, fetchImpl });

    await expect(checker.blockedEitherWay('a', 'b')).rejects.toMatchObject({
      response: { error: { code: 'INTERNAL' } },
    });
  });

  it('fails closed when social answers with an error status', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith('/token')) {
        return AUTHED_RESPONSE({ access_token: 't', expires_in: 300 });
      }
      return new Response('{"error":{"code":"INTERNAL","message":"boom"}}', { status: 500 });
    };
    const checker = new SocialRelationshipChecker({ ...CHECKER_OPTS, fetchImpl });

    await expect(checker.blockedEitherWay('a', 'b')).rejects.toMatchObject({
      response: { error: { code: 'INTERNAL' } },
    });
  });
});
