#!/usr/bin/env tsx
/**
 * Deterministic seeder: `tsx packages/scripts/src/seed.ts`.
 *
 * Turns the pure corpus (corpus.ts, faker seed 42) into service API calls
 * against whatever environment the env points at - local ports, a shared
 * edge base, or in-cluster service URLs (see lib/targets.ts). Derived
 * stores (feed, search) are NEVER written directly: the seeder exercises
 * the same public APIs and Kafka events the product emits, and the fanout /
 * search-index workers rebuild them exactly as in production.
 *
 * Idempotent: keyed upserts through the services (ensure-profile, follow,
 * interact are idempotent by design); a re-run over a seeded environment
 * is verified and skipped. Spec: docs/specs/data/02-seeding.md.
 */
import { envInt, envString, loadRepoEnv } from '@xitter/config';
import { applyCmsContent } from './content.js';
import {
  buildCorpus,
  type CorpusCounts,
  type CorpusPost,
  type CorpusUser,
  type SeedCorpus,
} from './corpus.js';
import { demoPng } from './lib/images.js';
import {
  isAmbiguousFailure,
  requestJson,
  SEED_RETRY_CREATE,
  SEED_RETRY_IDEMPOTENT,
  type RetryPolicy,
} from './lib/api.js';
import { PasswordGrant, resetServiceToken, serviceBase, type ApiTarget } from './lib/targets.js';

const POSTS_PAGE_LIMIT = 50;
const SEED_IMAGE_SEED = 0x5eed;

export interface SeedUser {
  username: string;
  /** Keycloak subject - profiles and posts hang off it. */
  userId: string;
}

