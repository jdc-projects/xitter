import { describe, expect, it } from 'vitest';
import { deriveViewerState } from './viewer-state.js';

const uid = (n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`;

/** Unit: viewer-state derivation (#8) - the flag semantics live here. */
describe('deriveViewerState', () => {
  it('marks each requested post with the viewer flags', () => {
    const liked = uid('a1');
    const reposted = uid('a2');
    const both = uid('a3');

    const state = deriveViewerState(
      [liked, reposted, both],
      [
        { kind: 'like', postId: liked },
        { kind: 'repost', postId: reposted },
        { kind: 'bookmark', postId: both },
        { kind: 'like', postId: both },
      ],
    );

    expect(state).toEqual([
      { postId: liked, liked: true, reposted: false, bookmarked: false },
      { postId: reposted, liked: false, reposted: true, bookmarked: false },
      { postId: both, liked: true, reposted: false, bookmarked: true },
    ]);
  });

  it('returns all-false for ids with no interactions', () => {
    const id = uid('b1');
    expect(deriveViewerState([id], [{ kind: 'like', postId: uid('b2') }])).toEqual([
      { postId: id, liked: false, reposted: false, bookmarked: false },
    ]);
  });

  it('ignores unknown kinds (forward compatibility)', () => {
    const id = uid('c1');
    const state = deriveViewerState([id], [{ kind: 'view', postId: id }]);
    expect(state[0]).toMatchObject({ liked: false, reposted: false, bookmarked: false });
  });

  it('preserves the requested order and duplicates', () => {
    const first = uid('d1');
    const second = uid('d2');
    const state = deriveViewerState([second, first, second], []);
    expect(state.map((s) => s.postId)).toEqual([second, first, second]);
  });
});
