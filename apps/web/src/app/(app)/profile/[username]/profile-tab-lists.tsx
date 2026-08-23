'use client';

import { PaginatedPeopleList, type PersonItem } from '@/components/paginated-people-list';
import { PaginatedPostList, type PostCardItem } from '@/components/paginated-post-list';
import { profilePeoplePageAction, profilePostsPageAction } from './actions';

export interface ProfileTabListsProps {
  username: string;
  tab: 'posts' | 'following' | 'followers';
  posts: { items: PostCardItem[]; nextCursor: string | null } | null;
  people: { items: PersonItem[]; nextCursor: string | null } | null;
}

/**
 * The profile tab's paginated list (#41): posts or following/followers,
 * appends in place via the matching server action instead of the old
 * full-page `?cursor=` anchor jumps.
 */
export function ProfileTabLists({ username, tab, posts, people }: ProfileTabListsProps) {
  if (tab === 'posts') {
    return posts ? (
      <PaginatedPostList
        initialItems={posts.items}
        initialCursor={posts.nextCursor}
        listTestId="profile-posts"
        fetchPage={(cursor) => profilePostsPageAction(username, cursor)}
      />
    ) : null;
  }
  return people ? (
    <PaginatedPeopleList
      initialItems={people.items}
      initialCursor={people.nextCursor}
      listTestId="profile-people"
      fetchPage={(cursor) => profilePeoplePageAction(username, tab, cursor)}
    />
  ) : null;
}
