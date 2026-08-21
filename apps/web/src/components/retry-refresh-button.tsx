'use client';

import { Button } from '@mantine/core';
import { useRouter } from 'next/navigation';

/**
 * Re-runs the current route's server render (a soft reload that keeps the
 * client session). Used by SSR error states whose data fetch failed - the
 * copy says "try again", so the page offers the button.
 */
export function RetryRefreshButton({ label = 'Try again' }: { label?: string }) {
  const router = useRouter();
  return (
    <Button
      size="compact-xs"
      variant="light"
      onClick={() => router.refresh()}
      data-testid="retry-refresh"
    >
      {label}
    </Button>
  );
}
