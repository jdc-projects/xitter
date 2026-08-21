'use client';

import { Alert, type AlertProps, Button, Stack, Text } from '@mantine/core';

export interface ResetNoticeProps extends Omit<AlertProps, 'title' | 'children'> {
  /** Where "read more" points to; defaults to the About page. */
  aboutHref?: string;
  compact?: boolean;
  /** Set false on the About page itself - a read-more link to the current page is noise. */
  link?: boolean;
}

/**
 * The unmissable notice that appears on the landing page and login screen:
 * regular resets, no real data, no PII.
 */
export function ResetNotice({
  aboutHref = '/about',
  compact = false,
  link = true,
  ...alertProps
}: ResetNoticeProps) {
  return (
    <Alert
      color="yellow"
      variant="outline"
      title={<b style={{ color: 'var(--mantine-color-text)' }}>Demo data is reset every night</b>}
      {...alertProps}
      data-testid="reset-notice"
    >
      <Stack gap="xs">
        <Text size={compact ? 'sm' : 'md'}>
          Everything you post here is wiped every night at 00:00 UTC. Do not enter personal or
          sensitive information - this is a public demo.
        </Text>
        {link ? (
          <Button
            component="a"
            href={aboutHref}
            variant="subtle"
            size={compact ? 'xs' : 'sm'}
            w="fit-content"
          >
            Read more about how this works
          </Button>
        ) : null}
      </Stack>
    </Alert>
  );
}
