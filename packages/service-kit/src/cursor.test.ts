import { describe, expect, it } from 'vitest';
import { assertValidCursor, decodeCursor, encodeCursor } from './cursor.js';

describe('cursor codec', () => {
  const row = { createdAt: new Date('2026-08-18T09:00:00.000Z'), id: 'post-1' };

  it('round-trips a keyset position', () => {
    expect(decodeCursor(encodeCursor(row))).toEqual({
      createdAt: '2026-08-18T09:00:00.000Z',
      id: 'post-1',
    });
  });

  it('decodes non-cursor base64 to null', () => {
    expect(decodeCursor(Buffer.from('not a cursor').toString('base64url'))).toBeNull();
    expect(decodeCursor('%00zz-not-base64')).toBeNull();
    // Empty id decodes (it is still a string) but fails the valid-cursor check.
    expect(decodeCursor(encodeCursor({ createdAt: row.createdAt, id: '' }))).toEqual({
      createdAt: '2026-08-18T09:00:00.000Z',
      id: '',
    });
  });

  it('assertValidCursor accepts valid and absent cursors, rejects forged ones', () => {
    expect(() => assertValidCursor(undefined)).not.toThrow();
    expect(() => assertValidCursor(encodeCursor(row))).not.toThrow();

    const rejections = [
      '%00zz-not-base64',
      // Decodable JSON but not a date: would 500 in the query layer uncaught.
      Buffer.from(JSON.stringify({ createdAt: 'banana', id: 'x' }), 'utf8').toString('base64url'),
      // Decodable but empty id: not a real keyset position.
      encodeCursor({ createdAt: row.createdAt, id: '' }),
    ];
    for (const cursor of rejections) {
      try {
        assertValidCursor(cursor);
        expect.unreachable(`should have thrown for ${cursor}`);
      } catch (err) {
        expect((err as { getResponse: () => { error: { code: string } } }).getResponse()).toEqual(
          expect.objectContaining({ error: expect.objectContaining({ code: 'VALIDATION_ERROR' }) }),
        );
      }
    }
  });
});
