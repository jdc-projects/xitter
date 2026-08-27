'use client';

import { Box } from '@mantine/core';
import type { Post } from '@xitter/api-contracts';
import { PostInteractions } from './post-interactions';

export interface PostListItemProps {
  post: Pick<Post, 'id' | 'text' | 'createdAt' | 'counts' | 'media'>;
  author: { id: string; username: string; displayName: string };
  /** Viewer's like/repost/bookmark flags for this post (batched viewer-state). */
  viewer?: { liked?: boolean; reposted?: boolean; bookmarked?: boolean };
  /** Repost attribution (feed repost entries). */
  repostedBy?: { id: string; username: string; displayName: string };
  /** Viewer's own post: the card's overflow menu (⋯) shows delete (#146). */
  canDelete?: boolean;
  /** Profile to revalidate after a delete (the card's host page). */
  username?: string;
  /** Redirect target after a delete (detail pages navigate away). */
  goTo?: string;
}

/**
 * Interactive post card for every list surface (#142/#146): the owner's
 * delete lives in the card's own overflow menu, and navigation rides the
 * card's stretched overlay link. The row wrapper only carries the feed-entry
 * testid - a post can appear twice in one feed (own entry + repost entry),
 * so selectors stay unique per row. Lists render thumbs; the detail page
 * passes originals.
 */
export function PostListItem({
  post,
  author,
  viewer,
  repostedBy,
  canDelete = false,
  username,
  goTo,
}: PostListItemProps) {
  return (
    <Box data-testid={`post-item-${post.id}${repostedBy ? `-repost-${repostedBy.id}` : ''}`}>
      <PostInteractions
        post={post}
        author={author}
        viewer={viewer ?? {}}
        repostedBy={repostedBy}
        variant="thumb"
        href={`/post/${post.id}`}
        canDelete={canDelete}
        username={username}
        goTo={goTo}
      />
    </Box>
  );
}
