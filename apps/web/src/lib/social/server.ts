import { SocialClient, localServiceUrls } from '@xitter/api-client';
import { getSession, type Session } from '@/lib/auth/session';

/**
 * Social API client bound to the current session's access token (ADR 0002:
 * the web server calls services, the browser never holds tokens).
 */
export async function socialForSession(): Promise<{
  session: Session;
  social: SocialClient;
} | null> {
  const session = await getSession();
  if (!session) return null;
  return {
    session,
    social: new SocialClient({ baseUrl: localServiceUrls().social, token: session.accessToken }),
  };
}
