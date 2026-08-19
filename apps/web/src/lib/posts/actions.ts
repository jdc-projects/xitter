'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError } from '@xitter/api-client';
import { POST_MEDIA_MAX, POST_TEXT_MAX } from '@xitter/api-contracts';
import { postsForSession } from './server';

export interface ComposerResult {
  error?: string;
  ok?: boolean;
}

/**
 * Create a post (or reply when replyToId is set). Client-side text checks
 * return friendly copy WITHOUT clearing the composer - the draft stays in
 * the client component's state (acceptance: draft preserved on failure).
 */
/** Friendly copy for the composer's known failure codes. */
function composerErrorFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 400) return `Posts are limited to ${POST_TEXT_MAX} characters.`;
    if (error.status === 403) return 'You cannot reply to this post.';
    if (error.status === 429) return 'You are posting too fast - wait a moment.';
  }
  return 'Could not publish your post. Try again shortly.';
}

/** mediaIds arrive as a JSON string from the composer's hidden input. */
function parseMediaIds(raw: FormDataEntryValue | null): string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.every((id) => typeof id === 'string') &&
      parsed.length <= POST_MEDIA_MAX
    ) {
      return parsed as string[];
    }
  } catch {
    /* fall through: malformed input is dropped, the service re-validates */
  }
  return [];
}

export async function createPostAction(
  _prev: ComposerResult | undefined,
  formData: FormData,
): Promise<ComposerResult> {
  const text = String(formData.get('text') ?? '');
  const replyRaw = formData.get('replyToId');
  const replyToId = typeof replyRaw === 'string' && replyRaw !== '' ? replyRaw : null;
  const mediaIds = parseMediaIds(formData.get('mediaIds'));

  if (!text.trim()) return { error: 'Write something first.' };
  if (text.length > POST_TEXT_MAX) {
    return { error: `Posts are limited to ${POST_TEXT_MAX} characters.` };
  }

  const ctx = await postsForSession();
  if (!ctx) redirect('/login');

  try {
    await ctx.posts.createPost({ text, mediaIds, replyToId });
  } catch (error) {
    return { error: composerErrorFor(error) };
  }

  revalidatePath('/feed');
  if (replyToId) revalidatePath(`/post/${replyToId}`);
  return { ok: true };
}

/**
 * Delete own post. `goTo` redirects after a detail-page delete (the page is
 * gone); `username` revalidates the profile tab the card sat on.
 */
export async function deletePostAction(formData: FormData): Promise<void> {
  const postId = String(formData.get('postId') ?? '');
  const goTo = formData.get('goTo');
  const username = formData.get('username');
  if (!postId) return;

  const ctx = await postsForSession();
  if (!ctx) redirect('/login');

  try {
    await ctx.posts.deletePost(postId);
    revalidatePath('/feed');
    revalidatePath(`/post/${postId}`);
    if (typeof username === 'string' && username) revalidatePath(`/profile/${username}`);
  } catch {
    // Service refused (not yours, already gone): the revalidates below keep
    // the rendered state honest without an error surface on this minimal UI.
    revalidatePath('/feed');
  }
  // Same-origin only: a leading "/" alone still admits protocol-relative
  // "//evil.com" through Location.
  if (typeof goTo === 'string' && goTo.startsWith('/') && !goTo.startsWith('//')) redirect(goTo);
}

export interface InteractResult {
  ok?: boolean;
  error?: string;
}

/**
 * Like/repost/bookmark (and undo) from any post card (#8). Revalidates the
 * pages a touched card can appear on so counts and filled states refresh
 * server-side; the client layer also applies an optimistic flip.
 */
export async function interactAction(
  postId: string,
  kind: 'like' | 'repost' | 'bookmark',
  undo: boolean,
): Promise<InteractResult> {
  if (!postId || !['like', 'repost', 'bookmark'].includes(kind)) {
    return { error: 'Unknown interaction.' };
  }

  const ctx = await postsForSession();
  if (!ctx) redirect('/login');

  try {
    if (undo) await ctx.posts.deleteInteraction(postId, kind);
    else await ctx.posts.createInteraction(postId, kind);
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) {
      return { error: 'You cannot interact with this post.' };
    }
    if (error instanceof ApiError && error.status === 429) {
      return { error: 'You are interacting too fast - wait a moment.' };
    }
    return { error: 'Could not save that right now. Try again shortly.' };
  }

  revalidatePath('/feed');
  revalidatePath(`/post/${postId}`);
  revalidatePath('/bookmarks');
  return { ok: true };
}
