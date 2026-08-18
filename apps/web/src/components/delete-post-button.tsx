'use client';

import { Button, Group } from '@mantine/core';
import { deletePostAction } from '@/lib/posts/actions';

export interface DeletePostButtonProps {
  postId: string;
  /** Profile to revalidate after the delete. */
  username?: string;
  /** Redirect target after the delete (detail pages navigate away). */
  goTo?: string;
}

/** Delete own post via server action (author-only is enforced by posts). */
export function DeletePostButton({ postId, username, goTo }: DeletePostButtonProps) {
  return (
    <Group justify="flex-end">
      <form action={deletePostAction}>
        <input type="hidden" name="postId" value={postId} />
        {username ? <input type="hidden" name="username" value={username} /> : null}
        {goTo ? <input type="hidden" name="goTo" value={goTo} /> : null}
        <Button
          type="submit"
          size="compact-xs"
          variant="subtle"
          color="red"
          data-testid={`delete-post-${postId}`}
        >
          Delete
        </Button>
      </form>
    </Group>
  );
}
