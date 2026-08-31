import { Stack, Text, Title } from '@mantine/core';
import type { PageEntry } from '@/lib/cms/content';

/**
 * Body of a CMS-defined page (#215): ordered sections of optional heading
 * + prose. Shared by the server page and the live-preview client
 * component, exactly like the About sections. Bodies are textarea content,
 * so whitespace (blank-line paragraphs) renders as written.
 */
export function PageSections({ page }: { page: PageEntry }) {
  return (
    <Stack gap="lg">
      {page.sections.map((section, index) => (
        <section key={index}>
          <Stack gap={4}>
            {section.heading ? (
              <Title order={2} size="h4">
                {section.heading}
              </Title>
            ) : null}
            <Text style={{ whiteSpace: 'pre-line' }}>{section.body}</Text>
          </Stack>
        </section>
      ))}
    </Stack>
  );
}
