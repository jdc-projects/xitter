import { connection } from 'next/server';
import { Button, Container, Group, Stack, Title } from '@mantine/core';
import { ResetNotice } from '@xitter/ui';
import { LandingContentPreview } from '@/components/cms/landing-content-preview';
import { LandingCopy } from '@/components/cms/landing-copy';
import { cmsEnv, loadLandingContent } from '@/lib/cms/content';

interface LandingPageProps {
  searchParams: Promise<{ preview?: string | string[] }>;
}

export default async function LandingPage({ searchParams }: LandingPageProps) {
  const params = await searchParams;
  const rawPreview = Array.isArray(params.preview) ? params.preview[0] : params.preview;
  const previewId = rawPreview === '' ? undefined : rawPreview;

  // Preview renders are per-request (drafts, auth-gated, never cached).
  if (previewId !== undefined) await connection();
  const entries = await loadLandingContent({ draft: previewId !== undefined });

  return (
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
          <Button component="a" href="/about" variant="subtle" size="md">
            About
          </Button>
        </Group>
      </Stack>
    </Container>
  );
}
