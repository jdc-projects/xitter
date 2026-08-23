'use client';

import { PaginatedPostList, type PostCardItem } from '@/components/paginated-post-list';
import { bookmarksPageAction } from './actions';

export interface BookmarksListProps {
  initialItems: PostCardItem[];
  initialCursor: string | null;
}

/**
 * Bookmarks list with client-side Load more (#41): appends in place instead
 * of the old full-page `?cursor=` anchor jump.
 */
export function BookmarksList({ initialItems, initialCursor }: BookmarksListProps) {
  return (
    <PaginatedPostList
      initialItems={initialItems}
      initialCursor={initialCursor}
      listTestId="bookmarks-list"
      fetchPage={bookmarksPageAction}
    />
  );
}
