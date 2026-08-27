import { Container, Divider, Stack, Title, Text } from '@mantine/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { postIdSchema, type ThreadResponse } from '@xitter/api-contracts';
import { ApiError } from '@xitter/api-client';
import { requireSession } from '@/lib/auth/session';
import { PostComposer } from '@/components/post-composer';
import { PostInteractions } from '@/components/post-interactions';
import { toThreadItems, threadTreePosts } from '@/lib/posts/cards';
import { clientsForSession, profilesByAuthorIds, viewerStateByPostId } from '@/lib/posts/server';
import { AncestorChain } from './ancestor-chain';
import { ThreadTree } from './thread-tree';

export const metadata: Metadata = { title: 'Post' };

const cardAuthor = (profile: { username: string; displayName: string } | undefined, id: string) =>
  profile
    ? { id, username: profile.username, displayName: profile.displayName }
    : { id, username: 'unknown', displayName: 'Unknown' };

/**
 * Post detail (#152 thread view): the full ancestor chain above the focus
 * ("showing this thread" - compact linked cards with connector guides),
 * the focus card, one reply composer, and the nested reply tree below.
 * Deleted/missing posts render the 404 page - soft-deleted is
 * indistinguishable from absent. Load more appends in place on the shared
 * cursor pattern (#41).
 */
export default async function PostDetailPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const session = await requireSession(`/post/${postId}`);

  // Malformed ids (audit #32): 404 instead of the posts API's Zod 400
  // bubbling up as a 500 error boundary.
  if (!postIdSchema.safeParse(postId).success) notFound();

  const { posts, social } = clientsForSession(session);

  // One composed read replaces the getPost + parent getPost + getReplies
  // trio; a deleted ancestor simply ends the chain (no tombstone row).
  let thread: ThreadResponse;
  try {
    thread = await posts.getThread(postId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const treePosts = threadTreePosts(thread.replies);
  // Author + viewer hydration are independent - run them together.
  const [authors, states] = await Promise.all([
    profilesByAuthorIds(social, [
      thread.focus.authorId,
      ...thread.ancestors.map((ancestor) => ancestor.authorId),
      ...treePosts.map((post) => post.authorId),
    ]),
    // Interaction flags for the detail card + the visible tree nodes (#8).
    // The focus post rides first so the batch cap always covers it; deeper
    // nodes past the cap render with default-false flags (a tap reconciles).
    viewerStateByPostId(posts, [thread.focus.id, ...treePosts.map((post) => post.id)]),
  ]);
  const flagsOf = (id: string) => {
    const state = states.get(id);
    return {
      liked: state?.liked ?? false,
      reposted: state?.reposted ?? false,
      bookmarked: state?.bookmarked ?? false,
    };
  };

  const author = cardAuthor(authors.get(thread.focus.authorId), thread.focus.authorId);
  const treeItems = toThreadItems(thread.replies, authors, states, session.subject);

  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Title order={1} size="h3">
          Post
        </Title>

        <AncestorChain
          ancestors={thread.ancestors}
          authors={authors}
          truncated={thread.ancestorsTruncated}
        />

        <div data-testid={`post-detail-${thread.focus.id}`}>
          <PostInteractions
            post={thread.focus}
            author={author}
            viewer={flagsOf(thread.focus.id)}
            variant="original"
            canDelete={thread.focus.authorId === session.subject}
            username={author.username}
            goTo="/feed"
          />
        </div>


        <Divider my="xs" />

        <PostComposer
          replyToId={thread.focus.id}
          placeholder="Post your reply"
          submitLabel="Reply"
          testId="reply-composer"
        />

        <Divider my="xs" />

        {treeItems.length === 0 ? (
          <Text size="sm" c="dimmed" data-testid="replies-empty">
            No replies yet.
          </Text>
        ) : (
          <ThreadTree
            focusId={thread.focus.id}
            initialNodes={treeItems}
            initialCursor={thread.repliesCursor}
          />
        )}
      </Stack>
    </Container>
  );
}
