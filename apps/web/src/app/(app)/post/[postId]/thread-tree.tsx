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
 * Nested reply tree below the focus post (#152). The server embeds three
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
  const reveal = useNodeReveal(node);
  const atDepthCap = depth >= THREAD_DEPTH_MAX;

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

      <NodeChildren nodeId={node.post.id} nodes={reveal.children} depth={depth} focusId={focusId} />

      <RevealControls node={node} atDepthCap={atDepthCap} reveal={reveal} />
    </Stack>
  );
}

/**
 * Reveal state for one branch: children grow from the embedded previews
 * through client-side /replies fetches. The server re-render resets state
 * during render (same pattern as every cursor list on the page).
 */
function useNodeReveal(node: ThreadNodeItem) {
  const [children, setChildren] = useState<ThreadNodeItem[]>(node.children);
  const [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [synced, setSynced] = useState(node.children);
  if (node.children !== synced) {
    setSynced(node.children);
    setChildren(node.children);
    setCursor(null);
    setExpanded(false);
  }

  async function showReplies() {
    if (loading) return;
    setLoading(true);
    setError(null);
    // No try/finally: the React Compiler doesn't support it in component
    // code (same trade-off as use-cursor-pages' loadMore).
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

  // Before any expansion the server's truncation flag is the truth; after
  // it, the fetched page's own keyset cursor is (it can run to null).
  const more = expanded ? cursor !== null : node.childrenTruncated;
  return { children, more, expanded, loading, error, showReplies };
}

interface NodeChildrenProps {
  nodeId: string;
  nodes: ThreadNodeItem[];
  depth: number;
  focusId: string;
}

/** The indented sub-branch: one guide level deeper than its parent. */
function NodeChildren({ nodeId, nodes, depth, focusId }: NodeChildrenProps) {
  if (nodes.length === 0) return null;
  return (
    <Box
      pl="lg"
      style={{ borderLeft: '2px solid var(--mantine-color-default-border)' }}
      data-testid={`thread-children-${nodeId}`}
    >
      <Stack gap="md">
        {nodes.map((child) => (
          <ThreadBranch key={child.post.id} node={child} depth={depth + 1} focusId={focusId} />
        ))}
      </Stack>
    </Box>
  );
}

interface RevealControlsProps {
  node: ThreadNodeItem;
  atDepthCap: boolean;
  reveal: ReturnType<typeof useNodeReveal>;
}

/**
 * The "more behind this node" affordance: below the depth cap it expands
 * in place; AT the cap it navigates - the tapped reply becomes the focus
 * post of its own thread page.
 */
function RevealControls({ node, atDepthCap, reveal }: RevealControlsProps) {
  if (!reveal.more) return null;

  if (atDepthCap) {
    return (
      <Anchor
        href={`/post/${node.post.id}`}
        size="sm"
        ml="lg"
        data-testid={`show-thread-${node.post.id}`}
      >
        Show this thread
      </Anchor>
    );
  }

  const count = node.post.counts.replies;
  return (
    <>
      <UnstyledButton
        size="sm"
        c="dimmed"
        disabled={reveal.loading}
        onClick={() => void reveal.showReplies()}
        data-testid={`show-replies-${node.post.id}`}
      >
        {reveal.loading
          ? 'Loading…'
          : reveal.expanded
            ? 'Show more replies'
            : `Show ${count} ${count === 1 ? 'reply' : 'replies'}`}
      </UnstyledButton>
      {reveal.error ? (
        <Alert color="red" py={4} px="sm" data-testid={`show-replies-error-${node.post.id}`}>
          {reveal.error}
        </Alert>
      ) : null}
    </>
  );
}
