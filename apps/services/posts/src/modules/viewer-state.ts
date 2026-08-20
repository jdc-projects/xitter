import type { PostViewerState } from '@xitter/api-contracts';

/** Interaction rows as the repository selects them for derivation. */
export interface ViewerInteractionRow {
  kind: string;
  postId: string;
}

/**
 * Viewer-state derivation (#8): fold a user's interaction rows into
 * like/repost/bookmark flags per requested post. Pure so the flag semantics
 * (absent id = all false, unknown kinds ignored, duplicates impossible via
 * the natural key) are unit-testable without a database.
 */
export function deriveViewerState(
  postIds: readonly string[],
  rows: readonly ViewerInteractionRow[],
): PostViewerState[] {
  const liked = new Set<string>();
  const reposted = new Set<string>();
  const bookmarked = new Set<string>();
  for (const row of rows) {
    if (row.kind === 'like') liked.add(row.postId);
    else if (row.kind === 'repost') reposted.add(row.postId);
    else if (row.kind === 'bookmark') bookmarked.add(row.postId);
  }

  return postIds.map((postId) => ({
    postId,
    liked: liked.has(postId),
    reposted: reposted.has(postId),
    bookmarked: bookmarked.has(postId),
  }));
}
