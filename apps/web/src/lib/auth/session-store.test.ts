import { describe, expect, it } from 'vitest';
import { memoryStores } from './session-store.js';

describe('login-state store (single-use state)', () => {
  it('consumes the state on take - a replayed take returns nothing', async () => {
    const { logins } = memoryStores();
    await logins.set('state-1', { codeVerifier: 'verifier', nonce: 'nonce', next: '/feed' }, 600);

    await expect(logins.take('state-1')).resolves.toEqual({
      codeVerifier: 'verifier',
      nonce: 'nonce',
      next: '/feed',
    });
    await expect(logins.take('state-1')).resolves.toBeNull();
  });

  it('keeps states independent', async () => {
    const { logins } = memoryStores();
    await logins.set('state-a', { codeVerifier: 'a', nonce: 'n', next: '/feed' }, 600);
    await logins.set('state-b', { codeVerifier: 'b', nonce: 'n', next: '/profile' }, 600);

    await expect(logins.take('state-b')).resolves.toMatchObject({ codeVerifier: 'b' });
    await expect(logins.take('state-a')).resolves.toMatchObject({ codeVerifier: 'a' });
    await expect(logins.take('missing')).resolves.toBeNull();
  });
});
