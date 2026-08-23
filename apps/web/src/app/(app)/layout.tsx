import { AppShellFrame } from '@/components/app-shell';
import { getSession } from '@/lib/auth/session';

/**
 * Authenticated app shell (#39): the client frame (Mantine AppShell header,
 * icons, active states, mobile drawer) renders user bits only when a
 * session exists. Pages gate themselves via requireSession() - they know
 * their path for the `next` redirect.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  return <AppShellFrame username={session?.username ?? null}>{children}</AppShellFrame>;
}
