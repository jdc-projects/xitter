'use client';

import { Avatar, type AvatarProps } from '@mantine/core';

export interface UserAvatarProps extends Omit<AvatarProps, 'src'> {
  username: string;
  displayName: string;
  /** Deterministic gradient per username when no image is set. */
  hasImage?: boolean;
  imageUrl?: string | null;
}

function gradientFor(username: string): { from: string; to: string } {
  let hash = 0;
  for (const char of username) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  const palettes = [
    { from: 'indigo', to: 'cyan' },
    { from: 'teal', to: 'lime' },
    { from: 'orange', to: 'red' },
    { from: 'grape', to: 'pink' },
    { from: 'blue', to: 'violet' },
  ] as const;
  const palette = palettes[Math.abs(hash) % palettes.length]!;
  return { from: palette.from, to: palette.to };
}

export function UserAvatar({
  username,
  displayName,
  hasImage = false,
  imageUrl,
  ...props
}: UserAvatarProps) {
  if (hasImage && imageUrl) {
    return <Avatar src={imageUrl} alt={displayName} radius="xl" {...props} />;
  }
  const { from, to } = gradientFor(username);
  return (
    <Avatar gradient={{ from, to, deg: 135 }} radius="xl" alt={displayName} {...props}>
      {displayName.slice(0, 1).toUpperCase()}
    </Avatar>
  );
}
