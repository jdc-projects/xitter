'use client';

import { Alert, Button, Group, Text, Textarea } from '@mantine/core';
import { useActionState, useState } from 'react';
import { POST_TEXT_MAX } from '@xitter/api-contracts';
import { createPostAction, type ComposerResult } from '@/lib/posts/actions';

export interface PostComposerProps {
  /** Set when composing a reply inline on a post detail page. */
  replyToId?: string;
  placeholder?: string;
  submitLabel?: string;
  /** Testid prefix so feed and reply composers are distinguishable in e2e. */
  testId?: string;
}

/**
 * Text-only composer (images land with #6). The draft lives in local state:
 * a failed submission keeps it (acceptance criterion), a success clears it.
 * No maxLength on the textarea by design - typing past 512 must surface the
 * friendly counter/server error rather than silently truncating input.
 */
export function PostComposer({
  replyToId,
  placeholder = "What's happening?",
  submitLabel = 'Post',
  testId = 'composer',
}: PostComposerProps) {
  const [text, setText] = useState('');
  const [state, formAction, pending] = useActionState<ComposerResult | undefined, FormData>(
    createPostAction,
    undefined,
  );

  // Clear the draft when a NEW successful result arrives - during render,
  // not in an effect. Failures leave `text` untouched (draft preserved).
  const [handledSuccess, setHandledSuccess] = useState<ComposerResult | undefined>(undefined);
  if (state?.ok && state !== handledSuccess) {
    setHandledSuccess(state);
    setText('');
  }

  const overLimit = text.length > POST_TEXT_MAX;

  return (
    <form action={formAction} data-testid={`${testId}-form`}>
      <input type="hidden" name="replyToId" value={replyToId ?? ''} />
      <Textarea
        name="text"
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        placeholder={placeholder}
        aria-label="Post text"
        autosize
        minRows={2}
        maxRows={8}
        data-testid={`${testId}-textarea`}
      />
      <Group justify="space-between" mt="xs" gap="sm">
        <Text size="xs" c="orange.7" style={{ flex: 1 }} data-testid={`${testId}-pii-reminder`}>
          Demo site: do not enter personal or sensitive data. Anyone can read it and nothing is
          retained - everything is wiped nightly.
        </Text>
        <Text
          size="xs"
          c={overLimit ? 'red' : 'dimmed'}
          fw={overLimit ? 700 : 400}
          data-testid={`${testId}-counter`}
        >
          {text.length}/{POST_TEXT_MAX}
        </Text>
      </Group>
      {state?.error ? (
        <Alert color="red" mt="xs" data-testid={`${testId}-error`}>
          {state.error}
        </Alert>
      ) : null}
      <Group justify="flex-end" mt="sm">
        <Button
          type="submit"
          size="xs"
          loading={pending}
          disabled={!text.trim()}
          data-testid={`${testId}-submit`}
        >
          {submitLabel}
        </Button>
      </Group>
    </form>
  );
}
