'use client';

import { Anchor, Stack } from '@mantine/core';
import { PostCard, type PostCardImage } from '@xitter/ui';
import type { Post } from '@xitter/api-contracts';
import { DeletePostButton } from './delete-post-button';

export interface PostListItemProps {
  post: Pick<Post, 'id' | 'text' | 'createdAt' | 'counts' | 'media'>;
  author: { id: string; username: string; displayName: string };
  /** Viewer's own post: render the delete affordance. */
  canDelete?: boolean;
  /** Profile to revalidate after a delete (the card's host page). */
  username?: string;
  /** Redirect target after delete (detail pages navigate away). */
  goTo?: string;
}

/** Chosen-variant URLs from a post's media snapshot (fallback: the other one). */
export function imagesFor(
  post: Pick<Post, 'media'>,
  variant: 'thumb' | 'original',
): PostCardImage[] {
  return post.media.flatMap((asset) => {
    const chosen = asset.variants.find((item) => item.kind === variant) ?? asset.variants[0];
    return chosen ? [{ url: chosen.url, alt: 'Image attached to post' }] : [];
  });
}

/**
 * PostCard + navigation to the detail page + (own posts) delete. The delete
 * button sits below the card so it never nests a form inside the anchor.
 * Lists render thumbs; the detail page passes originals via PostCard itself.
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
        <PostCard author={author} post={post} images={imagesFor(post, 'thumb')} />
      </Anchor>
      {canDelete ? <DeletePostButton postId={post.id} username={username} goTo={goTo} /> : null}
    </Stack>
  );
}
