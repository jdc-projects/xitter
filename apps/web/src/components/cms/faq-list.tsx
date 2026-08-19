import { Stack, Text } from '@mantine/core';
import type { FaqEntry } from '@/lib/cms/content';

/** CMS-driven FAQ list (About page), shared with the live-preview client component. */
export function FaqList({ entries }: { entries: FaqEntry[] }) {
  return (
    <Stack gap="xs">
      {entries.map((entry) => (
        <Text key={entry.slug}>
          <b>{entry.question}</b> {entry.answer}
        </Text>
      ))}
    </Stack>
  );
}
