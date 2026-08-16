import { Button, Container, Group, Text } from '@mantine/core';
import { getSession } from '@/lib/auth/session';

/**
 * Authenticated app shell. Pages gate themselves via requireSession() (they
 * know their path for the `next` redirect); the shell renders user bits only
 * when a session exists.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  return (
    <Container size="md" py="md">
      <Group justify="space-between" mb="xl" data-testid="app-nav">
        <Group gap="md">
          <Text fw={700} component="a" href="/feed" inherit>
            xitter
          </Text>
          <Text component="a" href="/feed" size="sm" c="dimmed" inherit>
            Feed
          </Text>
        </Group>
        {session ? (
          <Group gap="sm">
            <Text size="sm" c="dimmed" data-testid="nav-username">
              @{session.username}
            </Text>
            <form action="/api/auth/logout" method="post">
              <Button size="xs" variant="subtle" type="submit" data-testid="logout-button">
                Log out
              </Button>
            </form>
          </Group>
        ) : null}
      </Group>
      {children}
    </Container>
  );
}
