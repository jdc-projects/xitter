import { Container, Paper, Stack, Text, Title } from '@mantine/core';
import { ResetNotice } from '@xitter/ui';
import { LoginForm } from './login-form';
import { PublicHeader } from '@/components/public-header';
import { redirectIfAuthenticated, sanitizeNextPath } from '@/lib/auth/session';
import { webEnv } from '@/lib/server-env';

export const metadata = { title: 'Log in' };

// Env (Cap keys, base URL) must not be baked at build time.
export const dynamic = 'force-dynamic';

const ERROR_MESSAGES: Record<string, string> = {
  challenge: 'Verification failed - please try again.',
  oidc: 'The login attempt was cancelled or rejected.',
  state: 'The login attempt expired or was replayed - please try again.',
  callback: 'Login could not be completed - please try again.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const nextPath = sanitizeNextPath(next);

  // Already signed in (#40): the form would only start a second OIDC
  // authorization - send the visitor to where they were heading instead.
  await redirectIfAuthenticated(nextPath);

  const cap = webEnv().cap;

  return (
    <>
      {/* Navbar parity with landing/About (#140): the login form renders
          inside the public chrome, always the signed-out variant - a live
          session never reaches this render (redirectIfAuthenticated, #40),
          so the header has nothing to swap in. */}
      <PublicHeader username={null} />
      <Container size="xs" py="xl">
        <Stack gap="md">
          <Title order={1}>Log in</Title>
          <Text size="sm" c="dimmed">
            Demo accounts only - there is no signup. Password: DemoPass123! (e.g. demo1).
          </Text>
          <ResetNotice compact />
          <Paper withBorder p="md" radius="md" data-testid="login-panel">
            <Stack gap="md">
              {error ? (
                <Text size="sm" c="red" role="alert" data-testid="login-error">
                  {ERROR_MESSAGES[error] ?? 'Something went wrong - please try again.'}
                </Text>
              ) : null}
              <LoginForm
                next={nextPath}
                // Fail-fast webEnv(): enabled implies site key and URL are set,
                // and widgetEndpoint already embeds the site key path segment.
                captcha={cap.enabled ? { apiEndpoint: cap.widgetEndpoint } : null}
              />
            </Stack>
          </Paper>
        </Stack>
      </Container>
    </>
  );
}
