import { Anchor, Container, Stack, Text, Title } from '@mantine/core';
import { ResetNotice } from '@xitter/ui';
import { DemoCredentials } from '@/components/demo-credentials';
import { PublicHeader } from '@/components/public-header';
import { getSessionUsername } from '@/lib/auth/session';

/**
 * The site's front door (#37, slimmed by #153): the gradient wordmark, a
 * one-line value prop, the unmissable reset notice, a demo-credentials entry
 * point, and the way in. The how-it-works material (CMS intro, stack strip)
 * lives on the About page - X's front door doesn't explain itself. No
 * user-generated content renders pre-login (spec 02 §1.4).
 */
export default async function LandingPage() {
  // Session-aware public header (#38): resolving the cookie makes the page
  // per-request. Signed-out visitors (and a Valkey outage) resolve to null
  // without touching the store.
  const username = await getSessionUsername();

  return (
    <>
      <PublicHeader username={username} />
      <Container size="sm" py="xl">
        <Stack gap="lg">
          <Title order={1}>
            {/* Gradient wordmark (#37): the brand mark and favicons share the
                indigo→cyan gradient (#143). */}
            <Text variant="gradient" gradient={{ from: 'indigo', to: 'cyan', deg: 135 }} inherit>
              xitter
            </Text>
          </Title>

          {/* One line, code-owned (#153): everything explanatory moved to
              About; this just says what the visitor is looking at. */}
          <Text size="lg" c="dimmed">
            A small Twitter/X-style demo - posts, follows, replies, likes and reposts - running on a
            realistic microservices homelab.{' '}
            <Anchor href="/about" size="lg" underline="always">
              Read how it works
            </Anchor>
            .
          </Text>

          {/* Code-rendered by design (spec 04): never CMS-editable away.
              Stays above the fold, unmissable. */}
          <ResetNotice />

          <DemoCredentials />
        </Stack>
      </Container>
    </>
  );
}
