'use client';

import { Alert, Button, Group } from '@mantine/core';
import { useActionState } from 'react';
import { relationshipAction, type ActionResult } from './actions';

export interface ProfileActionsProps {
  userId: string;
  username: string;
  /** `null` = no follow button (own profile, or viewer blocked them). */
  primaryAction: 'follow' | 'unfollow' | null;
  canBlock: boolean;
  blocking: boolean;
}

/**
 * Follow/unfollow/block/unblock. One form, one intent field per button -
 * works without JS as a plain form POST and with JS via useActionState
 * (pending + server-side error copy, e.g. a blocked user's follow 403).
 */
export function ProfileActions({ userId, username, primaryAction, canBlock, blocking }: ProfileActionsProps) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    relationshipAction,
    undefined,
  );

  const intentButton = (intent: string, label: string, variant: 'filled' | 'subtle' | 'outline', testId: string) => (
    <Button
      type="submit"
      name="intent"
      value={intent}
      variant={variant}
      size="xs"
      disabled={pending}
      data-testid={testId}
    >
      {label}
    </Button>
  );

  return (
    <form action={formAction}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="username" value={username} />
      <Group gap="xs" mt="sm">
        {primaryAction === 'follow'
          ? intentButton('follow', 'Follow', 'filled', 'follow-button')
          : null}
        {primaryAction === 'unfollow'
          ? intentButton('unfollow', 'Unfollow', 'subtle', 'unfollow-button')
          : null}
        {canBlock
          ? blocking
            ? intentButton('unblock', 'Unblock', 'outline', 'unblock-button')
            : intentButton('block', 'Block', 'outline', 'block-button')
          : null}
      </Group>
      {state?.error ? (
        <Alert color="red" mt="sm" data-testid="action-error">
          {state.error}
        </Alert>
      ) : null}
    </form>
  );
}
