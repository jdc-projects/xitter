'use client';

import { useState, useTransition } from 'react';
import { Alert } from '@mantine/core';
import type { PostCardInteractionKind, PostCardViewer } from '@xitter/ui';
import { interactAction } from '@/lib/posts/actions';

export interface InteractionState {
  viewer: PostCardViewer;
  busyKinds: PostCardInteractionKind[];
  onInteract: (kind: PostCardInteractionKind, active: boolean) => void;
}

export interface PostInteractionsProps {
  postId: string;
  /** Server-rendered viewer flags for this post (batched viewer-state). */
  viewer: PostCardViewer;
  children: (state: InteractionState) => React.ReactNode;
}

/**
 * Client wiring for PostCard's interaction row (#8): optimistic flip of the
 * active state, then the server action reconciles (its revalidate refreshes
 * authoritative counts + filled icons). The render prop keeps PostCard
 * transport-free while this component owns transport + optimistic state.
 */
export function PostInteractions({ postId, viewer, children }: PostInteractionsProps) {
  const [optimistic, setOptimistic] = useState<PostCardViewer>(viewer);
  const [busy, setBusy] = useState<PostCardInteractionKind[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function onInteract(kind: PostCardInteractionKind, active: boolean) {
    setError(null);
    setBusy((current) => [...current, kind]);
    setOptimistic((current) => ({ ...current, [kind]: !active }));

    startTransition(async () => {
      const result = await interactAction(postId, kind, active);
      setBusy((current) => current.filter((k) => k !== kind));
      if (result.error) {
        // Roll the optimistic flip back - the server is the truth.
        setOptimistic((current) => ({ ...current, [kind]: active }));
        setError(result.error);
      }
    });
  }

  return (
    <>
      {children({ viewer: optimistic, busyKinds: busy, onInteract })}
      {error ? (
        <Alert color="red" py={4} px="sm" data-testid={`interact-error-${postId}`}>
          {error}
        </Alert>
      ) : null}
    </>
  );
}
