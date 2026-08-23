'use client';

import { PaginatedPostList, type PostCardItem } from '@/components/paginated-post-list';
import { repliesPageAction } from './actions';

export interface ReplyThreadProps {
  postId: string;
  initialItems: PostCardItem[];
  initialCursor: string | null;
}

/**
 * Reply thread with client-side Load more (#41): appends in place instead
 * of the old full-page `?cursor=` anchor jump that scrolled back to the top.
 */
export function ReplyThread({ postId, initialItems, initialCursor }: ReplyThreadProps) {
  return (
    <PaginatedPostList
      initialItems={initialItems}
      initialCursor={initialCursor}
      listTestId="reply-thread"
      fetchPage={(cursor) => repliesPageAction(postId, cursor)}
    />
  );
}
