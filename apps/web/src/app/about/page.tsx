import { connection } from 'next/server';
import { Anchor, Container, Divider, Stack, Text, Title } from '@mantine/core';
import { ResetNotice } from '@xitter/ui';
import { AboutContentPreview } from '@/components/cms/about-content-preview';
import { AboutSections } from '@/components/cms/about-sections';
import { FaqContentPreview } from '@/components/cms/faq-content-preview';
import { FaqList } from '@/components/cms/faq-list';
import { PublicHeader } from '@/components/public-header';
import { StackStrip } from '@/components/stack-strip';
import { getSessionUsername } from '@/lib/auth/session';
import { cmsEnv, loadAboutContent, loadFaq, type FaqEntry } from '@/lib/cms/content';
import { resolvePreviewId } from '@/lib/cms/preview';

export const metadata = { title: 'About' };

const demoAccounts = 'demo1 through demo10';
const demoPassword = 'DemoPass123!';

/**
 * Code-owned FAQ entry (#144): what an unauthenticated visitor can see is a
 * product fact, not site prose (spec 04 rule of thumb), so it rides after
 * the CMS entries instead of living in the CMS.
 */
const VISIBILITY_FAQ: FaqEntry = {
  slug: 'faq-unauthenticated-visibility',
  question: 'What can I see without logging in?',
  answer: 'Unauthenticated visitors cannot see posts or users - log in to look around.',
};

interface AboutPageProps {
  searchParams: Promise<{ preview?: string | string[] }>;
}

export default async function AboutPage({ searchParams }: AboutPageProps) {
  const previewId = await resolvePreviewId(searchParams);

  // Preview renders are per-request (drafts, uncached - spec 04 exposure).
  if (previewId !== undefined) await connection();
  // Session-aware public header (#38); the page is already per-request.
  const username = await getSessionUsername();
  const [sections, faq] = await Promise.all([
    loadAboutContent({ draft: previewId !== undefined }),
    loadFaq({ draft: previewId !== undefined }),
  ]);
  const faqEntries = [...faq, VISIBILITY_FAQ];

  return (
    <>
      <PublicHeader username={username} />
      <Container size="sm" py="xl">
        <Stack gap="lg">
          <Title order={1}>About</Title>

          {/* CMS-managed sections (#153, moved from the landing): what this
              is, why it exists, how it works - prose about the site, so it
              is editable with live preview. */}
          {previewId !== undefined ? (
            <AboutContentPreview
              entries={sections}
              previewId={previewId}
              serverURL={cmsEnv().publicUrl}
            />
          ) : (
            <AboutSections entries={sections} />
          )}

          {/* Code-rendered platform facts (#153, moved from the landing):
              facts must not drift from the deployed reality. */}
          <StackStrip />

          <Divider />

          <section id="resets">
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

          <section id="demo-accounts">
            <Title order={2} size="h4">
              Demo accounts
            </Title>
            <Text>
              Log in with any of {demoAccounts}, password {demoPassword}. All accounts are
              equivalent. See the <Anchor href="/login">login page</Anchor> for details.
            </Text>
          </section>

          <section id="faq">
            <Title order={2} size="h4">
              FAQ
            </Title>
            {previewId !== undefined ? (
              <FaqContentPreview
                entries={faqEntries}
                previewId={previewId}
                serverURL={cmsEnv().publicUrl}
              />
            ) : (
              <FaqList entries={faqEntries} />
            )}
          </section>
        </Stack>
      </Container>
    </>
  );
}