export interface SeedOptions {
  /** Pre-resolved demo users (tests / the reset flow reuse the realm result). */
  users?: SeedUser[];
  corpus?: SeedCorpus;
  fetchImpl?: typeof fetch;
  /**
   * The run's stamp time (#150): corpus ages are `stampTime - post.ageMs`.
   * Defaults to now; tests pin it to assert the exact back-dated wire values.
   */
  stampTimeMs?: number;
  /** Wait budget for media processing + fanout convergence (ms). */
  convergenceTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface SeedReport {
  fingerprint: string;
  counts: CorpusCounts;
  /** True when the environment already held the exact corpus (no-op run). */
  skipped: boolean;
  created: {
    profiles: number;
    follows: number;
    mediaUploads: number;
    posts: number;
    likes: number;
    bookmarks: number;
    reposts: number;
  };
}

interface SeedContext {
  corpus: SeedCorpus;
  ids: Map<string, string>;
  doFetch: typeof fetch;
  grants: PasswordGrant;
  /**
   * svc-reset client-credentials token (#150): post creation goes through
   * posts' internal create, the only path that accepts an explicit
   * createdAt. Same credential the reset flow itself holds.
   */
  serviceToken: { get(): Promise<string> };
  /** The run's stamp time: corpus ages are seedTime - post.ageMs. */
  seedTime: number;
  convergenceTimeoutMs: number;
  log: (message: string) => void;
  call(
    target: ApiTarget,
    init: RequestArgs,
    token?: string,
    policy?: RetryPolicy,
  ): Promise<unknown>;
}

type RequestArgs = Parameters<typeof requestJson>[2] & { path: string };

export async function runSeed(options: SeedOptions = {}): Promise<SeedReport> {
  loadRepoEnv();
  const corpus = options.corpus ?? buildCorpus();
  const users = options.users ?? (await resolveDemoUsers(corpus));
  const doFetch = options.fetchImpl ?? fetch;

  if (users.length !== corpus.users.length) {
    throw new Error(
      `corpus expects ${corpus.users.length} users, resolved ${users.length} - re-run keycloak init`,
    );
  }
  const ctx: SeedContext = {
    corpus,
    ids: new Map(users.map((u) => [u.username, u.userId])),
    doFetch,
    grants: new PasswordGrant({ fetchImpl: doFetch }),
    serviceToken: resetServiceToken(doFetch),
    // One stamp time for the whole run: every post's createdAt derives from
    // it minus the corpus age, so the seeded history is internally ordered.
    seedTime: options.stampTimeMs ?? Date.now(),
    convergenceTimeoutMs: options.convergenceTimeoutMs ?? 90_000,
    log: options.log ?? console.log,
    // Retry policies (#82, split #85): rides out deploy pod-churn
    // (5xx/ECONNREFUSED) on every call, but split by idempotency - the
    // default (SEED_RETRY_IDEMPOTENT) covers keyed upserts and reads;
    // plain creates opt into SEED_RETRY_CREATE per call site. Scoped here
    // so the reset steps' one-shot wipes never silently retry.
    call: (target, init, token, policy = SEED_RETRY_IDEMPOTENT) =>
      requestJson(serviceBase(target), init.path, init, token, doFetch, policy),
  };

  // --- Probe: fresh / seeded / partial -------------------------------------
  const existing = await skipIfSeeded(ctx);
  if (existing) return existing;

  // --- Phases 1-6, then verify (derived stores converge via the workers) ----
  const created = await seedCorpusContent(ctx);
  await verifySeeded(ctx);
  ctx.log(`seed: verified (fingerprint ${corpus.fingerprint.slice(0, 12)})`);
  return { fingerprint: corpus.fingerprint, counts: corpus.counts, skipped: false, created };
}

/** No-op report for a corpus that is already fully present. */
function skippedReport(corpus: SeedCorpus): SeedReport {
  return {
    fingerprint: corpus.fingerprint,
    counts: corpus.counts,
    skipped: true,
    created: emptyCreated(),
  };
}

/**
 * Short-circuit for a probed environment: an exact corpus verifies and
 * reports a no-op, corpus-plus-extras only reports, and a partial corpus
 * refuses to patch. `null` means fresh - seed it.
 */
async function skipIfSeeded(ctx: SeedContext): Promise<SeedReport | null> {
  const probe = await probeState(ctx);
  if (probe === 'seeded') {
    ctx.log('seed: corpus already present - verifying derived stores');
    await verifySeeded(ctx);
    return skippedReport(ctx.corpus);
  }
  if (probe === 'seeded-plus') {
    // Corpus fully present plus unrelated content (e.g. e2e posts created on
    // top): nothing to add, exact-count verification is not meaningful.
    ctx.log('seed: corpus already present (extra content detected) - skipping');
    return skippedReport(ctx.corpus);
  }
  if (probe === 'partial') {
    throw new Error(
      'seed: environment holds a partial corpus - run a reset first (npm run reset / the nightly reset job)',
    );
  }
  return null;
}

/** Phase 1 (spec order: users -> profiles). Keyed upsert per corpus user. */
async function ensureProfiles(ctx: SeedContext): Promise<number> {
  for (const user of ctx.corpus.users) {
    const token = await ctx.grants.token(user.username);
    await ctx.call(
      'social',
      {
        method: 'POST',
        path: `/api/social/v1/profiles/${ctx.ids.get(user.username)}`,
        body: { displayName: user.displayName, bio: user.bio },
      },
      token,
    );
  }
  ctx.log(`seed: ${ctx.corpus.users.length} profiles ensured`);
  return ctx.corpus.users.length;
}

/** Phase 2: the follow graph (idempotent follow upserts). */
async function seedFollowGraph(ctx: SeedContext): Promise<number> {
  for (const follow of ctx.corpus.follows) {
    const follower = ctx.corpus.users[follow.followerIndex]!;
    const followee = ctx.corpus.users[follow.followeeIndex]!;
    const token = await ctx.grants.token(follower.username);
    await ctx.call(
      'social',
      { method: 'POST', path: `/api/social/v1/profiles/${ctx.ids.get(followee.username)}/follow` },
      token,
    );
  }
  ctx.log(`seed: ${ctx.corpus.follows.length} follows created`);
  return ctx.corpus.follows.length;
}

/**
 * Phase 3: media uploads through the real pipeline - upload slot ->
 * presigned PUT -> completion -> worker processing.
 */
async function seedMedia(
  ctx: SeedContext,
): Promise<{ bySlot: Map<string, string>; count: number }> {
  const bySlot = new Map<string, string>();
  for (const post of ctx.corpus.posts.filter((p) => p.mediaCount > 0)) {
    bySlot.set(slotKey(post), await uploadDemoImage(post, ctx));
  }
  if (bySlot.size > 0) ctx.log(`seed: ${bySlot.size} images processed`);
  return { bySlot, count: bySlot.size };
}

/**
 * Phase 4: posts (standalone first, then thread replies), back-dated (#150):
 * each post's createdAt is `seedTime - post.ageMs` from the deterministic
 * corpus, so the seeded timeline spans ~7 days instead of the run's ~16s.
 * Creation goes through posts' internal create (svc-reset token) - the
 * public API keeps minting timestamps server-side.
 */
async function seedPosts(
  ctx: SeedContext,
  mediaBySlot: Map<string, string>,
): Promise<{ idBySlot: Map<string, string>; count: number }> {
  const idBySlot = new Map<string, string>();
  for (const post of ctx.corpus.posts) {
    const author = ctx.corpus.users[post.authorIndex]!;
    const token = await ctx.grants.token(author.username);
    const replyToId = post.replyTo ? idBySlot.get(slotKey(post.replyTo)) : null;
    if (post.replyTo && !replyToId) {
      throw new Error(`reply target missing for ${author.username}/post-${post.ordinal}`);
    }
    const mediaIds = mediaBySlot.has(slotKey(post)) ? [mediaBySlot.get(slotKey(post))!] : [];
    // Alt text (#133) rides the mediaIds entry for this post's image.
    const media = post.imageAlt
      ? mediaIds.map((mediaId) => ({ mediaId, altText: post.imageAlt! }))
      : mediaIds;
    // The guard above threw when a reply's parent was missing, so the null
    // fallback here is unreachable for replies by construction.
    const createdPost = await createPost(
      ctx,
      author,
      {
        text: post.text,
        mediaIds: media,
        replyToId: replyToId ?? null,
        createdAt: new Date(ctx.seedTime - post.ageMs).toISOString(),
      },
      token,
    );
    idBySlot.set(slotKey(post), createdPost.id);
  }
  ctx.log(`seed: ${idBySlot.size} posts created (incl. replies)`);
  return { idBySlot, count: idBySlot.size };
}

/**
 * Post create with ambiguity reconciliation (#85). The internal create mints
 * a fresh uuid, so a blind retry after an in-flight failure (ETIMEDOUT after
 * the server committed) would double-create - per-user counts then fail
 * verifySeeded and the night is wasted. Only provably-unprocessed causes
 * retry inside the call (SEED_RETRY_CREATE); an ambiguous failure instead
 * probes the author timeline for an exact-text twin. Found = the create
 * landed (adopt its id); absent = it never did, so one deliberate
 * re-create is safe. No loop: a second ambiguous failure fails the run.
 */
async function createPost(
  ctx: SeedContext,
  author: CorpusUser,
  body: {
    text: string;
    mediaIds: (string | { mediaId: string; altText: string })[];
    replyToId: string | null;
    createdAt: string;
  },
  authorToken: string,
): Promise<{ id: string }> {
  const create = () =>
    ctx.serviceToken.get().then((serviceToken) =>
      ctx.call(
        'posts',
        {
          method: 'POST',
          // Internal (svc-reset) path: the only create that accepts createdAt.
          path: '/api/posts/internal/posts',
          body: { ...body, authorId: ctx.ids.get(author.username) },
        },
        // Service token, not the author's: the internal route is machine-only.
        serviceToken,
        SEED_RETRY_CREATE,
      ),
    ) as Promise<{ id: string }>;
  try {
    return await create();
  } catch (err) {
    if (!isAmbiguousFailure(err)) throw err;
    const twinId = await findTwinPost(ctx, author, body.text, authorToken);
    if (twinId) {
      ctx.log(`seed: ambiguous post-create failure reconciled (adopted existing post for text)`);
      return { id: twinId };
    }
    return await create();
  }
}

/**
 * Exact-text twin on the author's timeline - the primary store, so the
 * read is strongly consistent (unlike the worker-derived feed/search).
 * Corpus texts are unique per author (pinned in corpus.test.ts), so a
 * twin identifies THE post; several would mean pre-existing duplication
 * and fail loudly rather than guess.
 */
async function findTwinPost(
  ctx: SeedContext,
  author: CorpusUser,
  text: string,
  token: string,
): Promise<string | null> {
  const userId = ctx.ids.get(author.username)!;
  const page = (await ctx.call(
    'posts',
    {
      method: 'GET',
      path: `/api/posts/v1/users/${userId}/posts?limit=${POSTS_PAGE_LIMIT}`,
    },
    token,
  )) as { items?: Array<{ id: string; text: string; deletedAt?: string | null }> };
  // Tombstones never count (a deleted twin cannot carry replies/media).
  const twins = (page.items ?? []).filter(
    (item) => (item.deletedAt ?? null) === null && item.text === text,
  );
  if (twins.length > 1) {
    throw new Error(
      `ambiguous reconciliation: ${twins.length} exact-text posts for ${author.username}`,
    );
  }
  return twins[0]?.id ?? null;
}

/** Phase 5: likes / reposts / bookmarks against the created posts. */
async function seedInteractions(
  ctx: SeedContext,
  postIdBySlot: Map<string, string>,
): Promise<Pick<SeedReport['created'], 'likes' | 'reposts' | 'bookmarks'>> {
  const created = { likes: 0, reposts: 0, bookmarks: 0 };
  for (const interaction of ctx.corpus.interactions) {
    const actor = ctx.corpus.users[interaction.userIndex]!;
    const postId = postIdBySlot.get(slotKey(interaction.post));
    if (!postId) throw new Error(`interaction target missing (${actor.username})`);
    const token = await ctx.grants.token(actor.username);
    await ctx.call(
      'posts',
      {
        method: 'POST',
        path: `/api/posts/v1/posts/${postId}/interactions`,
        body: { kind: interaction.kind },
      },
      token,
    );
    if (interaction.kind === 'like') created.likes += 1;
    else if (interaction.kind === 'bookmark') created.bookmarks += 1;
    else created.reposts += 1;
  }
  ctx.log(
    `seed: ${created.likes} likes, ${created.reposts} reposts, ${created.bookmarks} bookmarks`,
  );
  return created;
}

/** Phases 1-6 in spec order, returning the created-counts report. */
async function seedCorpusContent(ctx: SeedContext): Promise<SeedReport['created']> {
  const created = emptyCreated();
  created.profiles = await ensureProfiles(ctx);
  created.follows = await seedFollowGraph(ctx);
  const media = await seedMedia(ctx);
  created.mediaUploads = media.count;
  const posts = await seedPosts(ctx, media.bySlot);
  created.posts = posts.count;
  const interactions = await seedInteractions(ctx, posts.idBySlot);
  created.likes = interactions.likes;
  created.reposts = interactions.reposts;
  created.bookmarks = interactions.bookmarks;

  // --- 6. Promoted CMS content -----------------------------------------------
  // Same skip flag as the reset's own CMS step: dev does not wire the
  // admin-realm CMS client (reset.tf's T9 note), so applying content there
  // token-fetches a realm that does not exist and fails the seed after all
  // corpus work already landed. Environments that wire the client apply
  // content; dev skips visibly. The phase's own calls retry transient
  // failures inside content.ts (#85) - slug-keyed upserts, so the full
  // policy with create-path reconciliation.
  if (envString('XITTER_RESET_SKIP_CMS', '') === '1') {
    ctx.log('seed: cms content skipped (XITTER_RESET_SKIP_CMS)');
  } else {
    const cms = await applyCmsContent({ fetchImpl: ctx.doFetch });
    ctx.log(`seed: cms content ${cms.created} created, ${cms.updated} updated`);
  }
  return created;
}

// ---------------------------------------------------------------------------
// State probe
// ---------------------------------------------------------------------------

type ProbeState = 'fresh' | 'seeded' | 'seeded-plus' | 'partial';

type UserProbe = 'matching' | 'at-least' | 'empty' | 'absent';

/** Per-user visible post count via the public timeline (user-gated read). */
async function userPostCount(
  ctx: SeedContext,
  user: CorpusUser,
  userId: string,
  token?: string,
): Promise<number> {
  const authToken = token ?? (await ctx.grants.token(user.username));
  return ctx
    .call(
      'posts',
      {
        method: 'GET',
        path: `/api/posts/v1/users/${userId}/posts?limit=${POSTS_PAGE_LIMIT}`,
      },
      authToken,
    )
    .then(countPageItems);
}

async function probeState(ctx: SeedContext): Promise<ProbeState> {
  const seen: Record<UserProbe, number> = { matching: 0, 'at-least': 0, empty: 0, absent: 0 };
  for (const [index, user] of ctx.corpus.users.entries()) {
    seen[await probeUser(ctx, index, user)] += 1;
  }
  const total = ctx.corpus.users.length;
  if (seen.matching === total) return 'seeded';
  if (seen.matching + seen['at-least'] === total) return 'seeded-plus';
  if (seen.matching > 0 || seen['at-least'] > 0 || (seen.empty > 0 && seen.empty < total)) {
    return 'partial';
  }
  return 'fresh';
}

/** One user's slice of the probe: exact / at-least / empty / absent. */
async function probeUser(ctx: SeedContext, index: number, user: CorpusUser): Promise<UserProbe> {
  const userId = ctx.ids.get(user.username)!;
  // The reads are user-gated (global AuthGuard) - probe as the user.
  const token = await ctx.grants.token(user.username);
  const [profileRes, postsRes] = await Promise.allSettled([
    ctx.call(
      'social',
      {
        method: 'GET',
        path: `/api/social/v1/profiles/username/${user.username}`,
      },
      token,
    ),
    userPostCount(ctx, user, userId, token),
  ]);
  const expectedPosts = ctx.corpus.posts.filter((p) => p.authorIndex === index).length;
  const count = postsRes.status === 'fulfilled' ? postsRes.value : -1;
  if (profileRes.status === 'fulfilled' && count === expectedPosts) return 'matching';
  if (profileRes.status === 'fulfilled' && count >= expectedPosts) return 'at-least';
  if (profileRes.status === 'rejected' && count === 0) return 'empty';
  return 'absent';
}

// ---------------------------------------------------------------------------
// Media (the real pipeline)
// ---------------------------------------------------------------------------

/**
 * Media upload slot under the narrow policy (#85). Unlike post create
 * there is NO cheap reconciliation here: the media API exposes no
 * user-scoped enumeration (only the admin-internal list), so a probe
 * cannot discover whether an ambiguously-failed slot landed, and no way
 * to re-mint a presigned URL for an existing slot either. Adding either
 * would be product API surface for a seed-only concern - deliberately
 * out of scope. So ambiguous causes fail the run instead of retried
 * creates; the cost is bounded (an orphan slot lingers `pending` until
 * the next nightly wipe) and verifySeeded is unaffected either way.
 */
async function ensureUploadSlot(
  ctx: SeedContext,
  body: { mimeType: string; bytes: number },
  token: string,
): Promise<{ mediaId: string; uploadUrl: string }> {
  return (await ctx.call(
    'media',
    { method: 'POST', path: '/api/media/v1/uploads', body },
    token,
    SEED_RETRY_CREATE,
  )) as { mediaId: string; uploadUrl: string };
}

async function uploadDemoImage(post: CorpusPost, ctx: SeedContext): Promise<string> {
  const author = ctx.corpus.users[post.authorIndex]!;
  const token = await ctx.grants.token(author.username);
  // The corpus pins the pattern/size (#150); bytes stay a pure function of
  // (seed, spec) so every environment uploads identical objects.
  const bytes = demoPng(SEED_IMAGE_SEED + post.authorIndex, post.imageSpec ?? undefined);
  const slot = await ensureUploadSlot(
    ctx,
    { mimeType: 'image/png', bytes: bytes.byteLength },
    token,
  );

  // The presigned URL signs the content type - the PUT must repeat it.
  // The PUT is inherently idempotent (same key, same bytes) and the seed
  // runs right after the reset's bucket wipe, so the object store holds
  // nothing this run did not write - a re-PUT can never corrupt state.
  const put = await ctx.doFetch(slot.uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: bytes,
  });
  if (!put.ok) throw new Error(`media PUT failed: ${put.status} ${await put.text()}`);

