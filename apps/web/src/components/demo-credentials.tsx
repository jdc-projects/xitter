import { Anchor, Button, Code, Group, Paper, Stack, Text } from '@mantine/core';

/**
 * Demo-credentials entry point on the landing page (#37): the spec keeps
 * credentials public by design (spec 04) - they used to surface only on
 * /login and /about, so a fresh visitor had to hunt for how to get in.
 */
export function DemoCredentials() {
  return (
    <Paper withBorder p="md" radius="md" data-testid="demo-credentials">
      <Stack gap="xs">
        <Group justify="space-between" gap="sm" wrap="nowrap">
          <Text fw={600}>Log in with a demo account</Text>
          <Button
            component="a"
            href="/login"
            size="xs"
            variant="light"
            data-testid="landing-login-cta"
          >
            Log in
          </Button>
        </Group>
        <Text size="sm" c="dimmed">
          Any of <strong>demo1&ndash;demo10</strong>, password <Code>DemoPass123!</Code> - public
          by design. Anyone can be any demo user, and everything posted is shared. More detail on
          the <Anchor href="/about" size="sm">About page</Anchor>.
        </Text>
      </Stack>
    </Paper>
  );
}
