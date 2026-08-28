import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider, createTheme } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deletePostAction } from '@/lib/posts/actions';
import { PostListItem } from './post-list-item';

vi.mock('@/lib/posts/actions', () => ({
  deletePostAction: vi.fn(),
  interactAction: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(deletePostAction).mockClear();
});

const mine = { id: 'u-me', username: 'me', displayName: 'Me Myself' };
const reposter = { id: 'u-riko', username: 'riko', displayName: 'Riko' };
const post = {
  id: '9e8a7b6c-1234-4abc-9def-001122334455',
  authorId: mine.id,
  text: 'the original post body',
  media: [],
  replyToId: null,
  repostOfId: null,
  counts: { replies: 0, likes: 0, reposts: 0 },
  createdAt: '2026-08-27T09:00:00Z',
  deletedAt: null,
};

function renderItem(props: Partial<Parameters<typeof PostListItem>[0]> = {}) {
  return render(
    <MantineProvider theme={createTheme({})}>
      <PostListItem post={post} author={mine} repostedBy={reposter} canDelete {...props} />
    </MantineProvider>,
  );
}

// #145 at the card level: a reposted card shows the ORIGINAL author's
// byline with the reposter confined to the attribution line; list surfaces
// gate delete on post.authorId (the true author), so identity and the
// delete affordance always agree.
describe('PostListItem (#145 rendering + #146 delete)', () => {
  it('shows the true author byline with the reposter on the attribution line', () => {
    renderItem();
    const row = screen.getByTestId(`post-item-${post.id}-repost-${reposter.id}`);
    expect(row.textContent).toContain('@me');
    expect(row.textContent).toContain('Riko (@riko) reposted');
  });

  it("renders no overflow menu on someone else's card", () => {
    renderItem({ canDelete: false, repostedBy: undefined });
    expect(screen.queryByTestId(`post-overflow-${post.id}`)).toBeNull();
  });

  it('requires confirmation before the delete action runs', async () => {
    renderItem();

    fireEvent.click(screen.getByTestId(`post-overflow-${post.id}`));
    fireEvent.click(await screen.findByTestId(`post-overflow-delete-${post.id}`));

    // Dialog up, action not yet fired - a stray click cannot delete.
    expect(await screen.findByText('Delete post?')).toBeTruthy();
    expect(screen.getByTestId(`delete-post-${post.id}`)).toBeTruthy();
    expect(deletePostAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId(`delete-post-${post.id}`));
    await waitFor(() => {
      expect(deletePostAction).toHaveBeenCalledWith(expect.any(FormData));
    });
  });

  it('cancel dismisses the dialog without deleting', async () => {
    renderItem();

    fireEvent.click(screen.getByTestId(`post-overflow-${post.id}`));
    fireEvent.click(await screen.findByTestId(`post-overflow-delete-${post.id}`));
    fireEvent.click(await screen.findByTestId(`post-delete-cancel-${post.id}`));

    await waitFor(() => {
      expect(screen.queryByTestId(`delete-post-${post.id}`)).toBeNull();
    });
    expect(deletePostAction).not.toHaveBeenCalled();
  });
});
