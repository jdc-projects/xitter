'use client';

import { useState, useTransition } from 'react';
import { Alert } from '@mantine/core';
import {
  PostCard,
  type PostCardImage,
  type PostCardInteractionKind,
  type PostCardUser,
  type PostCardViewer,
} from '@xitter/ui';
import type { Post } from '@xitter/api-contracts';
import { interactAction } from '@/lib/posts/actions';
import { imagesFor } from '@/lib/media/images';
import { PostOverflowMenu } from './post-overflow-menu';

export interface PostInteractionsProps {
  /** PostCard payload (serializable - this component owns the handlers). */
  post: Pick<Post, 'id' | 'text' | 'createdAt' | 'counts' | 'media'>;
  author: PostCardUser;
  /** Server-rendered viewer flags for this post (batched viewer-state). */
  viewer: PostCardViewer;
  /** Repost attribution (feed repost entries). */
  repostedBy?: PostCardUser;
  /** Card images variant: thumbs in lists, originals on the detail page. */
  variant?: 'thumb' | 'original';
  /** Detail-page link: navigation rides the card's stretched overlay link. */
  href?: string;
  /** Viewer's own post: render the owner-only overflow menu on the card. */
  canDelete?: boolean;
  /** Profile to revalidate after a delete (the card's host page). */
  username?: string;
  /** Redirect target after a delete (detail pages navigate away). */
  goTo?: string;
}

/**
 * Interactive post card (#8): PostCard + the like/repost/bookmark wiring.
 * Client-owned so the handlers can live next to the optimistic state (flip
 * immediately, reconcile with the server action's revalidate). This
 * component renders the card itself - a render prop would have to cross
 * the server/client boundary, and functions cannot.
 */
export function PostInteractions({
  post,
  author,
  viewer,
  repostedBy,
  variant = 'thumb',
  href,
  canDelete = false,
  username,
  goTo,
}: PostInteractionsProps) {
  const [optimistic, setOptimistic] = useState<PostCardViewer>(viewer);
  const [busy, setBusy] = useState<PostCardInteractionKind[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Server revalidation re-renders with authoritative flags - sync during
  // render (same pattern as the feed timeline's page reset). Revalidation
  // only lands after the action resolved, when server state already
  // matches the flip, so in-flight clicks are not clobbered.
  const [synced, setSynced] = useState(viewer);
  if (viewer !== synced) {
    setSynced(viewer);
    setOptimistic(viewer);
  }

  function onInteract(kind: PostCardInteractionKind, active: boolean) {
    setError(null);
    setBusy((current) => [...current, kind]);
    setOptimistic((current) => ({ ...current, [kind]: !active }));

    startTransition(async () => {
      const result = await interactAction(post.id, kind, active);
      setBusy((current) => current.filter((k) => k !== kind));
      if (result.error) {
        // Roll the optimistic flip back - the server is the truth.
        setOptimistic((current) => ({ ...current, [kind]: active }));
        setError(result.error);
      }
    });
  }

  const images: PostCardImage[] = imagesFor(post, variant);

  return (
    <>
      <PostCard
        author={author}
        post={post}
        images={images}
        viewer={optimistic}
        busyKinds={busy}
        onInteract={onInteract}
        repostedBy={repostedBy}
        href={href}
        actions={
          canDelete ? (
            <PostOverflowMenu postId={post.id} username={username} goTo={goTo} />
          ) : undefined
        }
      />
      {error ? (
        <Alert color="red" py={4} px="sm" mt={4} data-testid={`interact-error-${post.id}`}>
          {error}
        </Alert>
      ) : null}
    </>
  );
}
