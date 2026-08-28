'use client';

import { Alert, Button, Group } from '@mantine/core';

export interface LoadMoreControlProps {
  /** Next-page cursor; absent/null hides the button (no more pages). */
  cursor: string | null;
  loading: boolean;
  error: string | null;
  onLoadMore: () => void;
}

/**
 * The shared Load-more affordance (#41): a centred client-side button that
 * appends the next page in place, plus the inline error + retry pair every
 * list surface promises (spec 02 §5.7 wording). One `load-more` testid
 * everywhere - no per-page variants.
 */
export function LoadMoreControl({ cursor, loading, error, onLoadMore }: LoadMoreControlProps) {
  return (
    <>
      {cursor ? (
        <Group justify="center">
          <Button
            variant="light"
            // sm (30px) keeps the shared affordance above the 24px touch
            // floor on phones (#151).
            size="sm"
            loading={loading}
            onClick={onLoadMore}
            data-testid="load-more"
          >
            Load more
          </Button>
        </Group>
      ) : null}

      {error ? (
        <Alert color="red" data-testid="load-more-error">
          <Group justify="space-between" gap="sm">
            <span>{error}</span>
            <Button
              // compact-xs renders ~22px tall - below the 24px floor (#151).
              size="xs"
              variant="light"
              loading={loading}
              onClick={onLoadMore}
              data-testid="load-more-retry"
            >
              Try again
            </Button>
          </Group>
        </Alert>
      ) : null}
    </>
  );
}
