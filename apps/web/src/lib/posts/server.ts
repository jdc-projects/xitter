import {
  ApiError,
  MediaClient,
  PostsClient,
  SocialClient,
  localServiceUrls,
} from '@xitter/api-client';
import type { Profile } from '@xitter/api-contracts';
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
