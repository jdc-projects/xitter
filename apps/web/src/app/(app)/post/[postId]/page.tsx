import { Anchor, Container, Divider, Stack, Text, Title } from '@mantine/core';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { Post } from '@xitter/api-contracts';
import { ApiError } from '@xitter/api-client';
import { requireSession } from '@/lib/auth/session';
import { PostComposer } from '@/components/post-composer';
import { PostInteractions } from '@/components/post-interactions';
import { DeletePostButton } from '@/components/delete-post-button';
import { toPostCardItems } from '@/lib/posts/cards';
import { clientsForSession, profilesByAuthorIds, viewerStateByPostId } from '@/lib/posts/server';
import { ReplyThread } from './reply-thread';

export const metadata: Metadata = { title: 'Post' };

const cardAuthor = (profile: { username: string; displayName: string } | undefined, id: string) =>
  profile
    ? { id, username: profile.username, displayName: profile.displayName }
    : { id, username: 'unknown', displayName: 'Unknown' };

/**
 * Post detail: the post, its reply thread (chronological, spec 03), an
 * inline reply composer, and delete for the author. Deleted/missing posts
 * render the 404 page - soft-deleted is indistinguishable from absent.
 * Load more appends in place on the shared cursor pattern (#41).
 */
export default async function PostDetailPage({ params }: { params: Promise<{ postId: string }> }) {
  const { postId } = await params;
  const session = await requireSession(`/post/${postId}`);
  const { posts, social } = clientsForSession(session);

  let post: Post;
  try {
    post = await posts.getPost(postId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  // Parent context ("Replying to @x") for replies opened directly; fetched
  // before author hydration so its author joins the same profile batch.
  const parentPost = post.replyToId ? await posts.getPost(post.replyToId).catch(() => null) : null;

  const replies = await posts
    .getReplies(postId)
    .catch(() => ({ items: [] as Post[], nextCursor: null }));
  const authors = await profilesByAuthorIds(social, [
    post.authorId,
    ...(parentPost ? [parentPost.authorId] : []),
    ...replies.items.map((reply) => reply.authorId),
  ]);

  // Interaction flags for the detail card + the visible replies (#8).
  const states = await viewerStateByPostId(posts, [
    post.id,
    ...replies.items.map((reply) => reply.id),
  ]);
  const flagsOf = (id: string) => {
    const state = states.get(id);
    return {
      liked: state?.liked ?? false,
      reposted: state?.reposted ?? false,
      bookmarked: state?.bookmarked ?? false,
    };
  };

  const author = cardAuthor(authors.get(post.authorId), post.authorId);

  return (
    <Container size="sm" py="xl">
      <Stack gap="md">
        <Title order={1} size="h3">
          Post
        </Title>

        {parentPost ? (
          <Text size="sm" c="dimmed">
            Reply to{' '}
            <Anchor href={`/post/${parentPost.id}`} size="sm" data-testid="parent-post-link">
              @{cardAuthor(authors.get(parentPost.authorId), parentPost.authorId).username}
            </Anchor>
          </Text>
        ) : null}

        <div data-testid={`post-detail-${post.id}`}>
          <PostInteractions
            post={post}
            author={author}
            viewer={flagsOf(post.id)}
            variant="original"
          />
        </div>
        {post.authorId === session.subject ? (
          <DeletePostButton postId={post.id} username={author.username} goTo="/feed" />
        ) : null}

        <Divider my="xs" />

        <PostComposer
          replyToId={post.id}
          placeholder="Post your reply"
          submitLabel="Reply"
          testId="reply-composer"
        />

        <Divider my="xs" />

        {replies.items.length === 0 ? (
          <Text size="sm" c="dimmed" data-testid="replies-empty">
            No replies yet.
          </Text>
        ) : (
          <ReplyThread
            postId={postId}
            initialItems={toPostCardItems(replies.items, authors, states, session.subject)}
            initialCursor={replies.nextCursor}
          />
        )}
      </Stack>
    </Container>
  );
}
