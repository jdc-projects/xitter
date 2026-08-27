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
function renderCard(props: Parameters<typeof PostCard>[0]) {
  return render(
    <MantineProvider theme={createTheme({})}>
      <PostCard {...props} />
    </MantineProvider>,
  );
}

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
  });
});
