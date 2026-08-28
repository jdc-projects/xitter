import { Stack, Text, Title } from '@mantine/core';
import type { AboutEntry } from '@/lib/cms/content';

/**
 * CMS-driven About sections (#153, moved from the landing): each entry is a
 * titled section - what this is, why it exists, how it works. Shared by the
 * server page and the live-preview client component.
 *
 * The slug is the anchor id (`about-what` -> `#what`) so deep links (e.g.
 * the reset notice's read-more) can target a section; the prefix is the
 * collection's stable promotion key, so it cannot drift per environment.
 */
export function aboutSectionAnchor(slug: string): string {
  return slug.replace(/^about-/, '');
}

export function AboutSections({ entries }: { entries: AboutEntry[] }) {
  return (
    <Stack gap="lg">
      {entries.map((entry) => (
        <section key={entry.slug} id={aboutSectionAnchor(entry.slug)}>
          <Stack gap={4}>
            <Title order={2} size="h4">
              {entry.title}
            </Title>
            <Text>{entry.intro}</Text>
          </Stack>
        </section>
      ))}
    </Stack>
  );
}
