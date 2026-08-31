import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { Container, Stack, Title } from '@mantine/core';
import { PagePreview } from '@/components/cms/page-preview';
import { PageSections } from '@/components/cms/page-sections';
import { PublicHeader } from '@/components/public-header';
import { getSessionUsername } from '@/lib/auth/session';
import { cmsEnv, loadPage } from '@/lib/cms/content';
import { resolvePreviewId } from '@/lib/cms/preview';

interface CmsPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ preview?: string | string[] }>;
}

export async function generateMetadata({ params }: CmsPageProps): Promise<Metadata> {
  const { slug } = await params;
  const page = await loadPage(slug);
  if (page === undefined) return {};
  return { title: page.title, description: page.description || undefined };
}

/**
 * CMS-defined pages (#215): any single-segment URL no fixed route claims
 * resolves here. Static segments always beat this dynamic route (`about`,
 * `feed`, `/api/*`, ... stay untouched - the reserved-slug guard in
 * loadPage is the second lock on that door), and the (app) catch-all only
 * sees deeper unmatched URLs. Unknown slugs 404 through the root boundary -
 * page URLs are public content, so the plain not-found is the right frame.
 */
export default async function CmsPage({ params, searchParams }: CmsPageProps) {
  const { slug } = await params;
  const previewId = await resolvePreviewId(searchParams);

  // Preview renders are per-request (drafts, uncached - spec 04 exposure).
  if (previewId !== undefined) await connection();
  const username = await getSessionUsername();
  const page = await loadPage(slug, { previewId });
  if (page === undefined) notFound();

  return (
    <>
      <PublicHeader username={username} />
      <Container size="sm" py="xl">
        <Stack gap="lg">
          <Title order={1}>{page.title}</Title>
          {previewId !== undefined ? (
            <PagePreview page={page} previewId={previewId} serverURL={cmsEnv().publicUrl} />
          ) : (
            <PageSections page={page} />
          )}
        </Stack>
      </Container>
    </>
  );
}
