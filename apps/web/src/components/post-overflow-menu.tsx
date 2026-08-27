'use client';

import { useState } from 'react';
import { ActionIcon, Button, Group, Menu, Modal, Stack, Text } from '@mantine/core';
import { IconDots, IconTrash } from '@tabler/icons-react';
import { deletePostAction } from '@/lib/posts/actions';

export interface PostOverflowMenuProps {
  postId: string;
  /** Profile to revalidate after the delete. */
  username?: string;
  /** Redirect target after the delete (detail pages navigate away). */
  goTo?: string;
}

/**
 * Owner-only overflow menu (⋯) on the post card (#146): delete sits behind
 * a confirmation dialog so a stray click can never destroy a post, and the
 * affordance lives ON the card it belongs to instead of floating under it.
 * Ownership gating happens at the call site; the server action still
 * enforces author-only deletes.
 */
export function PostOverflowMenu({ postId, username, goTo }: PostOverflowMenuProps) {
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <Menu withinPortal position="bottom-end" shadow="md" width={200}>
        <Menu.Target>
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="Post options"
            data-testid={`post-overflow-${postId}`}
          >
            <IconDots size={18} stroke={1.5} aria-hidden />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            color="red"
            leftSection={<IconTrash size={14} stroke={1.5} aria-hidden />}
            onClick={() => setConfirming(true)}
            data-testid={`post-overflow-delete-${postId}`}
          >
            Delete post
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>

      <Modal opened={confirming} onClose={() => setConfirming(false)} title="Delete post?" centered>
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            This permanently deletes your post for everyone. This cannot be undone.
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button
              variant="subtle"
              onClick={() => setConfirming(false)}
              data-testid={`post-delete-cancel-${postId}`}
            >
              Cancel
            </Button>
            <form action={deletePostAction}>
              <input type="hidden" name="postId" value={postId} />
              {username ? <input type="hidden" name="username" value={username} /> : null}
              {goTo ? <input type="hidden" name="goTo" value={goTo} /> : null}
              <Button type="submit" color="red" data-testid={`delete-post-${postId}`}>
                Delete
              </Button>
            </form>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
