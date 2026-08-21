import { connection } from 'next/server';
import { Button, Container, Group, Stack, Title } from '@mantine/core';
import { ResetNotice } from '@xitter/ui';
import { LandingContentPreview } from '@/components/cms/landing-content-preview';
import { LandingCopy } from '@/components/cms/landing-copy';
import { PublicHeader } from '@/components/public-header';
import { cmsEnv, loadLandingContent } from '@/lib/cms/content';
import { resolvePreviewId } from '@/lib/cms/preview';

interface LandingPageProps {
  searchParams: Promise<{ preview?: string | string[] }>;
}

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
          <Title order={1}>xitter</Title>

          {previewId !== undefined ? (
            <LandingContentPreview
              entries={entries}
              previewId={previewId}
              serverURL={cmsEnv().publicUrl}
            />
          ) : (
            <LandingCopy entries={entries} />
          )}

          {/* Code-rendered by design (spec 04): never CMS-editable away. */}
          <ResetNotice />

          <Group>
            <Button component="a" href="/login" size="md">
              Log in with a demo account
            </Button>
          </Group>
        </Stack>
      </Container>
    </>
  );
}
