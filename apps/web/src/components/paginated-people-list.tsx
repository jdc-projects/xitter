'use client';

import { Anchor, Group, Stack, Text } from '@mantine/core';
import { UserAvatar } from '@xitter/ui';
import { LoadMoreControl } from './load-more-control';
import { useCursorPages, type CursorPage } from './use-cursor-pages';

export interface PersonItem {
  id: string;
  username: string;
  displayName: string;
}

export interface PaginatedPeopleListProps {
  initialItems: PersonItem[];
  initialCursor: string | null;
  fetchPage: (cursor: string) => Promise<CursorPage<PersonItem>>;
  listTestId: string;
}

/**
 * Cursor-paginated person list (profile following/followers) on the same
 * client-side Load-more pattern as the post lists (#41).
 */
export function PaginatedPeopleList({
  initialItems,
  initialCursor,
  fetchPage,
  listTestId,
}: PaginatedPeopleListProps) {
  const { items, cursor, loading, error, loadMore } = useCursorPages(
    initialItems,
    initialCursor,
    fetchPage,
  );

  return (
    <>
      <Stack gap="xs" mt="sm" data-testid={listTestId}>
        {items.map((person) => (
          <Group key={person.id} gap="sm">
            <UserAvatar username={person.username} displayName={person.displayName} size="sm" />
            {/* Entry reads as neutral text, not a raw hyperlink (#200):
                themed text colour + underline="never", handle dimmed - the
                public-header profile-link idiom. */}
            <Anchor
              href={`/profile/${person.username}`}
              size="sm"
              underline="never"
              c="var(--mantine-color-text)"
              data-testid="profile-list-item"
            >
              <strong>{person.displayName}</strong>{' '}
              <Text component="span" size="sm" c="dimmed" inherit>
                @{person.username}
              </Text>
            </Anchor>
          </Group>
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
