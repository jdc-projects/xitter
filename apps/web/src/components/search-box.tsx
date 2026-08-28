import { Box, TextInput } from '@mantine/core';
import type { BoxProps } from '@mantine/core';

export interface SearchBoxProps extends BoxProps {
  defaultValue?: string;
  /**
   * Page-level render (/search): the box is the primary control, so it
   * fills the phone viewport instead of the header's compact 140px (#151).
   */
  fluid?: boolean;
}

/**
 * Header/results search box: a plain GET form to /search so queries are
 * shareable links and no client JS is needed. Renders server-side; the
 * results page re-renders it with the active query.
 */
export function SearchBox({ defaultValue = '', fluid = false, ...boxProps }: SearchBoxProps) {
  return (
    <Box component="form" action="/search" method="get" {...boxProps}>
      <TextInput
        name="q"
        defaultValue={defaultValue}
        placeholder="Search posts"
        aria-label="Search posts"
        size="xs"
        w={fluid ? { base: '100%', sm: 200 } : { base: 140, sm: 200 }}
        data-testid="search-input"
      />
    </Box>
  );
}
