'use client';

import {
  ActionIcon,
  Alert,
  Button,
  Group,
  Image,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconPhoto, IconX } from '@tabler/icons-react';
import { useActionState, useEffect, useRef, useState } from 'react';
import {
  MEDIA_ALT_TEXT_MAX,
  MEDIA_MAX_BYTES,
  POST_MEDIA_MAX,
  POST_TEXT_MAX,
} from '@xitter/api-contracts';
import { completeUploadAction, mediaStatusAction, requestUploadAction } from '@/lib/media/actions';
import { createPostAction, type ComposerResult } from '@/lib/posts/actions';

// Decorative glyphs (audit #32): the adjacent aria-labels carry the meaning.
const iconProps = { size: 18, stroke: 1.5, 'aria-hidden': true } as const;
const closeIconProps = { size: 14, 'aria-hidden': true } as const;

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
  /** Author-supplied alt text (#133); empty means none was written. */
  altText: string;
}

/** One staged attachment as the hidden input serialises it for submit. */
type MediaEntry = string | { mediaId: string; altText: string };

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
 * Upload the given attachments sequentially, reporting progress via the
 * callback. Returns every uploaded mediaId (in order), or the first friendly
 * error. Module-scope so the component body stays compiler-friendly.
 */
async function uploadAttachments(
  attachments: Attachment[],
  onUpdate: (clientId: string, patch: Partial<Attachment>) => void,
): Promise<{ mediaIds: string[] } | { error: string }> {
  const mediaIds: string[] = [];
  for (const attachment of attachments) {
    onUpdate(attachment.clientId, { status: 'uploading' });
    const result = await uploadThrough(attachment.file);
    if ('error' in result) {
      onUpdate(attachment.clientId, { status: 'failed' });
      return { error: result.error };
    }
    mediaIds.push(result.mediaId);
    onUpdate(attachment.clientId, { status: 'ready', mediaId: result.mediaId });
  }
  return { mediaIds };
}

/** Validate + stage a batch of picked files (friendly errors, no upload). */
function planPickedFiles(
  files: Iterable<File>,
  existing: number,
): { added: Attachment[]; problems: string[] } {
  const added: Attachment[] = [];
  const problems: string[] = [];
  let count = existing;
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
      altText: '',
    });
    count += 1;
  }
  return { added, problems };
}

/**
 * Upload pending attachments before a submit. Returns the ids of everything
 * that is now ready (previously-ready + freshly uploaded) on success, or
 * null with a friendly error shown - leaving the draft intact.
 */
