'use client';

import { Anchor } from '@mantine/core';
import { Card, Group, Image, SimpleGrid, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconBookmark, IconHeart, IconMessageCircle, IconRepeat } from '@tabler/icons-react';
import { UserAvatar } from './UserAvatar';
import { RelativeTime } from './RelativeTime';

export interface PostCardUser {
  id: string;
  username: string;
  displayName: string;
}

export interface PostCardImage {
  url: string;
  alt: string;
}

export interface PostCardPost {
  id: string;
  text: string;
  createdAt: string;
  counts: { replies: number; likes: number; reposts: number };
}

export type PostCardInteractionKind = 'repost' | 'like' | 'bookmark';

export interface PostCardViewer {
  liked?: boolean;
  bookmarked?: boolean;
  reposted?: boolean;
}

export interface PostCardProps {
  author: PostCardUser;
  post: PostCardPost;
  /** Attached images (callers pick the variant: thumbs in lists, originals on detail). */
  images?: PostCardImage[];
  /** Viewer interactions, for filled icons. */
  viewer?: PostCardViewer;
  /**
   * Interaction wiring (#8): when present the counts row becomes buttons
   * (aria-pressed + filled icons for active kinds); without it the row
   * stays presentational - the card never assumes a transport of its own.
   */
  onInteract?: (kind: PostCardInteractionKind, active: boolean) => void;
  /** Kinds currently in flight (buttons disabled while a server action runs). */
  busyKinds?: PostCardInteractionKind[];
  /** Attribution line for reposts ("X reposted"). */
  repostedBy?: PostCardUser;
  /** Reply context line ("Replying to @x") for replies rendered in lists (#147). */
  replyingTo?: PostCardUser;
  /**
   * Detail-page link for the card's content (header/text/images). The action
   * row stays OUTSIDE the anchor - nested interactive controls are invalid
   * HTML and an axe violation.
   */
  href?: string;
  /**
   * Rendering variant (#152): `ancestor` is the compact thread-context card
   * (avatar, name, text, time; no counts row; the whole card is a link via
   * `href`). `thumb`/`original` render the standard card - image-variant
   * selection stays with the caller's `images` prop.
   */
  variant?: 'thumb' | 'original' | 'ancestor';
}

// aria-hidden: the glyphs are decorative - the adjacent label text (nav
// labels, button aria-labels) carries the meaning, and without it each svg
// surfaces in the a11y tree as an unnamed img (audit #32).
const iconProps = { size: 18, stroke: 1.5, 'aria-hidden': true } as const;

const KIND_COLOR: Record<PostCardInteractionKind, string> = {
  repost: 'teal',
  like: 'red',
  bookmark: 'indigo',
};

const KIND_LABEL: Record<PostCardInteractionKind, string> = {
  repost: 'Repost',
  like: 'Like',
  bookmark: 'Bookmark',
};

/**
 * Accessible name for an interaction control: the state ("Undo like") plus
 * the visible count, so a bare aria-label never hides the number from
 * screen readers (audit #32). Bookmark counts are private - name only.
 */
function interactionName(
  kind: PostCardInteractionKind,
  active: boolean,
  count: number | null,
): string {
  const label = active ? `Undo ${KIND_LABEL[kind].toLowerCase()}` : KIND_LABEL[kind];
  return count === null ? label : `${label} (${count})`;
}

/**
 * Feed / profile post card. Interaction buttons are presentational here -
 * the web app wires them to its own handlers via `onInteract` (server
 * actions), keeping this package transport-free.
 */
