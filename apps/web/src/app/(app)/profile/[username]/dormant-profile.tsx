import { Anchor, Button, Container, Group, Stack, Text, Title } from '@mantine/core';
import { UserAvatar } from '@xitter/ui';

/**
 * Dormant demo profile (#36): the username is a real demo account, but no
 * profile exists yet - profiles are bootstrapped on first login and removed
 * again by the nightly reset. Renders the profile shell with an honest
 * empty state and next actions instead of the generic 404.
 */
export function DormantProfile({ username }: { username: string }) {
  return (
    <Container size="sm" py="xl" data-testid="profile-dormant">
      <Stack gap="sm">
        <Group gap="md" wrap="nowrap" align="center">
          <UserAvatar username={username} displayName={username} size="lg" />
          <Stack gap={4}>
            <Title order={1} size="h2" data-testid="dormant-username">
              @{username}
            </Title>
            <Text size="sm" c="dimmed">
              This account has not logged in yet.
            </Text>
          </Stack>
        </Group>

        <Text size="sm" c="dimmed" data-testid="dormant-explain">
          A profile appears the first time an account logs in, and the nightly reset clears it
          again. Anyone can be any demo user - log in as {username} to bring this one to life.
        </Text>

        <Group gap="sm">
          <Button
            component="a"
            href="/feed"
            size="xs"
            variant="light"
            data-testid="dormant-feed-link"
          >
            Go to the feed
          </Button>
          <Anchor href="/about" size="sm" data-testid="dormant-about-link">
            About the resets
          </Anchor>
        </Group>
      </Stack>
    </Container>
  );
}
