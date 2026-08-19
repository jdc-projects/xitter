import type {
  PostCreated,
  PostDeleted,
  ProfileUpdated,
  SearchIndexDocument,
} from '@xitter/api-contracts';

/** Hashtag tokens indexed for exact matching (#foo → "foo"), lowercased. */
export function keywordsFromText(text: string): string[] {
  const matches = text.match(/#([A-Za-z0-9_]+)/g) ?? [];
  return [...new Set(matches.map((token) => token.slice(1).toLowerCase()))];
}

/** Placeholder while a profile row does not exist yet (bootstrap race). */
export const UNKNOWN_AUTHOR = 'Unknown';

/**
 * Live document from posts.post.created. `authorName` is denormalised so
 * the index is self-contained; social.profile.updated keeps it fresh
 * (refreshAuthors), so a placeholder here is eventually corrected.
 */
export function documentFromPostCreated(
  event: PostCreated,
  authorName: string,
): SearchIndexDocument {
  return {
    postId: event.postId,
    authorId: event.authorId,
    authorName,
    text: event.text,
    keywords: keywordsFromText(event.text),
    createdAt: event.createdAt,
    deletedAt: null,
  };
}

/**
 * Tombstone from posts.post.deleted (spec 04: deletes are tombstones
 * keyed-upserted by postId). The delete event carries no body; the
 * placeholder text is never matched because queries exclude deletedAt.
 */
export function tombstoneFromPostDeleted(event: PostDeleted): SearchIndexDocument {
  return {
    postId: event.postId,
    authorId: event.authorId,
    authorName: UNKNOWN_AUTHOR,
    text: '',
    keywords: [],
    createdAt: event.deletedAt,
    deletedAt: event.deletedAt,
  };
}

/** Author-name refresh from social.profile.updated. */
export function authorRefresh(event: ProfileUpdated): { authorId: string; authorName: string } {
  return { authorId: event.profileId, authorName: event.displayName };
}
