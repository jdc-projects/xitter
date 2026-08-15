import { Container, Paper, Stack, Text, Title } from "@mantine/core";
import { ResetNotice } from "@xitter/ui";

export const metadata = { title: "Log in" };

export default function LoginPage() {
  return (
    <Container size="xs" py="xl">
      <Stack gap="md">
        <Title order={1}>Log in</Title>
        <Text size="sm" c="dimmed">
          Demo accounts only - there is no signup. Password: DemoPass123! (e.g. demo1).
        </Text>
        <ResetNotice compact />
        <Paper withBorder p="md" radius="md" data-testid="login-panel">
          {/* Login form (Keycloak redirect + Cap.js captcha) lands with the auth ticket. */}
          <Text size="sm" c="dimmed">
            Login form placeholder - see the authentication feature ticket.
          </Text>
        </Paper>
      </Stack>
    </Container>
  );
}
