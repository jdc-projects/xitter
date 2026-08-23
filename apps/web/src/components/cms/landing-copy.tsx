import { Stack, Text, Title } from '@mantine/core';
import type { LandingEntry } from '@/lib/cms/content';

/**
 * CMS-driven landing copy (shared by the server page and the live-preview
 * client component). The page shell - hero, notices, credentials, stack
 * strip - stays in code; hero treatment gives the intro larger type (#37).
 */
export function LandingCopy({ entries }: { entries: LandingEntry[] }) {
  return (
    <Stack gap="md">
      {entries.map((entry) => (
        <Stack key={entry.slug} gap={4}>
          {entry.title ? (
            <Title order={2} size="h3">
              {entry.title}
            </Title>
          ) : null}
          <Text size="lg" c="dimmed" fw={500}>
            {entry.intro}
          </Text>
        </Stack>
      ))}
    </Stack>
  );
}
