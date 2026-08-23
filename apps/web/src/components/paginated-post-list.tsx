'use client';

import { Stack } from '@mantine/core';
import type { Post } from '@xitter/api-contracts';
import { LoadMoreControl } from './load-more-control';
import { PostListItem } from './post-list-item';
import { useCursorPages, type CursorPage } from './use-cursor-pages';

/** Serializable card row: everything PostListItem needs, hydrated server-side. */
export interface PostCardItem {
  post: Post;
  author: { id: string; username: string; displayName: string };
  viewer?: { liked?: boolean; reposted?: boolean; bookmarked?: boolean };
  canDelete?: boolean;
  /** Profile to revalidate after a delete (the card's host page). */
  username?: string;
  /** Redirect target after a delete (detail pages navigate away). */
  goTo?: string;
}

export interface PaginatedPostListProps {
  /** SSR-rendered page 1; empty states stay server-side, before this list. */
  initialItems: PostCardItem[];
  initialCursor: string | null;
  /** Server action fetching one more page (#41: append in place, no navigation). */
  fetchPage: (cursor: string) => Promise<CursorPage<PostCardItem>>;
  /** The list container testid the page already exposed (search-results etc). */
  listTestId: string;
}

/**
 * Cursor-paginated post list used by search, bookmarks, profiles and reply
 * threads - the feed's client-side Load-more pattern on every surface that
 * used to do a full-page `?cursor=` anchor jump (#41).
 */
export function PaginatedPostList({
  initialItems,
  initialCursor,
  fetchPage,
  listTestId,
}: PaginatedPostListProps) {
  const { items, cursor, loading, error, loadMore } = useCursorPages(
    initialItems,
    initialCursor,
    fetchPage,
  );

  return (
    <>
      <Stack gap="md" data-testid={listTestId}>
        {items.map((item) => (
          <PostListItem
            key={item.post.id}
            post={item.post}
            author={item.author}
            viewer={item.viewer}
            canDelete={item.canDelete}
            username={item.username}
            goTo={item.goTo}
          />
        ))}
      </Stack>
      <LoadMoreControl
        cursor={cursor}
        loading={loading}
        error={error}
        onLoadMore={() => void loadMore()}
      />
    </>
  );
}
