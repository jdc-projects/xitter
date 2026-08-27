<<<<<<< HEAD
import { render, screen } from '@testing-library/react';
import { MantineProvider, createTheme } from '@mantine/core';
import { describe, expect, it } from 'vitest';
import { PostCard } from './PostCard';

const author = { id: 'a1', username: 'author', displayName: 'Author' };
const post = {
  id: 'p1',
  text: 'hello world',
  createdAt: '2026-08-27T12:00:00.000Z',
  counts: { replies: 0, likes: 0, reposts: 0 },
};

=======
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MantineProvider, createTheme } from '@mantine/core';
import { PostCard } from './PostCard';

const author = { id: 'u1', username: 'alice', displayName: 'Alice' };
const post = {
  id: 'p1',
  text: 'the root of a thread',
  createdAt: '2026-08-25T12:00:00.000Z',
  counts: { replies: 3, likes: 5, reposts: 1 },
};

/** Mantine 9 components require the provider in the tree. */
>>>>>>> f253934 (feat(web,ui): thread view - ancestor chain + nested reply tree (#152 T2+T3))
function renderCard(props: Parameters<typeof PostCard>[0]) {
  return render(
    <MantineProvider theme={createTheme({})}>
      <PostCard {...props} />
    </MantineProvider>,
  );
}

<<<<<<< HEAD
// #147: replies in lists carry a "Replying to @x" context line in the same
// visual language as the repost attribution - present only when supplied.
describe('PostCard reply context (#147)', () => {
  it('renders "Replying to @x" above the text when replyingTo is present', () => {
    renderCard({
      author,
      post,
      replyingTo: { id: 'a2', username: 'parent', displayName: 'Parent' },
    });

    const context = screen.getByTestId('post-reply-context-p1');
    expect(context.textContent).toBe('Replying to @parent');
    // Above the post text: the context line precedes it in the DOM.
    const text = screen.getByText('hello world');
    expect(context.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders no context line for top-level posts', () => {
    renderCard({ author, post });

    expect(screen.queryByTestId('post-reply-context-p1')).toBeNull();
=======
describe('PostCard variant="ancestor" (#152)', () => {
  it('renders the compact thread-context card as a link, without a counts row', () => {
    renderCard({ author, post, variant: 'ancestor', href: '/post/p1' });

    const card = screen.getByTestId('post-ancestor-p1');
    expect(card.textContent).toContain('Alice');
    expect(card.textContent).toContain('@alice');
    expect(card.textContent).toContain('the root of a thread');

    const link = screen.getByRole('link', { name: /alice: the root of a thread/i });
    expect(link.getAttribute('href')).toBe('/post/p1');

    // Compact context card: no interaction/count affordances.
    expect(screen.queryByTestId('count-replies')).toBeNull();
    expect(screen.queryByTestId('count-likes')).toBeNull();
  });

  it('renders the standard card for the default and thumb/original variants', () => {
    const { rerender } = renderCard({ author, post });
    expect(screen.getByTestId('post-p1')).toBeTruthy();
    expect(screen.getByTestId('count-replies')).toBeTruthy();

    rerender(
      <MantineProvider theme={createTheme({})}>
        <PostCard author={author} post={post} variant="thumb" />
      </MantineProvider>,
    );
    expect(screen.getByTestId('post-p1')).toBeTruthy();
    expect(screen.getByTestId('count-replies')).toBeTruthy();
>>>>>>> f253934 (feat(web,ui): thread view - ancestor chain + nested reply tree (#152 T2+T3))
  });
});