export function PostCard({
  author,
  post,
  images = [],
  viewer,
  onInteract,
  busyKinds = [],
  repostedBy,
  replyingTo,
  href,
  variant,
}: PostCardProps) {
  const interactButton = (kind: PostCardInteractionKind, count: number | null, testId: string) => {
    const active =
      kind === 'repost' ? viewer?.reposted : kind === 'like' ? viewer?.liked : viewer?.bookmarked;
    const color = active ? KIND_COLOR[kind] : 'dimmed';
    // Filled heart/bookmark glyphs read as "active" at a glance; the repeat
    // glyph has no filled variant, so colour + aria-pressed carry the state.
    const fill = active && kind !== 'repost' ? 'currentColor' : 'none';
    const Icon = kind === 'repost' ? IconRepeat : kind === 'like' ? IconHeart : IconBookmark;
    const body = (
      <>
        <Icon {...iconProps} fill={fill} /> {count}
      </>
    );
    const label = interactionName(kind, Boolean(active), count);

    if (!onInteract) {
      return (
        <Text component="span" size="sm" c={color} data-testid={testId} key={testId}>
          {body}
        </Text>
      );
    }
    return (
      <UnstyledButton
        key={testId}
        size="sm"
        c={color}
        disabled={busyKinds.includes(kind)}
        aria-pressed={Boolean(active)}
        aria-label={label}
        title={label}
        data-testid={testId}
        onClick={() => onInteract(kind, Boolean(active))}
      >
        {body}
      </UnstyledButton>
    );
  };

  const content = (
    <>
      <Group wrap="nowrap" align="flex-start" justify="space-between">
        <Group wrap="nowrap" gap="sm">
          <UserAvatar username={author.username} displayName={author.displayName} />
          <Stack gap={0}>
            <Text size="sm" fw={600}>
              {author.displayName}
            </Text>
            <Text size="xs" c="dimmed">
              @{author.username}
            </Text>
          </Stack>
        </Group>
        <RelativeTime date={post.createdAt} />
      </Group>

      {repostedBy ? (
        <Text size="xs" c="dimmed" mt={4} data-testid={`post-repost-attribution-${post.id}`}>
          {repostedBy.displayName} reposted
        </Text>
      ) : null}

      {replyingTo ? (
        <Text size="xs" c="dimmed" mt={4} data-testid={`post-reply-context-${post.id}`}>
          Replying to @{replyingTo.username}
        </Text>
      ) : null}

      <Text mt="sm" size="sm" style={{ whiteSpace: 'pre-wrap' }}>
        {post.text}
      </Text>

      {images.length > 0 ? (
        <SimpleGrid
          mt="sm"
          cols={images.length > 1 ? 2 : 1}
          spacing="xs"
          data-testid={`post-images-${post.id}`}
        >
          {images.map((image) => (
            <Image
              key={image.url}
              src={image.url}
              alt={image.alt}
              radius="sm"
              fit="cover"
              loading="lazy"
              data-testid={`post-image-${post.id}`}
            />
          ))}
        </SimpleGrid>
      ) : null}
    </>
  );

  // Thread ancestor context (#152): compact card, no counts row, the whole
  // card links to the ancestor's own detail page ("showing this thread").
  if (variant === 'ancestor') {
    return (
      <Card withBorder padding="xs" radius="md" data-testid={`post-ancestor-${post.id}`}>
        <Anchor
          href={href}
          unstyled
          style={{ textDecoration: 'none', display: 'block' }}
          aria-label={`${author.displayName}: ${post.text}`}
        >
          <Group wrap="nowrap" gap="sm" align="flex-start">
            <UserAvatar size="sm" username={author.username} displayName={author.displayName} />
            <Stack gap={4} style={{ flex: 1, minWidth: 0 }}>
              <Group wrap="nowrap" gap="xs" justify="space-between">
                <Group wrap="nowrap" gap="xs" style={{ minWidth: 0 }}>
                  <Text size="sm" fw={600} truncate="end">
                    {author.displayName}
                  </Text>
                  <Text size="xs" c="dimmed" truncate="end">
                    @{author.username}
                  </Text>
                </Group>
                <RelativeTime date={post.createdAt} />
              </Group>
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {post.text}
              </Text>
            </Stack>
          </Group>
        </Anchor>
      </Card>
    );
  }

  return (
    <Card withBorder padding="sm" radius="md" data-testid={`post-${post.id}`}>
      {href ? (
        <Anchor href={href} unstyled style={{ textDecoration: 'none', display: 'block' }}>
          {content}
        </Anchor>
      ) : (
        content
      )}

      <Group mt="sm" gap="lg">
        <Text
          component="span"
          size="sm"
          c="dimmed"
          data-testid="count-replies"
          aria-label={`${post.counts.replies} ${post.counts.replies === 1 ? 'reply' : 'replies'}`}
        >
          <IconMessageCircle {...iconProps} /> {post.counts.replies}
        </Text>
        {interactButton('repost', post.counts.reposts, 'count-reposts')}
        {interactButton('like', post.counts.likes, 'count-likes')}
        {/* Bookmark counts are private to the viewer - icon state only. */}
        {interactButton('bookmark', null, 'count-bookmarks')}
      </Group>
    </Card>
  );
}
