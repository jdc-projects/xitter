'use client';

import { useState } from 'react';
import { Alert, Anchor, Box, Stack, UnstyledButton } from '@mantine/core';
import { THREAD_DEPTH_MAX } from '@xitter/api-contracts';
import { LoadMoreControl } from '@/components/load-more-control';
import { PostListItem } from '@/components/post-list-item';
import type { PostCardItem } from '@/components/paginated-post-list';
import { useCursorPages, type CursorPage } from '@/components/use-cursor-pages';
import { leafNodesFromItems } from '@/lib/posts/cards';
import { repliesPageAction } from './actions';

/** One hydrated node of the reply tree: a card row plus its bounded subtree. */
export interface ThreadNodeItem extends PostCardItem {
  children: ThreadNodeItem[];
  /** The node has more direct replies than are embedded (#152). */
  childrenTruncated: boolean;
}

export interface ThreadTreeProps {
  /** The focus post - top-level Load more walks its /replies keyset. */
  focusId: string;
  /** Server-rendered depth-capped tree (page 1). */
  initialNodes: ThreadNodeItem[];
  initialCursor: string | null;
}

/**
 * Nested reply tree below the focus post (#152). Server embeds three
 * levels; deeper conversation is reached by navigation ("Show this
 * thread" - the tapped reply becomes the focus of its own page), and
 * wider branches expand in place through the existing /replies keyset,
 * the same endpoint the flat list always used.
 */
export function ThreadTree({ focusId, initialNodes, initialCursor }: ThreadTreeProps) {
  const { items, cursor, loading, error, loadMore } = useCursorPages(
    initialNodes,
    initialCursor,
    async (pageCursor) => {
      const page = await repliesPageAction(focusId, pageCursor);
      const mapped: CursorPage<ThreadNodeItem> = {
        items: leafNodesFromItems(page.items),
        nextCursor: page.nextCursor,
        error: page.error,
      };
      return mapped;
    },
  );

  return (
    <>
      <Stack gap="md" data-testid="thread-tree">
        {items.map((node) => (
          <ThreadBranch key={node.post.id} node={node} depth={1} focusId={focusId} />
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

interface ThreadBranchProps {
  node: ThreadNodeItem;
  /** 1 = direct reply of the focus; the server embeds down to the cap. */
  depth: number;
  focusId: string;
}

function ThreadBranch({ node, depth, focusId }: ThreadBranchProps) {
  const [children, setChildren] = useState<ThreadNodeItem[]>(node.children);
  const [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Server revalidation re-renders the embedded subtree - sync the reset
  // during render (same pattern as every cursor list on the page).
  const [synced, setSynced] = useState(node.children);
  if (node.children !== synced) {
    setSynced(node.children);
    setChildren(node.children);
    setCursor(null);
    setExpanded(false);
  }

  // Before any expansion the server's truncation flag is the truth; after
  // it, the fetched page's own keyset cursor is (it can run to null).
  const more = expanded ? cursor !== null : node.childrenTruncated;
  const atDepthCap = depth >= THREAD_DEPTH_MAX;

  async function showReplies() {
    if (loading) return;
    setLoading(true);
    setError(null);
    const page = await repliesPageAction(node.post.id, cursor ?? undefined);
    if (page.error) {
      setError(page.error);
    } else {
      const fetched = leafNodesFromItems(page.items);
      setChildren((current) => {
        // First reveal REPLACES the embedded previews: the fetched page 1
        // re-includes those same oldest children, so appending would
        // duplicate them. Further pages append on the keyset cursor.
        return expanded ? [...current, ...fetched] : fetched;
      });
      setCursor(page.nextCursor);
      setExpanded(true);
    }
    setLoading(false);
  }

  return (
    <Stack gap="xs" data-testid={`thread-node-${node.post.id}`}>
      <PostListItem
        post={node.post}
        author={node.author}
        viewer={node.viewer}
        canDelete={node.canDelete}
        username={node.username}
        // Nested deletes land back on the thread (a same-page re-navigation
        // to fresh server data); only the focus delete leaves for /feed.
        goTo={`/post/${focusId}`}
      />

      {children.length > 0 ? (
        <Box
          pl="lg"
          style={{ borderLeft: '2px solid var(--mantine-color-default-border)' }}
          data-testid={`thread-children-${node.post.id}`}
        >
          <Stack gap="md">
            {children.map((child) => (
              <ThreadBranch key={child.post.id} node={child} depth={depth + 1} focusId={focusId} />
            ))}
          </Stack>
        </Box>
      ) : null}

      {more && atDepthCap ? (
        // Depth cap: navigation, not inline expansion - the tapped reply
        // becomes the focus post of its own thread page.
        <Anchor
          href={`/post/${node.post.id}`}
          size="sm"
          ml="lg"
          data-testid={`show-thread-${node.post.id}`}
        >
          Show this thread
        </Anchor>
      ) : null}

      {more && !atDepthCap ? (
        <UnstyledButton
          size="sm"
          c="dimmed"
          disabled={loading}
          onClick={() => void showReplies()}
          data-testid={`show-replies-${node.post.id}`}
        >
          {loading
            ? 'Loading…'
            : expanded
              ? 'Show more replies'
              : `Show ${node.post.counts.replies} ${node.post.counts.replies === 1 ? 'reply' : 'replies'}`}
        </UnstyledButton>
      ) : null}

      {error ? (
        <Alert color="red" py={4} px="sm" data-testid={`show-replies-error-${node.post.id}`}>
          {error}
        </Alert>
      ) : null}
    </Stack>
  );
}
