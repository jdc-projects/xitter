import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTokenVerifier } from './verify.js';

const ISSUER = 'http://kc:8090/realms/xitter-demo';

// jose is ESM-only and this package typechecks as CJS (see verify.ts) - the
// test helpers are loaded dynamically behind a minimal structural type.
interface SignJWTBuilder {
  setProtectedHeader(header: Record<string, unknown>): SignJWTBuilder;
  setIssuer(issuer: string): SignJWTBuilder;
  setIssuedAt(): SignJWTBuilder;
  setSubject(sub: string): SignJWTBuilder;
  setExpirationTime(exp: string): SignJWTBuilder;
  sign(key: CryptoKey): Promise<string>;
}

interface JoseTestKit {
  exportJWK(key: CryptoKey): Promise<Record<string, unknown>>;
  generateKeyPair(alg: 'RS256'): Promise<{ publicKey: CryptoKey; privateKey: CryptoKey }>;
  SignJWT: new (payload: Record<string, unknown>) => SignJWTBuilder;
}

let jose: JoseTestKit;

beforeAll(async () => {
  jose = (await import('jose')) as unknown as JoseTestKit;
});

/** Fresh keypair per test; the JWKS is served by stubbing fetch (jose's
 * remote set resolves the global at request time). */
async function mintKey(): Promise<CryptoKey> {
  const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
  const jwk = await jose.exportJWK(publicKey);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })),
  );
  return privateKey;
}

async function signToken(
  privateKey: CryptoKey,
  header: { typ?: string },
  claims: Record<string, unknown>,
): Promise<string> {
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', ...header })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setSubject('user-1')
    .setExpirationTime('5m')
    .sign(privateKey);
}

const USER_CLAIMS = {
  preferred_username: 'demo1',
  azp: 'web',
  realm_access: { roles: ['demo-user'] },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createTokenVerifier', () => {
  it('verifies an access token and maps claims', async () => {
    const privateKey = await mintKey();
    const verifier = createTokenVerifier({ issuer: ISSUER });
    const token = await signToken(privateKey, { typ: 'Bearer' }, USER_CLAIMS);

    await expect(verifier.verify(token)).resolves.toMatchObject({
      subject: 'user-1',
      username: 'demo1',
      roles: ['demo-user'],
    });
  });

  it('accepts tokens without a typ header (other providers)', async () => {
    const privateKey = await mintKey();
    const verifier = createTokenVerifier({ issuer: ISSUER });
    const token = await signToken(privateKey, {}, USER_CLAIMS);

    await expect(verifier.verify(token)).resolves.toMatchObject({ subject: 'user-1' });
  });

  it('rejects ID tokens even though they verify and carry azp=web', async () => {
    const privateKey = await mintKey();
    const verifier = createTokenVerifier({ issuer: ISSUER });
    const idToken = await signToken(privateKey, { typ: 'ID' }, USER_CLAIMS);

    await expect(verifier.verify(idToken)).rejects.toThrow(/access token/);
  });

  it('enforces the audience constraint for service verifiers', async () => {
    const privateKey = await mintKey();
    const verifier = createTokenVerifier({ issuer: ISSUER, audience: 'svc-social' });

    const good = await signToken(privateKey, { typ: 'Bearer' }, { aud: 'svc-social' });
    await expect(verifier.verify(good)).resolves.toMatchObject({ audience: 'svc-social' });

    const wrong = await signToken(privateKey, { typ: 'Bearer' }, { aud: 'svc-posts' });
    await expect(verifier.verify(wrong)).rejects.toThrow();
  });

  it('rejects tokens from another issuer', async () => {
    const privateKey = await mintKey();
    const verifier = createTokenVerifier({ issuer: ISSUER });
    const foreign = await new jose.SignJWT(USER_CLAIMS)
      .setProtectedHeader({ alg: 'RS256', typ: 'Bearer' })
      .setIssuer('http://evil:1/realms/other')
      .setIssuedAt()
      .setSubject('user-1')
      .setExpirationTime('5m')
      .sign(privateKey);

    await expect(verifier.verify(foreign)).rejects.toThrow();
  });
});
