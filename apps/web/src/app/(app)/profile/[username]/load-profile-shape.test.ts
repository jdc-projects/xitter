import { describe, expect, it } from 'vitest';
import { isValidUsername } from './load-profile';

/**
 * Contract-shape guard (audit #32): malformed usernames must resolve to the
 * 404 page, never the 500 error boundary the social API's Zod 400 produced.
 * Mirrors usernameSchema: 3-20 chars, [a-z0-9_].
 */
describe('isValidUsername (audit #32 malformed-username 404s)', () => {
  it('accepts contract-shaped usernames', () => {
    expect(['demo1', 'demo10', 'alice_w', 'a12', 'x'.repeat(20)].map(isValidUsername)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('rejects shape violations before the social API is called', () => {
    expect(
      [
        'ab', // too short
        'x'.repeat(21), // too long
        'UPPER_case', // uppercase
        'bad!', // invalid char
        'has space', // invalid char
        '', // empty
      ].map(isValidUsername),
    ).toEqual([false, false, false, false, false, false]);
  });
});
