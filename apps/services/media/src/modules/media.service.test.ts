import { describe, expect, it } from 'vitest';
import { MediaService } from './media.service.js';

describe('MediaService (skeleton)', () => {
  it('returns a media shape', () => {
    expect(new MediaService().getMedia('abc')).toEqual({ id: 'abc', status: 'pending' });
  });
});
