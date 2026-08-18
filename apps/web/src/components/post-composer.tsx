'use client';

import { ActionIcon, Alert, Button, Group, Image, SimpleGrid, Text, Textarea, Tooltip } from '@mantine/core';
import { IconPhoto, IconX } from '@tabler/icons-react';
import { useActionState, useRef, useState } from 'react';
import { MEDIA_MAX_BYTES, POST_MEDIA_MAX, POST_TEXT_MAX } from '@xitter/api-contracts';
import {
  completeUploadAction,
  mediaStatusAction,
  requestUploadAction,
} from '@/lib/media/actions';
import { createPostAction, type ComposerResult } from '@/lib/posts/actions';

export interface PostComposerProps {
  /** Set when composing a reply inline on a post detail page. */
  replyToId?: string;
  placeholder?: string;
  submitLabel?: string;
  /** Testid prefix so feed and reply composers are distinguishable in e2e. */
  testId?: string;
}

type AttachmentStatus = 'new' | 'uploading' | 'processing' | 'ready' | 'failed';

interface Attachment {
  clientId: string;
  file: File;
  previewUrl: string;
  mediaId?: string;
  status: AttachmentStatus;
}

const ACCEPTED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Friendly pre-upload checks (the server re-validates everything). */
function validateFile(file: File, existing: number): string | null {
  if (!ACCEPTED_MIME_TYPES.includes(file.type)) {
    return `"${file.name}" is not a png, jpeg, webp or gif image.`;
  }
  if (file.size > MEDIA_MAX_BYTES) {
    return `"${file.name}" is over the 5MB limit.`;
  }
  if (existing >= POST_MEDIA_MAX) {
    return `A post can have at most ${POST_MEDIA_MAX} images.`;
  }
  return null;
}

/** slot → browser PUT → complete → poll until the worker marks it ready. */
async function uploadThrough(file: File): Promise<{ mediaId: string } | { error: string }> {
  const slot = await requestUploadAction({ mimeType: file.type, bytes: file.size });
  if (slot.error || !slot.mediaId || !slot.uploadUrl) {
    return { error: slot.error ?? 'Upload slot could not be created.' };
  }
  const put = await fetch(slot.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': file.type },
    body: file,
  });
  if (!put.ok) return { error: 'The image could not be uploaded. Try again.' };

  const completed = await completeUploadAction(slot.mediaId);
  if (completed.error) return { error: completed.error };

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) return { error: 'Image processing timed out. Try again.' };
    const status = await mediaStatusAction(slot.mediaId);
    if (status.error) return { error: status.error };
    if (status.status === 'ready') return { mediaId: slot.mediaId };
    if (status.status === 'failed') return { error: 'That image failed processing.' };
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}

/**
 * Post composer with optional images (≤4, png/jpeg/webp/gif, ≤5MB - checked
 * client-side with friendly errors, re-enforced server-side). Bytes go
 * browser → RustFS via the presigned URL; the web app only brokers the slot
 * and the completion callback. The draft (text + attachments) survives a
 * failed submission.
 */
