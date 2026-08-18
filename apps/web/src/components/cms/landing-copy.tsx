import { Stack, Text, Title } from '@mantine/core';
import type { LandingEntry } from '@/lib/cms/content';

/**
 * CMS-driven landing copy (shared by the server page and the live-preview
 * client component). The page shell - h1, notices, buttons - stays in code.
 */
export function LandingCopy({ entries }: { entries: LandingEntry[] }) {
  return (
    <Stack gap="md">
      {entries.map((entry) => (
        <Stack key={entry.slug} gap={4}>
          {entry.title ? (
            <Title order={2} size="h4">
              {entry.title}
            </Title>
          ) : null}
          <Text size="lg" c="dimmed">
            {entry.intro}
          </Text>
        </Stack>
      ))}
    </Stack>
  );
}
