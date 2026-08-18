import { Anchor, Container, Divider, Stack, Text, Title } from '@mantine/core';
import { PostCard } from '@xitter/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { Post, Profile } from '@xitter/api-contracts';
import { ApiError } from '@xitter/api-client';
import { requireSession } from '@/lib/auth/session';
import { PostComposer } from '@/components/post-composer';
import { PostListItem } from '@/components/post-list-item';
import { DeletePostButton } from '@/components/delete-post-button';
import { clientsForSession, profilesByAuthorIds } from '@/lib/posts/server';

export const metadata: Metadata = { title: 'Post' };

type SearchParams = Promise<{ cursor?: string }>;

const cardAuthor = (profile: Profile | undefined, id: string) =>
  profile
    ? { id: profile.id, username: profile.username, displayName: profile.displayName }
    : { id, username: 'unknown', displayName: 'Unknown' };

/**
 * Post detail: the post, its reply thread (chronological, spec 03), an
 * inline reply composer, and delete for the author. Deleted/missing posts
 * render the 404 page - soft-deleted is indistinguishable from absent.
 */
export default async function PostDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ postId: string }>;
  searchParams: SearchParams;
}) {
  const { postId } = await params;
  const { cursor } = await searchParams;
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
    .getReplies(postId, cursor)
    .catch(() => ({ items: [] as Post[], nextCursor: null }));
  const authors = await profilesByAuthorIds(social, [
    post.authorId,
    ...(parentPost ? [parentPost.authorId] : []),
    ...replies.items.map((reply) => reply.authorId),
  ]);

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
          <PostCard author={author} post={post} />
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
          <>
            <Stack gap="md" data-testid="reply-thread">
              {replies.items.map((reply) => (
                <PostListItem
                  key={reply.id}
                  post={reply}
                  author={cardAuthor(authors.get(reply.authorId), reply.authorId)}
                  canDelete={reply.authorId === session.subject}
                  username={cardAuthor(authors.get(reply.authorId), reply.authorId).username}
                />
              ))}
            </Stack>
            {replies.nextCursor ? (
              <Anchor
                href={`/post/${postId}?cursor=${replies.nextCursor}`}
                size="sm"
                data-testid="load-more"
              >
                Load more
              </Anchor>
            ) : null}
          </>
        )}
      </Stack>
    </Container>
  );
}