export function PostComposer({
  replyToId,
  placeholder = "What's happening?",
  submitLabel = 'Post',
  testId = 'composer',
}: PostComposerProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState<ComposerResult | undefined, FormData>(
    createPostAction,
    undefined,
  );

  // Clear the draft when a NEW successful result arrives - during render,
  // not in an effect. Failures leave `text`/attachments untouched.
  const [handledSuccess, setHandledSuccess] = useState<ComposerResult | undefined>(undefined);
  if (state?.ok && state !== handledSuccess) {
    setHandledSuccess(state);
    setText('');
    for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
    setAttachments([]);
    setUploadError(null);
  }

  const overLimit = text.length > POST_TEXT_MAX;
  const readyMediaIds = attachments
    .filter((attachment) => attachment.status === 'ready' && attachment.mediaId)
    .map((attachment) => attachment.mediaId!);

  function pickFiles(files: FileList | null) {
    if (!files) return;
    const problems: string[] = [];
    setAttachments((current) => {
      let count = current.length;
      const added: Attachment[] = [];
      for (const file of files) {
        const problem = validateFile(file, count);
        if (problem) {
          problems.push(problem);
          continue;
        }
        added.push({
          clientId: crypto.randomUUID(),
          file,
          previewUrl: URL.createObjectURL(file),
          status: 'new',
        });
        count += 1;
      }
      return [...current, ...added];
    });
    setUploadError(problems[0] ?? null);
    if (fileInput.current) fileInput.current.value = '';
  }

  function removeAttachment(clientId: string) {
    setAttachments((current) => {
      const target = current.find((attachment) => attachment.clientId === clientId);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((attachment) => attachment.clientId !== clientId);
    });
  }

  /** Upload everything not yet ready, then submit the form for real. */
  async function submit(event: React.MouseEvent) {
    event.preventDefault();
    if (uploading || pending) return;

    const pendingFiles = attachments.filter((attachment) => attachment.status !== 'ready');
    if (pendingFiles.length > 0) {
      setUploading(true);
      setUploadError(null);
      try {
        for (const attachment of pendingFiles) {
          setAttachments((current) =>
            current.map((item) =>
              item.clientId === attachment.clientId ? { ...item, status: 'uploading' } : item,
            ),
          );
          const result = await uploadThrough(attachment.file);
          if ('error' in result) {
            setUploadError(result.error);
            setAttachments((current) =>
              current.map((item) =>
                item.clientId === attachment.clientId ? { ...item, status: 'failed' } : item,
              ),
            );
            setUploading(false);
            return;
          }
          setAttachments((current) =>
            current.map((item) =>
              item.clientId === attachment.clientId
                ? { ...item, status: 'ready', mediaId: result.mediaId }
                : item,
            ),
          );
        }
      } finally {
        setUploading(false);
      }
    }
    formRef.current?.requestSubmit();
  }

  return (
    <form action={formAction} ref={formRef} data-testid={`${testId}-form`}>
      <input type="hidden" name="replyToId" value={replyToId ?? ''} />
      <input
        type="hidden"
        name="mediaIds"
        value={JSON.stringify(readyMediaIds)}
        data-testid={`${testId}-media-ids`}
      />
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
      {attachments.length > 0 ? (
        <SimpleGrid cols={4} mt="xs" data-testid={`${testId}-previews`}>
          {attachments.map((attachment) => (
            <Group
              key={attachment.clientId}
              gap={4}
              wrap="nowrap"
              data-testid={`${testId}-attachment-${attachment.status}`}
            >
              <Image
                src={attachment.previewUrl}
                alt={attachment.file.name}
                radius="sm"
                fit="cover"
                h={64}
                maw={96}
              />
              <ActionIcon
                variant="subtle"
                color="gray"
                size="xs"
                aria-label={`Remove ${attachment.file.name}`}
                onClick={() => removeAttachment(attachment.clientId)}
                data-testid={`${testId}-remove`}
              >
                <IconX size={14} />
              </ActionIcon>
            </Group>
          ))}
        </SimpleGrid>
      ) : null}
      <Group justify="space-between" mt="xs" gap="sm">
        <Group gap="xs">
          <Tooltip label={`Up to ${POST_MEDIA_MAX} images (png/jpeg/webp/gif, 5MB each)`}>
            <ActionIcon
              variant="subtle"
              aria-label="Attach images"
              onClick={() => fileInput.current?.click()}
              disabled={attachments.length >= POST_MEDIA_MAX}
              data-testid={`${testId}-attach`}
            >
              <IconPhoto size={18} />
            </ActionIcon>
          </Tooltip>
          <Text size="xs" c="orange.7" style={{ flex: 1 }} data-testid={`${testId}-pii-reminder`}>
            Demo site: do not enter personal or sensitive data. Anyone can read it and nothing is
            retained - everything is wiped nightly.
          </Text>
        </Group>
        <Text
          size="xs"
          c={overLimit ? 'red' : 'dimmed'}
          fw={overLimit ? 700 : 400}
          data-testid={`${testId}-counter`}
        >
          {text.length}/{POST_TEXT_MAX}
        </Text>
      </Group>
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPTED_MIME_TYPES.join(',')}
        multiple
        hidden
        onChange={(event) => pickFiles(event.currentTarget.files)}
        data-testid={`${testId}-file-input`}
      />
      {uploadError ? (
        <Alert color="red" mt="xs" data-testid={`${testId}-upload-error`}>
          {uploadError}
        </Alert>
      ) : null}
      {state?.error ? (
        <Alert color="red" mt="xs" data-testid={`${testId}-error`}>
          {state.error}
        </Alert>
      ) : null}
      <Group justify="flex-end" mt="sm">
        <Button
          type="submit"
          size="xs"
          loading={pending || uploading}
          disabled={!text.trim()}
          onClick={submit}
          data-testid={`${testId}-submit`}
        >
          {submitLabel}
        </Button>
      </Group>
    </form>
  );
}
