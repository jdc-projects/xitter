import {
  ApiError,
  MediaClient,
  PostsClient,
  SocialClient,
  localServiceUrls,
} from '@xitter/api-client';
import type { Post, PostViewerState, Profile } from '@xitter/api-contracts';
import { getSession, type Session } from '@/lib/auth/session';

/**
 * Posts/social/media API clients bound to the current session's access token
 * (ADR 0002: the web server calls services, the browser never holds tokens).
 */
export function clientsForSession(session: Session): {
  posts: PostsClient;
  social: SocialClient;
  media: MediaClient;
} {
  const urls = localServiceUrls();
  return {
    posts: new PostsClient({ baseUrl: urls.posts, token: session.accessToken }),
    social: new SocialClient({ baseUrl: urls.social, token: session.accessToken }),
    media: new MediaClient({ baseUrl: urls.media, token: session.accessToken }),
  };
}

/** Session + clients, or null when signed out (callers redirect). */
export async function postsForSession(): Promise<{
  session: Session;
  posts: PostsClient;
  social: SocialClient;
  media: MediaClient;
} | null> {
  const session = await getSession();
  if (!session) return null;
  return { session, ...clientsForSession(session) };
}

/**
 * Profiles for a set of author ids, best-effort per id: a missing profile
 * (e.g. a user who never bootstrapped one) falls back to a placeholder so a
 * whole thread never fails on one bad author.
 */
export async function profilesByAuthorIds(
  social: SocialClient,
  ids: string[],
): Promise<Map<string, Profile>> {
  const unique = [...new Set(ids)];
  const entries = await Promise.all(
    unique.map(async (id): Promise<readonly [string, Profile]> => {
      try {
        return [id, await social.getProfile(id)];
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return [
            id,
            { id, username: 'unknown', displayName: 'Unknown', bio: null, createdAt: '' },
          ];
        }
        throw error;
      }
    }),
  );
  return new Map(entries);
}

/** Contract cap for the batched viewer-state endpoint. */
const VIEWER_STATE_MAX = 100;

/**
 * The viewer's like/repost/bookmark flags for a page of posts (#8),
 * batched. Best-effort: on failure every post renders with empty flags -
 * cards stay usable, only filled-state styling is lost.
 */
export async function viewerStateByPostId(
  posts: PostsClient,
  postIds: string[],
): Promise<Map<string, PostViewerState>> {
  const unique = [...new Set(postIds)].slice(0, VIEWER_STATE_MAX);
  if (unique.length === 0) return new Map();
  try {
    const { items } = await posts.getViewerState(unique);
    return new Map(items.map((state) => [state.postId, state]));
  } catch {
    return new Map();
  }
}
