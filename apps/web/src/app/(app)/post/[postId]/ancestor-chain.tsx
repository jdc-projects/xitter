import { Box, Stack, Text } from '@mantine/core';
import { PostCard } from '@xitter/ui';
import type { Post } from '@xitter/api-contracts';

export interface AncestorChainProps {
  /** Root → direct parent of the focus post, as the thread endpoint orders it. */
  ancestors: Post[];
  /** Hydrated author profiles (missing ids fall back to a placeholder). */
  authors: ReadonlyMap<string, { id: string; username: string; displayName: string }>;
  /** The visible chain continues past the ancestor cap (#152). */
  truncated: boolean;
}

/**
 * Vertical guide connecting an ancestor card to the next card (and the
 * last one to the focus): centred under the avatar column - card
 * padding-xs (10px) + half the sm avatar (15px) - the 2px line lands on
 * the avatar's centre line.
 */
function ConnectorGuide() {
  return <Box w={2} h={14} bg="var(--mantine-color-default-border)" ml={24} my={4} />;
}

/**
 * "Showing this thread" context above the focus card (#152): compact
 * ancestor cards, each linking to its own detail page, joined by
 * connector guides. The final guide connects to the focus card the page
 * renders right below this chain.
 */
export function AncestorChain({ ancestors, authors, truncated }: AncestorChainProps) {
  if (ancestors.length === 0) return null;

  return (
    <Stack gap={0} data-testid="thread-ancestors">
      {truncated ? (
        <Text size="xs" c="dimmed" ml={24} data-testid="thread-ancestors-truncated">
          …
        </Text>
      ) : null}
      {ancestors.map((post) => {
        const profile = authors.get(post.authorId);
        const author = profile
          ? { id: post.authorId, username: profile.username, displayName: profile.displayName }
          : { id: post.authorId, username: 'unknown', displayName: 'Unknown' };
        return (
          <Box key={post.id}>
            <PostCard author={author} post={post} variant="ancestor" href={`/post/${post.id}`} />
            <ConnectorGuide />
          </Box>
        );
      })}
    </Stack>
  );
}
