import { describe, expect, it } from 'vitest';
import { SearchService } from './search.service.js';

describe('SearchService (skeleton)', () => {
  it('returns an empty page shape', () => {
    expect(new SearchService().placeholder()).toEqual({ items: [], nextCursor: null });
  });
});
