import { describe, expect, it } from 'vitest';
import { PostsService } from './posts.service.js';

describe('PostsService (skeleton)', () => {
  it('returns a post shape', () => {
    expect(new PostsService().getPost('abc')).toEqual({ id: 'abc' });
  });
});
