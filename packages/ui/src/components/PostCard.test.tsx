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

function renderCard(props: Parameters<typeof PostCard>[0]) {
  return render(
    <MantineProvider theme={createTheme({})}>
      <PostCard {...props} />
    </MantineProvider>,
  );
}

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
  });
});
