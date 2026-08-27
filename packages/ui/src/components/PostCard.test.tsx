import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider, createTheme } from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';
import { PostCard } from './PostCard';

const author = { id: 'a1', username: 'alice', displayName: 'Alice Gee' };
const post = {
  id: 'p1',
  text: 'hello overlay pattern',
  createdAt: '2026-08-20T10:00:00Z',
  counts: { replies: 1, likes: 2, reposts: 3 },
};

function renderCard(props: Partial<Parameters<typeof PostCard>[0]> = {}) {
  return render(
    <MantineProvider theme={createTheme({})}>
      <PostCard author={author} post={post} href={`/post/${post.id}`} {...props} />
    </MantineProvider>,
  );
}

// #142: the card is not an anchor. Navigation rides a stretched overlay
// link so the browser :visited colour cannot bleed onto card text and
// interactive controls never nest inside a link.
describe('PostCard overlay link (#142)', () => {
  it('navigates via a stretched overlay anchor with an accessible name', () => {
    renderCard();
    const link = screen.getByTestId('post-link-p1');
    expect(link.getAttribute('href')).toBe('/post/p1');
    expect(link.getAttribute('aria-label')).toBe('View post by @alice');
  });

  it('keeps every text node outside the anchor - nothing for :visited to colour', () => {
    renderCard();
    const link = screen.getByTestId('post-link-p1');
    expect(link.textContent).toBe('');
    // The card still renders its own text (below the overlay).
    expect(screen.getByTestId('post-p1').textContent).toContain('hello overlay pattern');
  });

  it('keeps interaction buttons outside the anchor and above the overlay', () => {
    renderCard({ onInteract: vi.fn() });
    const link = screen.getByTestId('post-link-p1');
    const like = screen.getByTestId('count-likes');
    expect(link.contains(like)).toBe(false);
    // Positioned with a z-index above the overlay so clicks reach the
    // button instead of the navigation link.
    expect(like.style.position).toBe('relative');
    expect(like.style.zIndex).toBe('2');
  });

  it('fires interaction handlers without navigating', () => {
    const onInteract = vi.fn();
    renderCard({ onInteract });
    fireEvent.click(screen.getByTestId('count-likes'));
    expect(onInteract).toHaveBeenCalledWith('like', false);
  });

  it('renders no overlay anchor when the card has no href', () => {
    render(
      <MantineProvider theme={createTheme({})}>
        <PostCard author={author} post={post} />
      </MantineProvider>,
    );
    expect(screen.queryByTestId('post-link-p1')).toBeNull();
  });
});

// #146: card-level controls ride the actions slot, rendered on the card
// but outside (and above) the overlay link.
describe('PostCard actions slot (#146)', () => {
  it('renders the slot inside the card, outside the overlay anchor', () => {
    renderCard({
      actions: (
        <button type="button" data-testid="card-action">
          options
        </button>
      ),
    });
    const card = screen.getByTestId('post-p1');
    const slot = screen.getByTestId('card-action');
    expect(card.contains(slot)).toBe(true);
    expect(screen.getByTestId('post-link-p1').contains(slot)).toBe(false);
  });

  it('renders the repost attribution line (the reposter, not the author)', () => {
    renderCard({ repostedBy: { id: 'r1', username: 'riko', displayName: 'Riko' } });
    expect(screen.getByTestId('post-repost-attribution-p1').textContent).toContain('Riko reposted');
  });
});
