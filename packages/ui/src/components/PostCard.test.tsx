import { fireEvent, render, screen } from '@testing-library/react';
import { Anchor, MantineProvider, createTheme, UnstyledButton } from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';
import { PostCard } from './PostCard';

const author = { id: 'u1', username: 'alice', displayName: 'Alice' };
const post = {
  id: 'p1',
  text: 'hello overlay pattern',
  createdAt: '2026-08-25T12:00:00.000Z',
  counts: { replies: 3, likes: 5, reposts: 1 },
};

/** Mantine 9 components require the provider in the tree. */
function renderCard(props: Partial<Parameters<typeof PostCard>[0]> = {}) {
  return render(
    <MantineProvider theme={createTheme({})}>
      <PostCard author={author} post={post} href={`/post/${post.id}`} {...props} />
    </MantineProvider>,
  );
}

// #142: the card is not an anchor. Navigation rides a stretched overlay
// link so the browser :visited colour cannot bleed onto card text and
// interactive controls never nest inside a link. (fix(e2e,ui,a11y): repost attribution carries the handle; e2e asserts #145's true-author semantics; 24px menu trigger)
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
    expect(screen.getByTestId('post-repost-attribution-p1').textContent).toContain(
      'Riko (@riko) reposted',
    );
  });
});

// #147: replies in lists carry a "Replying to @x" context line in the same
// visual language as the repost attribution - present only when supplied.
describe('PostCard reply context (#147)', () => {
  it('renders "Replying to @x" above the text when replyingTo is present', () => {
    renderCard({
      replyingTo: { id: 'a2', username: 'parent', displayName: 'Parent' },
    });

    const context = screen.getByTestId('post-reply-context-p1');
    expect(context.textContent).toBe('Replying to @parent');
    // Above the post text: the context line precedes it in the DOM.
    const text = screen.getByText('hello overlay pattern');
    expect(context.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders no context line for top-level posts', () => {
    renderCard();
    expect(screen.queryByTestId('post-reply-context-p1')).toBeNull();
  });
});

describe('PostCard variant="ancestor" (#152)', () => {
  it('renders the compact thread-context card as a link, without a counts row', () => {
    renderCard({ variant: 'ancestor' });

    const card = screen.getByTestId('post-ancestor-p1');
    expect(card.textContent).toContain('Alice');
    expect(card.textContent).toContain('@alice');
    expect(card.textContent).toContain('hello overlay pattern');

    const link = screen.getByRole('link', { name: /alice: hello overlay pattern/i });
    expect(link.getAttribute('href')).toBe('/post/p1');

    // Compact context card: no interaction/count affordances.
    expect(screen.queryByTestId('count-replies')).toBeNull();
    expect(screen.queryByTestId('count-likes')).toBeNull();
  });

  it('wraps the card in an inherit-coloured link region, not a colourless anchor (#200)', () => {
    renderCard({ variant: 'ancestor' });
    const link = screen.getByRole('link', { name: /alice: hello overlay pattern/i });
    // Unlike the standard card's stretched overlay, the ancestor card's
    // text DOES live inside the link - so the wrapper must guarantee a
    // colour. UnstyledButton's stylesheet pins color:inherit + no
    // underline; the old `Anchor unstyled` carried no colour rule at all,
    // letting the browser's default blue/purple bleed onto the card text.
    expect(link.className).toContain(UnstyledButton.classes.root);
    expect(link.className).not.toContain(Anchor.classes.root);
    expect(link.style.display).toBe('block');
  });

  it('renders the standard card for the default and thumb/original variants', () => {
    const { rerender } = renderCard();
    expect(screen.getByTestId('post-p1')).toBeTruthy();
    expect(screen.getByTestId('count-replies')).toBeTruthy();

    rerender(
      <MantineProvider theme={createTheme({})}>
        <PostCard author={author} post={post} variant="thumb" href="/post/p1" />
      </MantineProvider>,
    );
    expect(screen.getByTestId('post-p1')).toBeTruthy();
    expect(screen.getByTestId('count-replies')).toBeTruthy();
  });
});
