'use client';

import { Anchor, Stack } from '@mantine/core';
import { PostCard } from '@xitter/ui';
import { DeletePostButton } from './delete-post-button';

export interface PostListItemProps {
  post: {
    id: string;
    text: string;
    createdAt: string;
    counts: { replies: number; likes: number; reposts: number };
  };
  author: { id: string; username: string; displayName: string };
  /** Viewer's own post: render the delete affordance. */
  canDelete?: boolean;
  /** Profile to revalidate after a delete (the card's host page). */
  username?: string;
  /** Redirect target after delete (detail pages navigate away). */
  goTo?: string;
}

/**
 * PostCard + navigation to the detail page + (own posts) delete. The delete
 * button sits below the card so it never nests a form inside the anchor.
 */
export function PostListItem({
  post,
  author,
  canDelete = false,
  username,
  goTo,
}: PostListItemProps) {
  return (
    <Stack gap={4} data-testid={`post-item-${post.id}`}>
      <Anchor href={`/post/${post.id}`} unstyled style={{ textDecoration: 'none' }}>
        <PostCard author={author} post={post} />
      </Anchor>
      {canDelete ? <DeletePostButton postId={post.id} username={username} goTo={goTo} /> : null}
    </Stack>
  );
}
