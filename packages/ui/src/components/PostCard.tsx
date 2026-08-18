'use client';

import { Card, Group, Image, SimpleGrid, Stack, Text } from '@mantine/core';
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

export interface PostCardProps {
  author: PostCardUser;
  post: PostCardPost;
  /** Attached images (callers pick the variant: thumbs in lists, originals on detail). */
  images?: PostCardImage[];
  /** Viewer interactions, for filled icons. */
  viewer?: { liked?: boolean; bookmarked?: boolean; reposted?: boolean };
  bookmarkCount?: number;
}

/**
 * Feed / profile post card. Interaction buttons are presentational here -
 * the web app wires them to its own handlers via props/children when needed.
 */
export function PostCard({
  author,
  post,
  images = [],
  viewer,
  bookmarkCount = 0,
}: PostCardProps) {
  const iconProps = { size: 18, stroke: 1.5 } as const;

  return (
    <Card withBorder padding="sm" radius="md" data-testid={`post-${post.id}`}>
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

      <Group mt="sm" gap="lg">
        <Text component="span" size="sm" c="dimmed" data-testid="count-replies">
          <IconMessageCircle {...iconProps} /> {post.counts.replies}
        </Text>
        <Text
          component="span"
          size="sm"
          c={viewer?.reposted ? 'teal' : 'dimmed'}
          data-testid="count-reposts"
        >
          <IconRepeat {...iconProps} /> {post.counts.reposts}
        </Text>
        <Text
          component="span"
          size="sm"
          c={viewer?.liked ? 'red' : 'dimmed'}
          data-testid="count-likes"
        >
          <IconHeart {...iconProps} /> {post.counts.likes}
        </Text>
        <Text
          component="span"
          size="sm"
          c={viewer?.bookmarked ? 'indigo' : 'dimmed'}
          data-testid="count-bookmarks"
        >
          <IconBookmark {...iconProps} /> {bookmarkCount}
        </Text>
      </Group>
    </Card>
  );
}
