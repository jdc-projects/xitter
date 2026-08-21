import { Anchor, Box, Button, Container, Group, Text } from '@mantine/core';

/**
 * Nav shared by the public pages (landing, About) so unauthenticated
 * visitors can always move between home, About and login (spec 02 §1.5).
 * The authenticated shell renders its own nav and never this header.
 */
export function PublicHeader() {
  return (
    <Box component="header" mb="lg" data-testid="public-header">
      <Container size="sm">
        <Group justify="space-between" py="sm" wrap="nowrap">
          <Text component="a" href="/" fw={700} inherit data-testid="public-brand">
            xitter
          </Text>
          <Group gap="md" wrap="nowrap">
            <Anchor href="/about" size="sm" c="dimmed" data-testid="public-about-link">
              About
            </Anchor>
            <Button
              component="a"
              href="/login"
              size="xs"
              variant="light"
              data-testid="public-login-link"
            >
              Log in
            </Button>
          </Group>
        </Group>
      </Container>
    </Box>
  );
}
