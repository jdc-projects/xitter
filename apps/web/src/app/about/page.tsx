import { connection } from 'next/server';
import { Anchor, Container, Divider, Stack, Text, Title } from '@mantine/core';
import { ResetNotice } from '@xitter/ui';
import { FaqContentPreview } from '@/components/cms/faq-content-preview';
import { FaqList } from '@/components/cms/faq-list';
import { PublicHeader } from '@/components/public-header';
import { getSessionUsername } from '@/lib/auth/session';
import { cmsEnv, loadFaq } from '@/lib/cms/content';
import { resolvePreviewId } from '@/lib/cms/preview';

export const metadata = { title: 'About' };

const demoAccounts = 'demo1 through demo10';
const demoPassword = 'DemoPass123!';

interface AboutPageProps {
  searchParams: Promise<{ preview?: string | string[] }>;
}

export default async function AboutPage({ searchParams }: AboutPageProps) {
  const previewId = await resolvePreviewId(searchParams);

  // Preview renders are per-request (drafts, uncached - spec 04 exposure).
  if (previewId !== undefined) await connection();
  // Session-aware public header (#38); the page is already per-request.
  const username = await getSessionUsername();
  const faq = await loadFaq({ draft: previewId !== undefined });

  return (
    <>
      <PublicHeader username={username} />
      <Container size="sm" py="xl">
        <Stack gap="lg">
          <Title order={1}>About</Title>

          <section>
            <Title order={2} size="h4">
              What is this?
            </Title>
            <Text>
              xitter is a small Twitter/X-style demo application: text and image posts, a feed of
              the people you follow, replies, likes, bookmarks, reposts, and the ability to follow
              or block other accounts.
            </Text>
          </section>

          <section>
            <Title order={2} size="h4">
              Why does it exist?
            </Title>
            <Text>
              It is a playground for building and demonstrating a realistic microservices system -
              service decomposition, event-driven workers, infrastructure as code, testing and
              observability - on a home Kubernetes cluster, without any real users or data at stake.
            </Text>
          </section>

          <section>
            <Title order={2} size="h4">
              How does it work?
            </Title>
            <Text>
              A Next.js frontend talks to a set of backend APIs (profiles and relationships, posts
              and interactions, media, feed, search). Events flow through Kafka to workers that
              build feeds and search indices. Content is stored in per-service databases and an
              object store. Login uses demo accounts only - there is no signup and no account
              management.
            </Text>
          </section>

          <Divider />

          <section>
            <Title order={2} size="h4">
              Data resets
            </Title>
            {/* Already on the About page - the read-more link would self-reference. */}
            <ResetNotice compact link={false} />
            <Stack mt="sm" gap={4}>
              <Text size="sm">When: every night at 00:30 UTC.</Text>
              <Text size="sm">
                What: everything - posts, follows, media, search indices, and demo account sessions.
                Accounts are restored to their original state, with original passwords.
              </Text>
              <Text size="sm">
                What survives: nothing user-generated. Site content and code changes live in the
                repository, not the environment.
              </Text>
            </Stack>
          </section>

          <section>
            <Title order={2} size="h4">
              Demo accounts
            </Title>
            <Text>
              Log in with any of {demoAccounts}, password {demoPassword}. All accounts are
              equivalent. See the <Anchor href="/login">login page</Anchor> for details.
            </Text>
          </section>

          <section>
            <Title order={2} size="h4">
              FAQ
            </Title>
            {previewId !== undefined ? (
              <FaqContentPreview
                entries={faq}
                previewId={previewId}
                serverURL={cmsEnv().publicUrl}
              />
            ) : (
              <FaqList entries={faq} />
            )}
          </section>

          <Divider />

          <Text size="sm" c="dimmed">
            Unauthenticated visitors cannot see posts or users - log in to look around.
          </Text>
        </Stack>
      </Container>
    </>
  );
}