  // Media's own contract: `complete` re-HEADs the exact key and a repeat
  // call never re-emits - a server-side idempotent repeat, so the full
  // policy rides out pod-churn here.
  await ctx.call(
    'media',
    { method: 'POST', path: `/api/media/v1/media/${slot.mediaId}/complete` },
    token,
  );

  // Processing is asynchronous (media-process worker) - wait for readiness.
  const deadline = Date.now() + ctx.convergenceTimeoutMs;
  for (;;) {
    const asset = (await ctx.call(
      'media',
      { method: 'GET', path: `/api/media/v1/media/${slot.mediaId}` },
      token,
    )) as { status: string };
    if (asset.status === 'ready') return slot.mediaId;
    if (asset.status === 'failed') throw new Error(`media ${slot.mediaId} failed processing`);
    if (Date.now() > deadline) {
      throw new Error(`media ${slot.mediaId} never became ready - is the media-process worker up?`);
    }
    await sleep(500);
  }
}

// ---------------------------------------------------------------------------
// Verification (spec data 02: sanity counts; mismatch = failed seed)
// ---------------------------------------------------------------------------

/**
 * Post-seed sanity: per-user post + following counts must match the corpus
 * exactly; feed items are worker-derived and therefore polled until they
 * converge within the timeout, then enforced.
 */
