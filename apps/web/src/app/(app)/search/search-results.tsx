'use client';

import { PaginatedPostList, type PostCardItem } from '@/components/paginated-post-list';
import { searchPageAction } from './actions';

export interface SearchResultsProps {
  query: string;
  initialItems: PostCardItem[];
  initialCursor: string | null;
}

/**
 * Search results list with client-side Load more (#41): appends the next
 * page in place instead of the old full-page `?cursor=` anchor jump.
 */
export function SearchResults({ query, initialItems, initialCursor }: SearchResultsProps) {
  return (
    <PaginatedPostList
      initialItems={initialItems}
      initialCursor={initialCursor}
      listTestId="search-results"
      fetchPage={(cursor) => searchPageAction(query, cursor)}
    />
  );
}
