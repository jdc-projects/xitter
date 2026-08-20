/**
 * The OpenSearch `posts` index (owner: search service - spec 05). The
 * definition lives here so the search service (boot-time creation) and the
 * local bootstrap script (pre-service creation) cannot drift: both import
 * this one mapping.
 */

export const POSTS_INDEX = 'posts';

/** OpenSearch index-creation body (settings + mappings). */
export function postsIndexDefinition(): {
  settings: Record<string, unknown>;
  mappings: Record<string, unknown>;
} {
  return {
    settings: {
      // Posts are short user text: the english analyser stems plurals/tenses
      // ("searching" matches "search") at negligible index cost for a demo
      // corpus. The standard analyser would split but not stem.
      analysis: {
        analyzer: {
          post_text: {
            type: 'custom',
            tokenizer: 'standard',
            filter: ['lowercase', 'asciifolding', 'porter_stem'],
          },
        },
      },
    },
    mappings: {
      properties: {
        // Document id = postId (upsert key, spec 05).
        postId: { type: 'keyword' },
        authorId: { type: 'keyword' },
        // Denormalised so the index is self-contained; refreshed by the
        // worker on social.profile.updated (update_by_query).
        authorName: { type: 'keyword' },
        text: { type: 'text', analyzer: 'post_text' },
        // Exact-token matching (hashtags) alongside the analysed text.
        keywords: { type: 'keyword' },
        createdAt: { type: 'date' },
        // Tombstone flag: present = soft-deleted; queries must exclude it
        // (spec 04: deletes are tombstones, keyed upserts by postId).
        deletedAt: { type: 'date' },
      },
    },
  };
}
