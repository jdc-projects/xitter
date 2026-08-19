'use server';

import { ApiError } from '@xitter/api-client';
import { redirect } from 'next/navigation';
import { postsForSession } from '@/lib/posts/server';

export interface UploadSlotResult {
  mediaId?: string;
  uploadUrl?: string;
  error?: string;
}

/**
 * Media upload plumbing for the composer (ADR 0002: the browser never holds
 * tokens). The web server mints the presigned slot and confirms completion;
 * the image BYTES still go browser → RustFS directly - the service and web
 * app never proxy them.
 */
export async function requestUploadAction(input: {
  mimeType: string;
  bytes: number;
}): Promise<UploadSlotResult> {
  const ctx = await postsForSession();
  if (!ctx) redirect('/login');

  try {
    const slot = await ctx.media.createUpload(input);
    return { mediaId: slot.mediaId, uploadUrl: slot.uploadUrl };
  } catch (error) {
    return { error: friendlyUploadError(error) };
  }
}

export interface CompleteResult {
  status?: 'pending' | 'ready' | 'failed';
  error?: string;
}

/** Client callback after the browser PUT; the media service HEAD-verifies. */
export async function completeUploadAction(mediaId: string): Promise<CompleteResult> {
  const ctx = await postsForSession();
  if (!ctx) redirect('/login');

  try {
    const asset = await ctx.media.completeUpload(mediaId);
    return { status: asset.status };
  } catch (error) {
    return { error: friendlyUploadError(error) };
  }
}

/** Poll target while the media-process worker generates the thumb. */
export async function mediaStatusAction(mediaId: string): Promise<CompleteResult> {
  const ctx = await postsForSession();
  if (!ctx) redirect('/login');

  try {
    const asset = await ctx.media.getMedia(mediaId);
    return { status: asset.status };
  } catch (error) {
    return { error: friendlyUploadError(error) };
  }
}

function friendlyUploadError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 413) return 'That image is over the 5MB limit.';
    if (error.status === 415) return 'Images must be png, jpeg, webp or gif.';
    if (error.status === 429) return 'You are uploading too fast - wait a moment.';
  }
  return 'Could not upload that image. Try again shortly.';
}
