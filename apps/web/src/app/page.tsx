import { connection } from 'next/server';
import { Container, Divider, Group, Stack, Text, Title } from '@mantine/core';
import { ResetNotice } from '@xitter/ui';
import { DemoCredentials } from '@/components/demo-credentials';
import { LandingContentPreview } from '@/components/cms/landing-content-preview';
import { LandingCopy } from '@/components/cms/landing-copy';
import { PublicHeader } from '@/components/public-header';
import { LandingAvatarMotif, StackStrip } from '@/components/stack-strip';
import { cmsEnv, loadLandingContent } from '@/lib/cms/content';
import { resolvePreviewId } from '@/lib/cms/preview';

interface LandingPageProps {
  searchParams: Promise<{ preview?: string | string[] }>;
}

/**
 * The site's front door (#37): a hero that carries the demo - wordmark,
 * gradient-avatar motif, the CMS intro - plus the unmissable reset notice,
 * a demo-credentials entry point, and the under-the-hood stack strip. No
 * user-generated content renders pre-login (spec 02 §1.4).
 */
export default async function LandingPage({ searchParams }: LandingPageProps) {
  const previewId = await resolvePreviewId(searchParams);

  // Preview renders are per-request (drafts, uncached - spec 04 exposure).
  if (previewId !== undefined) await connection();
  const entries = await loadLandingContent({ draft: previewId !== undefined });

  return (
    <>
      <PublicHeader />
      <Container size="sm" py="xl">
        <Stack gap="lg">
          <Group gap="md" align="center" wrap="nowrap">
            <LandingAvatarMotif />
            <Title order={1}>
              {/* Gradient wordmark ties into the avatar motif (#37). */}
              <Text variant="gradient" gradient={{ from: 'indigo', to: 'cyan', deg: 135 }} inherit>
                xitter
              </Text>
            </Title>
          </Group>

          {previewId !== undefined ? (
            <LandingContentPreview
              entries={entries}
              previewId={previewId}
              serverURL={cmsEnv().publicUrl}
            />
          ) : (
            <LandingCopy entries={entries} />
          )}

          {/* Code-rendered by design (spec 04): never CMS-editable away.
              Stays above the fold, unmissable. */}
          <ResetNotice />

          <DemoCredentials />

          <Divider />

          <StackStrip />
        </Stack>
      </Container>
    </>
  );
}
