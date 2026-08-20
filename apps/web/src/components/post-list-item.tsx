'use client';

import { Stack } from '@mantine/core';
import type { Post } from '@xitter/api-contracts';
import { DeletePostButton } from './delete-post-button';
import { PostInteractions } from './post-interactions';

export interface PostListItemProps {
  post: Pick<Post, 'id' | 'text' | 'createdAt' | 'counts' | 'media'>;
  author: { id: string; username: string; displayName: string };
  /** Viewer's like/repost/bookmark flags for this post (batched viewer-state). */
  viewer?: { liked?: boolean; reposted?: boolean; bookmarked?: boolean };
  /** Repost attribution (feed repost entries). */
  repostedBy?: { id: string; username: string; displayName: string };
  /** Viewer's own post: render the delete affordance. */
  canDelete?: boolean;
  /** Profile to revalidate after a delete (the card's host page). */
  username?: string;
  /** Redirect target after delete (detail pages navigate away). */
  goTo?: string;
}

/**
 * Interactive post card + (own posts) delete, for every list surface. The
 * delete button sits below the card so it never nests a form inside the
 * card's own anchor. Lists render thumbs; the detail page passes originals.
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
    <Stack gap={4} data-testid={`post-item-${post.id}`}>
      <PostInteractions
        post={post}
        author={author}
        viewer={viewer ?? {}}
        repostedBy={repostedBy}
        variant="thumb"
        href={`/post/${post.id}`}
      />
      {canDelete ? <DeletePostButton postId={post.id} username={username} goTo={goTo} /> : null}
    </Stack>
  );
}
