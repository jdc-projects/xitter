"use client";

import { Card, Group, Stack, Text } from "@mantine/core";
import {
  IconBookmark,
  IconHeart,
  IconMessageCircle,
  IconRepeat,
} from "@tabler/icons-react";
import { UserAvatar } from "./UserAvatar.js";
import { RelativeTime } from "./RelativeTime.js";

export interface PostCardUser {
  id: string;
  username: string;
  displayName: string;
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
  /** Viewer interactions, for filled icons. */
  viewer?: { liked?: boolean; bookmarked?: boolean; reposted?: boolean };
  bookmarkCount?: number;
}

/**
 * Feed / profile post card. Interaction buttons are presentational here -
 * the web app wires them to its own handlers via props/children when needed.
 */
export function PostCard({ author, post, viewer, bookmarkCount = 0 }: PostCardProps) {
  const iconProps = { size: 18, stroke: 1.5 } as const;
  const actionProps = {
    variant: "subtle",
    size: "compact-sm",
    style: { paddingInline: 6 },
  } as const;

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

      <Text mt="sm" size="sm" style={{ whiteSpace: "pre-wrap" }}>
        {post.text}
      </Text>

      <Group mt="sm" gap="lg">
        <Text component="span" size="sm" c="dimned" data-testid="count-replies">
          <IconMessageCircle {...iconProps} /> {post.counts.replies}
        </Text>
        <Text component="span" size="sm" c={viewer?.reposted ? "teal" : "dimmed"} data-testid="count-reposts">
          <IconRepeat {...iconProps} /> {post.counts.reposts}
        </Text>
        <Text component="span" size="sm" c={viewer?.liked ? "red" : "dimmed"} data-testid="count-likes">
          <IconHeart {...iconProps} /> {post.counts.likes}
        </Text>
        <Text component="span" size="sm" c={viewer?.bookmarked ? "indigo" : "dimmed"} data-testid="count-bookmarks">
          <IconBookmark {...iconProps} /> {bookmarkCount}
        </Text>
      </Group>
    </Card>
  );
}
