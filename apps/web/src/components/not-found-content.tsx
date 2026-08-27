import { Anchor, Button, Container, Group, Stack, Text, Title } from '@mantine/core';

/**
 * Shared 404 body (#135): unmatched routes and soft-deleted posts/profiles
 * (deleted reads as absent by design, spec 03). The reset hint explains why
 * a previously-working link may have vanished overnight. Rendered by both
 * boundaries - the root not-found (signed-out surfaces) and the (app)
 * not-found, which keeps the authenticated shell's nav around it.
 */
export function NotFoundContent() {
  return (
    <Container size="sm" py="xl" data-testid="not-found">
      <Stack gap="sm">
        <Title order={1} size="h2">
          Page not found
        </Title>
        <Text size="sm" c="dimmed">
          That page does not exist - it may have been deleted, or the nightly reset removed it.
        </Text>
        <Group gap="sm">
          <Button component="a" href="/feed" size="xs" variant="light">
            Go to the feed
          </Button>
          <Anchor href="/" size="sm">
            Back to the landing page
          </Anchor>
        </Group>
      </Stack>
    </Container>
  );
}
