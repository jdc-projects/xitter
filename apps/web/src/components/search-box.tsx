import { Box, TextInput } from '@mantine/core';
import type { BoxProps } from '@mantine/core';

export interface SearchBoxProps extends BoxProps {
  defaultValue?: string;
}

/**
 * Header/results search box: a plain GET form to /search so queries are
 * shareable links and no client JS is needed. Renders server-side; the
 * results page re-renders it with the active query.
 */
export function SearchBox({ defaultValue = '', ...boxProps }: SearchBoxProps) {
  return (
    <Box component="form" action="/search" method="get" {...boxProps}>
      <TextInput
        name="q"
        defaultValue={defaultValue}
        placeholder="Search posts"
        aria-label="Search posts"
        size="xs"
        w={{ base: 140, sm: 200 }}
        data-testid="search-input"
      />
    </Box>
  );
}