export async function verifySeeded(ctx: SeedContext): Promise<void> {
  const deadline = Date.now() + ctx.convergenceTimeoutMs;
  for (;;) {
    const problems: string[] = [];
    for (const [index, user] of ctx.corpus.users.entries()) {
      problems.push(...(await verifyUser(ctx, index, user, deadline)));
    }
    if (problems.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`seed verification failed:\n  ${problems.join('\n  ')}`);
    }
    await sleep(1_000);
  }
}

/**
 * One user's sanity counts: posts + following must match the corpus
 * exactly. Past the deadline the feed count is enforced too (a feed page
 * caps at 50 - larger feeds verify as "a full page").
 */
async function verifyUser(
  ctx: SeedContext,
  index: number,
  user: CorpusUser,
  deadline: number,
): Promise<string[]> {
  const problems: string[] = [];
  const userId = ctx.ids.get(user.username)!;
  const token = await ctx.grants.token(user.username);

  const posts = await userPostCount(ctx, user, userId);
  const expectedPosts = ctx.corpus.posts.filter((p) => p.authorIndex === index).length;
  if (posts !== expectedPosts) problems.push(`${user.username}: ${posts}/${expectedPosts} posts`);

  const following = await ctx
    .call(
      'social',
      {
        method: 'GET',
        path: `/api/social/v1/profiles/${userId}/following?limit=${POSTS_PAGE_LIMIT}`,
      },
      token,
    )
    .then(countPageItems);
  const expectedFollowing = ctx.corpus.follows.filter((f) => f.followerIndex === index).length;
  if (following !== expectedFollowing) {
    problems.push(`${user.username}: ${following}/${expectedFollowing} following`);
  }

  if (Date.now() > deadline) {
    const feed = await ctx
      .call('feed', { method: 'GET', path: '/api/feed/v1/feed?limit=50' }, token)
      .then(countPageItems);
    const expectedFeed = ctx.corpus.counts.feedEntriesByUser[index]!;
    if (expectedFeed > 50 ? feed < 50 : feed !== expectedFeed) {
      problems.push(`${user.username}: ${feed}/${expectedFeed} feed items`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Keycloak user resolution
// ---------------------------------------------------------------------------

async function resolveDemoUsers(corpus: SeedCorpus): Promise<SeedUser[]> {
  const { initDemoRealm } = await import('./keycloak.js');
  const realmUsers = await initDemoRealm();
  const byName = new Map(realmUsers.map((u) => [u.username, u.userId]));
  return corpus.users.map((u) => {
    const userId = byName.get(u.username);
    if (!userId) throw new Error(`demo user ${u.username} missing from Keycloak`);
    return { username: u.username, userId };
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const slotKey = (post: { authorIndex: number; ordinal: number }): string =>
  `${post.authorIndex}/${post.ordinal}`;

function countPageItems(page: unknown): number {
  return ((page as { items?: unknown[] }).items ?? []).length;
}

function emptyCreated(): SeedReport['created'] {
  return {
    profiles: 0,
    follows: 0,
    mediaUploads: 0,
    posts: 0,
    likes: 0,
    bookmarks: 0,
    reposts: 0,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// --- CLI ---------------------------------------------------------------------
if (process.argv[1]?.endsWith('seed.ts')) {
  loadRepoEnv();
  const corpus = buildCorpus({ userCount: envInt('XITTER_DEMO_USER_COUNT', 10) });
  console.log(
    `seed corpus: ${corpus.counts.users} users, ${corpus.counts.posts} posts ` +
      `(${corpus.counts.replies} replies), ${corpus.counts.follows} follows, ` +
      `${corpus.counts.likes} likes, ${corpus.counts.reposts} reposts, ` +
      `${corpus.counts.bookmarks} bookmarks, ${corpus.counts.imagePosts} images`,
  );
  console.log(`fingerprint: ${corpus.fingerprint}`);
  const result = await runSeed({ corpus });
  console.log(
    result.skipped
      ? 'seed: already present (verified, no-op)'
      : `seed complete: ${result.created.posts} posts, ${result.created.follows} follows`,
  );
}
