'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { PersonItem } from '@/components/paginated-people-list';
import type { PostCardItem } from '@/components/paginated-post-list';
import type { CursorPage } from '@/components/use-cursor-pages';
import { getSession } from '@/lib/auth/session';
import { socialForSession } from '@/lib/social/server';
import { loadProfilePeoplePage, loadProfilePostsPage } from './load-profile';

export interface ActionResult {
  error?: string;
}

const RELATIONSHIP_INTENTS = ['follow', 'unfollow', 'block', 'unblock'] as const;
type RelationshipIntent = (typeof RELATIONSHIP_INTENTS)[number];

interface RelationshipForm {
  intent: RelationshipIntent;
  userId: string;
  username: string;
}

function parseRelationshipForm(formData: FormData): RelationshipForm | null {
  const intent = formData.get('intent');
  const userId = formData.get('userId');
  const username = formData.get('username');
  if (typeof intent !== 'string' || !RELATIONSHIP_INTENTS.includes(intent as RelationshipIntent)) {
    return null;
  }
  if (typeof userId !== 'string' || typeof username !== 'string') return null;
  return { intent: intent as RelationshipIntent, userId, username };
}

/**
 * Follow/unfollow/block/unblock behind one form action so the header renders
 * a single error message. Unauthenticated sessions redirect (ADR 0002); a
 * service rejection (block rules 403, rate limit 429, service down) renders
 * as generic copy instead of a 500 - never any detail about tokens.
 */
export async function relationshipAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const form = parseRelationshipForm(formData);
  if (!form) return { error: 'Unknown action.' };

  const path = `/profile/${form.username}`;
  const ctx = await socialForSession();
  if (!ctx) redirect(`/login?next=${encodeURIComponent(path)}`);

  try {
    switch (form.intent) {
      case 'follow':
        await ctx.social.follow(form.userId);
        break;
      case 'unfollow':
        await ctx.social.unfollow(form.userId);
        break;
      case 'block':
        await ctx.social.block(form.userId);
        break;
      case 'unblock':
        await ctx.social.unblock(form.userId);
        break;
    }
    revalidatePath(path);
    return {};
  } catch {
    return { error: 'That did not work - the service refused it. Try again shortly.' };
  }
}

/**
 * Edit own profile (displayName/bio only, spec 8.2). An emptied bio clears
 * the stored bio (null in the contract).
 */
export async function updateProfileAction(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const userId = formData.get('userId');
  const username = formData.get('username');
  if (typeof userId !== 'string' || typeof username !== 'string') {
    return { error: 'Unknown profile.' };
  }

  const path = `/profile/${username}`;
  const ctx = await socialForSession();
  if (!ctx) redirect(`/login?next=${encodeURIComponent(path)}`);

  const displayName = String(formData.get('displayName') ?? '').trim();
  const bio = String(formData.get('bio') ?? '').trim();
  if (displayName === '') return { error: 'Display name cannot be empty.' };

  try {
    await ctx.social.updateProfile(userId, {
      displayName,
      bio: bio === '' ? null : bio,
    });
    revalidatePath(path);
    return {};
  } catch {
    return { error: 'Could not save your profile. Try again shortly.' };
  }
}

/** Session for pagination actions: unauthenticated users bounce via login. */
async function sessionForAction(next: string) {
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(next)}`);
  return session;
}

/** One more profile-posts page for the client list (#41: append in place). */
export async function profilePostsPageAction(
  username: string,
  cursor: string,
): Promise<CursorPage<PostCardItem>> {
  const session = await sessionForAction(`/profile/${username}`);
  try {
    return await loadProfilePostsPage(session, username, cursor);
  } catch {
    return { items: [], nextCursor: null, error: 'Posts could not load right now.' };
  }
}

/** One more following/followers page for the client list (#41). */
export async function profilePeoplePageAction(
  username: string,
  tab: 'following' | 'followers',
  cursor: string,
): Promise<CursorPage<PersonItem>> {
  const session = await sessionForAction(`/profile/${username}?tab=${tab}`);
  try {
    return await loadProfilePeoplePage(session, username, tab, cursor);
  } catch {
    return { items: [], nextCursor: null, error: 'This list could not load right now.' };
  }
}
