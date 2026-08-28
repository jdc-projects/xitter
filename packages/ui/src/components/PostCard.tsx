'use client';

import type { ReactNode } from 'react';
import { Anchor, Card, Group, Image, SimpleGrid, Stack, Text, UnstyledButton } from '@mantine/core';
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
   * Detail-page link. The card itself is NOT an anchor (#142): a stretched
   * overlay link (empty, absolutely positioned over the card) provides the
   * navigation. No card text lives inside the anchor, so the browser
   * :visited colour can never bleed onto it, and interactive controls
   * never nest inside a link.
   */
  href?: string;
  /**
   * Rendering variant (#152): `ancestor` is the compact thread-context card
   * (avatar, name, text, time; no counts row; the whole card is a link via
   * `href`). `thumb`/`original` render the standard card - image-variant
   * selection stays with the caller's `images` prop.
   */
  variant?: 'thumb' | 'original' | 'ancestor';
  /**
   * Card-level controls (owner's overflow menu, #146), rendered top-right
   * above the overlay link so they stay clickable.
   */
  actions?: ReactNode;
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

/** One interaction control; branch-free via per-kind lookup tables. */
const KIND_ACTIVE_FLAG: Record<PostCardInteractionKind, 'reposted' | 'liked' | 'bookmarked'> = {
  repost: 'reposted',
  like: 'liked',
  bookmark: 'bookmarked',
};
const KIND_ICON = { repost: IconRepeat, like: IconHeart, bookmark: IconBookmark } as const;

function interactControl(
  kind: PostCardInteractionKind,
  count: number | null,
  testId: string,
  viewer: PostCardViewer | undefined,
  onInteract: PostCardProps['onInteract'],
  busyKinds: PostCardInteractionKind[],
) {
  const active = viewer?.[KIND_ACTIVE_FLAG[kind]];
  const color = active ? KIND_COLOR[kind] : 'dimmed';
  // Filled heart/bookmark glyphs read as "active" at a glance; the repeat
  // glyph has no filled variant, so colour + aria-pressed carry the state.
  const fill = active && kind !== 'repost' ? 'currentColor' : 'none';
  const Icon = KIND_ICON[kind];
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
      // Above the stretched overlay link (#142): a positioned element so
      // clicks reach the button, not the card's navigation link.
      // min-width/height are load-bearing: WCAG 2.5.8 / axe target-size
      // floor is 24x24 - the compact sm button renders ~18px otherwise.
      style={{ position: 'relative', zIndex: 2, minWidth: 24, minHeight: 24 }}
      onClick={() => onInteract(kind, Boolean(active))}
    >
      {body}
    </UnstyledButton>
  );
}

/** The counts row: reply count + the three interaction controls. */
function CountsRow({
  post,
  viewer,
  onInteract,
  busyKinds = [],
}: Pick<PostCardProps, 'post' | 'viewer' | 'onInteract' | 'busyKinds'>) {
  return (
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
      {interactControl(
        'repost',
        post.counts.reposts,
        'count-reposts',
        viewer,
        onInteract,
        busyKinds,
      )}
      {interactControl('like', post.counts.likes, 'count-likes', viewer, onInteract, busyKinds)}
      {/* Bookmark counts are private to the viewer - icon state only. */}
      {interactControl('bookmark', null, 'count-bookmarks', viewer, onInteract, busyKinds)}
    </Group>
  );
}

/** The ancestor variant: a compact thread-context card (#152). */
function AncestorCard({ author, post, href }: Pick<PostCardProps, 'author' | 'post' | 'href'>) {
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
  actions,
}: PostCardProps) {
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
        <Group wrap="nowrap" gap="xs" align="flex-start">
          <RelativeTime date={post.createdAt} />
          {actions ? (
            // Above the stretched overlay link so the controls stay
            // clickable (#146); anything else in the card navigates.
            <Group gap={0} pos="relative" style={{ zIndex: 2 }}>
              {actions}
            </Group>
          ) : null}
        </Group>
      </Group>

      {repostedBy ? (
        <Text size="xs" c="dimmed" mt={4} data-testid={`post-repost-attribution-${post.id}`}>
          {repostedBy.displayName} (@{repostedBy.username}) reposted
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
    return <AncestorCard author={author} post={post} href={href} />;
  }

  return (
    <Card
      withBorder
      padding="sm"
      radius="md"
      data-testid={`post-${post.id}`}
      style={{ position: 'relative' }}
    >
      {href ? (
        // Stretched link (#142): empty of text nodes, so the browser
        // :visited colour applies to nothing visible. Keyboard focus lands
        // here first (no outline overrides - the default ring shows).
        <Anchor
          href={href}
          unstyled
          aria-label={`View post by @${author.username}`}
          data-testid={`post-link-${post.id}`}
          // display:block is load-bearing: an empty INLINE anchor ignores
          // inset:0's stretch (inline-level abspos skips the width
          // constraint) and renders at intrinsic size - axe measured 18px.
          style={{ position: 'absolute', inset: 0, zIndex: 1, display: 'block' }}
        />
      ) : null}
      {content}

      <CountsRow post={post} viewer={viewer} onInteract={onInteract} busyKinds={busyKinds} />
    </Card>
  );
}