async function submitPendingUploads(
  notReady: Attachment[],
  hooks: {
    setUploading: (value: boolean) => void;
    setUploadError: (error: string | null) => void;
    updateAttachment: (clientId: string, patch: Partial<Attachment>) => void;
  },
): Promise<string[] | null> {
  hooks.setUploading(true);
  hooks.setUploadError(null);
  try {
    const result = await uploadAttachments(notReady, hooks.updateAttachment);
    if ('error' in result) {
      hooks.setUploadError(result.error);
      return null;
    }
    return result.mediaIds;
  } finally {
    hooks.setUploading(false);
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
  const mediaIdsInput = useRef<HTMLInputElement>(null);
  const [state, formAction, pending] = useActionState<ComposerResult | undefined, FormData>(
    createPostAction,
    undefined,
  );

  // Client-only hydration marker: React's event handlers only exist after
  // hydration, and an interaction in the pre-hydration window (fill, file
  // change) is silently discarded when the controlled re-render resets
  // state. Tests wait on this attribute so they never race hydration.
  useEffect(() => {
    formRef.current?.setAttribute('data-hydrated', 'true');
  }, []);

  // Clear the draft when a NEW successful result arrives - during render,
  // not in an effect. Failures leave `text`/attachments untouched.
  const [handledSuccess, setHandledSuccess] = useState<ComposerResult | undefined>(undefined);
  if (state?.ok && state !== handledSuccess) {
    setHandledSuccess(state);
    setText('');
    attachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
    setAttachments([]);
    setUploadError(null);
  }

  const overLimit = text.length > POST_TEXT_MAX;
  /** Bare ids when no alt was written, `{mediaId, altText}` entries when it was. */
  const mediaEntries: MediaEntry[] = attachments.flatMap((attachment) =>
    attachment.status === 'ready' && attachment.mediaId
      ? [attachment.altText ? { mediaId: attachment.mediaId, altText: attachment.altText } : attachment.mediaId]
      : [],
  );

  function pickFiles(files: FileList | null) {
    if (!files) return;
    const { added, problems } = planPickedFiles(files, attachments.length);
    if (added.length > 0) setAttachments((current) => [...current, ...added]);
    setUploadError(problems[0] ?? null);
    if (fileInput.current) fileInput.current.value = '';
  }

  function updateAttachment(clientId: string, patch: Partial<Attachment>) {
    setAttachments((current) =>
      current.map((item) => (item.clientId === clientId ? { ...item, ...patch } : item)),
    );
  }

  function updateAltText(clientId: string, altText: string) {
    // The contract rejects over-limit text; never let the draft exceed it.
    updateAttachment(clientId, { altText: altText.slice(0, MEDIA_ALT_TEXT_MAX) });
  }

  function removeAttachment(clientId: string) {
    setAttachments((current) => {
      const target = current.find((attachment) => attachment.clientId === clientId);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((attachment) => attachment.clientId !== clientId);
    });
  }

  const bypassSubmit = useRef(false);

  /** Upload everything not yet ready, then submit the form for real. */
  async function runSubmit() {
    if (uploading || pending) return;

    const notReady = attachments.filter((attachment) => attachment.status !== 'ready');
    const alreadyReady: MediaEntry[] = attachments.flatMap((attachment) =>
      attachment.status === 'ready' && attachment.mediaId
        ? [
            attachment.altText
              ? { mediaId: attachment.mediaId, altText: attachment.altText }
              : attachment.mediaId,
          ]
        : [],
    );
    const uploaded = notReady.length
      ? await submitPendingUploads(notReady, {
          setUploading,
          setUploadError,
          updateAttachment,
        })
      : [];
    if (!uploaded) return;
    // requestSubmit serialises the CURRENT DOM, which may not have re-rendered
    // with the freshly-ready ids yet - set the hidden input imperatively so
    // the post references the media that was just uploaded (paired with the
    // alt text captured at pick time, in the same order).
    const fresh: MediaEntry[] = notReady.map((attachment, index) => {
      const mediaId = uploaded[index]!;
      return attachment.altText ? { mediaId, altText: attachment.altText } : mediaId;
    });
    const entries = [...alreadyReady, ...fresh];
    if (mediaIdsInput.current) mediaIdsInput.current.value = JSON.stringify(entries);
    bypassSubmit.current = true;
    // requestSubmit() from inside the submit-event dispatch is treated as a
    // nested submission and dropped by some Chromium builds - always defer
    // to a macrotask so the original dispatch has fully unwound.
    setTimeout(() => formRef.current?.requestSubmit(), 0);
  }

  return (
    <form
      action={formAction}
      ref={formRef}
      data-testid={`${testId}-form`}
      onSubmit={(event) => {
        if (bypassSubmit.current) {
          bypassSubmit.current = false;
          return;
        }
        // The button click AND Enter-key implicit submission both land here:
        // route both through the upload flow, or non-ready attachments are
        // silently dropped from the post.
        event.preventDefault();
        void runSubmit();
      }}
    >
      <input type="hidden" name="replyToId" value={replyToId ?? ''} />
      <input
        ref={mediaIdsInput}
        type="hidden"
        name="mediaIds"
        value={JSON.stringify(mediaEntries)}
        data-testid={`${testId}-media-ids`}
      />
      <Textarea
        name="text"
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onKeyDown={(event) => {
          // X-style: Enter posts (through the upload flow), Shift+Enter is a
          // newline. Native Enter in a textarea only inserts a newline.
          if (event.key !== 'Enter' || event.shiftKey || !text.trim()) return;
          if (uploading || pending) return;
          event.preventDefault();
          void runSubmit();
        }}
        placeholder={placeholder}
        aria-label="Post text"
        autosize
        minRows={2}
        maxRows={8}
        data-testid={`${testId}-textarea`}
      />
      {attachments.length > 0 ? (
        <SimpleGrid cols={2} mt="xs" data-testid={`${testId}-previews`}>
          {attachments.map((attachment) => (
            <Stack
              key={attachment.clientId}
              gap={4}
              data-testid={`${testId}-attachment-${attachment.status}`}
            >
              <Group gap={4} wrap="nowrap">
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
                  <IconX {...closeIconProps} />
                </ActionIcon>
              </Group>
              {/* Optional per-image alt text (#133) - shown after picking. */}
              <TextInput
                value={attachment.altText}
                onChange={(event) => updateAltText(attachment.clientId, event.currentTarget.value)}
                placeholder="Describe this image"
                aria-label={`Describe ${attachment.file.name} for screen readers`}
                size="xs"
                maxLength={MEDIA_ALT_TEXT_MAX}
                disabled={attachment.status === 'uploading'}
                data-testid={`${testId}-alt-input`}
              />
            </Stack>
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
              <IconPhoto {...iconProps} />
            </ActionIcon>
          </Tooltip>
          <Text size="xs" c="orange.7" style={{ flex: 1 }} data-testid={`${testId}-pii-reminder`}>
            Demo site: do not enter personal or sensitive data. Anyone can read it and nothing is
            retained - everything is wiped nightly.
            {attachments.length > 0
              ? ' Describing your images (alt text) helps people using screen readers.'
              : ''}
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
          data-testid={`${testId}-submit`}
        >
          {submitLabel}
        </Button>
      </Group>
    </form>
  );
}
