/**
 * Deterministic seed corpus (spec: data 02). Pure faker(42) generation - no
 * I/O, no clocks - so every environment derives the identical corpus from
 * this module. The seeder (seed.ts) turns it into service calls; tests
 * assert the volumes and the cross-run fingerprint.
 */
import { createHash } from 'node:crypto';
import { faker } from '@faker-js/faker';

/** Recorded in docs/specs/data/02-seeding.md as the determinism contract. */
export const SEED_CONSTANT = 42;

const DEFAULT_USER_COUNT = 10;
const DEFAULT_POSTS_PER_USER = 12;
/** ~30% of the ordered user pairs (each user follows ~3 of the other 9). */
export const DEFAULT_FOLLOW_DENSITY = 0.3;

/** Image posts: users 0, 2, 4, 6 each attach one generated PNG (spec: "a few"). */
const IMAGE_USER_STRIDE = 2;
const IMAGE_USER_COUNT = 4;
/** Conversation threads: 3 roots x 4 chained replies (spec: concentrated). */
const THREAD_COUNT = 3;
const REPLIES_PER_THREAD = 4;
const REPOST_COUNT = 8;
const BOOKMARK_COUNT = 15;
const HOT_POST_COUNT = 5;
/** Per-user interaction cap: comfortably under the 20-burst interact limit. */
const PER_USER_INTERACTION_CAP = 12;

export type InteractionKind = 'like' | 'bookmark' | 'repost';

export interface CorpusUser {
  username: string;
  displayName: string;
  bio: string | null;
}

export interface CorpusFollow {
  followerIndex: number;
  followeeIndex: number;
}

/** Reference to a corpus post, stable across runs (natural key `demoN/post-OOO`). */
export interface PostRef {
  authorIndex: number;
  ordinal: number;
}

export interface CorpusPost extends PostRef {
  text: string;
  /** 1 = attach a generated demo image (media pipeline). */
  mediaCount: number;
  /** Set for replies: the post this one answers. */
  replyTo: PostRef | null;
}

export interface CorpusInteraction {
  userIndex: number;
  post: PostRef;
  kind: InteractionKind;
}

export interface CorpusCounts {
  users: number;
  follows: number;
  posts: number;
  replies: number;
  imagePosts: number;
  likes: number;
  reposts: number;
  bookmarks: number;
  /** Expected feed-entry count per user (own + followed authors + reposts). */
  feedEntriesByUser: number[];
}

export interface SeedCorpus {
  users: CorpusUser[];
  follows: CorpusFollow[];
  /** Creation order: standalone (user, ordinal) asc, then thread replies. */
  posts: CorpusPost[];
  interactions: CorpusInteraction[];
  counts: CorpusCounts;
  fingerprint: string;
}

export interface CorpusOptions {
  userCount?: number;
  postsPerUser?: number;
  followDensity?: number;
  seed?: number;
}

export function buildCorpus(options: CorpusOptions = {}): SeedCorpus {
  const userCount = options.userCount ?? DEFAULT_USER_COUNT;
  const postsPerUser = options.postsPerUser ?? DEFAULT_POSTS_PER_USER;
  const followDensity = options.followDensity ?? DEFAULT_FOLLOW_DENSITY;
  faker.seed(options.seed ?? SEED_CONSTANT);

  // 1. Users + profiles (fixed usernames; Keycloak owns the ids).
  const users: CorpusUser[] = [];
  for (let i = 0; i < userCount; i++) {
    const displayName = `${faker.person.firstName()} ${faker.person.lastName()}`;
    const bio =
      faker.number.int({ min: 0, max: 9 }) < 3
        ? null
        : sentence(faker.number.int({ min: 6, max: 16 }));
    users.push({ username: `demo${i + 1}`, displayName, bio });
  }

  // 2. Follow graph: a ring guarantees connectedness with no self-follows,
  //    then deterministic random pairs fill up to the density target.
  const follows = buildFollowGraph(userCount, followDensity);

  // 3. Post slots: image posts and thread roots first, then reply chains
  //    (consuming their authors' ordinals), the rest standalone.
  const slots = planSlots(userCount, postsPerUser);

  // 4. Texts + reply parents (faker consumed in slot order => stable).
  const posts: CorpusPost[] = [];
  for (const slot of slots.standalone) {
    const hashtag = faker.number.int({ min: 0, max: 3 }) === 1;
    const text = sentence(faker.number.int({ min: 4, max: 16 }));
    posts.push({
      ...slot,
      text: hashtag ? `${text} #${faker.lorem.word()}` : text,
      mediaCount: slots.imageKeys.has(keyOf(slot)) ? 1 : 0,
      replyTo: null,
    });
  }
  for (const thread of slots.threads) {
    for (const replySlot of thread.replies) {
      posts.push({
        ...replySlot,
        text: sentence(faker.number.int({ min: 3, max: 10 })),
        mediaCount: 0,
        replyTo: thread.root,
      });
    }
  }

  // 5. Interactions: hot/cold likes, a few reposts, scattered bookmarks -
  //    capped per user so seeding never trips the mutation rate limit.
  const interactions = buildInteractions(userCount, posts);

  const corpus: SeedCorpus = {
    users,
    follows,
    posts,
    interactions,
    counts: {
      users: users.length,
      follows: follows.length,
      posts: posts.length,
      replies: posts.filter((p) => p.replyTo !== null).length,
      imagePosts: posts.filter((p) => p.mediaCount > 0).length,
      likes: interactions.filter((i) => i.kind === 'like').length,
      reposts: interactions.filter((i) => i.kind === 'repost').length,
      bookmarks: interactions.filter((i) => i.kind === 'bookmark').length,
      feedEntriesByUser: expectedFeedEntries(userCount, follows, posts, interactions),
    },
    fingerprint: '',
  };
  corpus.fingerprint = corpusFingerprint(corpus);
  return corpus;
}

/**
 * Stable digest of the corpus content: identical across runs and
 * environments by construction, so a mismatch flags non-deterministic
 * generation (or a spec change - the fingerprint is content-addressed).
 */
export function corpusFingerprint(corpus: Omit<SeedCorpus, 'fingerprint'>): string {
  const canonical = {
    users: corpus.users.map((u) => [u.username, u.displayName, u.bio]),
    // Sorted: iteration order must not change corpus identity.
    follows: corpus.follows
      .map((f) => [f.followerIndex, f.followeeIndex])
      .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!),
    posts: corpus.posts.map((p) => [
      p.authorIndex,
      p.ordinal,
      p.text,
      p.mediaCount,
      p.replyTo ? [p.replyTo.authorIndex, p.replyTo.ordinal] : null,
    ]),
    interactions: corpus.interactions
      .map((i) => [i.kind, i.userIndex, i.post.authorIndex, i.post.ordinal])
      .sort(
        (a, b) =>
          String(a[0]).localeCompare(String(b[0])) ||
          Number(a[1]) - Number(b[1]) ||
          Number(a[2]) - Number(b[2]) ||
          Number(a[3]) - Number(b[3]),
      ),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// ---------------------------------------------------------------------------
// Follow graph
// ---------------------------------------------------------------------------

function buildFollowGraph(userCount: number, density: number): CorpusFollow[] {
  const edges = new Set<string>();
  for (let i = 0; i < userCount; i++) {
    edges.add(`${i}>${(i + 1) % userCount}`);
  }

  const target = Math.round(density * userCount * (userCount - 1));
  const candidates: Array<[number, number]> = [];
  for (let i = 0; i < userCount; i++) {
    for (let j = 0; j < userCount; j++) {
      if (i !== j && !edges.has(`${i}>${j}`)) candidates.push([i, j]);
    }
  }
  for (const [i, j] of faker.helpers.shuffle(candidates)) {
    if (edges.size >= target) break;
    edges.add(`${i}>${j}`);
  }

  return [...edges]
    .map((e) => e.split('>').map(Number) as [number, number])
    .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0))
    .map(([followerIndex, followeeIndex]) => ({ followerIndex, followeeIndex }));
}

// ---------------------------------------------------------------------------
// Post slot planning
// ---------------------------------------------------------------------------

interface PostSlot extends PostRef {
  authorIndex: number;
  ordinal: number;
}

interface ThreadPlan {
  root: PostSlot;
  replies: PostSlot[];
}

interface SlotPlan {
  standalone: PostSlot[];
  threads: ThreadPlan[];
  imageKeys: Set<string>;
}
const keyOf = (ref: PostRef): string => `${ref.authorIndex}/${ref.ordinal}`;

function planSlots(userCount: number, postsPerUser: number): SlotPlan {
  // taken[author][ordinal] marks a slot consumed by images/roots/replies.
  const taken: boolean[][] = Array.from({ length: userCount }, () =>
    Array.from({ length: postsPerUser }, () => false),
  );
  const take = (authorIndex: number, ordinal: number): PostSlot => {
    if (taken[authorIndex]![ordinal]) throw new Error(`slot ${authorIndex}/${ordinal} taken`);
    taken[authorIndex]![ordinal] = true;
    return { authorIndex, ordinal };
  };
  const firstFree = (authorIndex: number): number => {
    const ordinal = taken[authorIndex]!.indexOf(false);
    if (ordinal === -1) throw new Error(`no free slot for user ${authorIndex}`);
    return ordinal;
  };

  // Image posts: first ordinal of the first stride users.
  const imageKeys = new Set<string>();
  for (let i = 0; i < IMAGE_USER_COUNT && i * IMAGE_USER_STRIDE < userCount; i++) {
    const authorIndex = i * IMAGE_USER_STRIDE;
    imageKeys.add(keyOf(take(authorIndex, 0)));
  }

  // Thread roots: mid-range ordinals of non-image users, faker-chosen. The
  // roots themselves stay ordinary standalone posts (they carry text too);
  // only their ordinals are reserved here so replies can reference them.
  const rootCandidates: PostSlot[] = [];
  for (let u = 1; u < userCount; u++) {
    for (let o = Math.floor(postsPerUser / 2); o < postsPerUser - 1; o++) {
      if (!taken[u]![o]) rootCandidates.push({ authorIndex: u, ordinal: o });
    }
  }
  const threadCount = Math.min(THREAD_COUNT, userCount - 1, rootCandidates.length);
  const repliesPerThread = Math.min(REPLIES_PER_THREAD, Math.max(1, postsPerUser - 2));
  const rootSlots = faker.helpers
    .arrayElements(rootCandidates, threadCount)
    .sort((a, b) => a.authorIndex - b.authorIndex || a.ordinal - b.ordinal);
  const rootKeys = new Set(rootSlots.map(keyOf));
  const threads: ThreadPlan[] = rootSlots.map((root) => {
    take(root.authorIndex, root.ordinal);
    return { root, replies: [] as PostSlot[] };
  });

  // Reply chains: every reply answers the thread ROOT directly (a
  // concentrated conversation - the root's replies page carries them all).
  for (const thread of threads) {
    for (let k = 1; k <= repliesPerThread; k++) {
      const authorIndex = (thread.root.authorIndex + k) % userCount;
      thread.replies.push(take(authorIndex, firstFree(authorIndex)));
    }
  }

  // Standalone = every unclaimed slot PLUS the reserved roots and images.
  const specialKeys = new Set<string>([...rootKeys, ...imageKeys]);
  const standalone: PostSlot[] = [];
  for (let u = 0; u < userCount; u++) {
    for (let o = 0; o < postsPerUser; o++) {
      if (!taken[u]![o] || specialKeys.has(`${u}/${o}`)) {
        standalone.push({ authorIndex: u, ordinal: o });
      }
    }
  }
  return { standalone, threads, imageKeys };
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

function buildInteractions(userCount: number, posts: CorpusPost[]): CorpusInteraction[] {
  const perUser = new Array<number>(userCount).fill(0);
  const used = new Set<string>();
  const out: CorpusInteraction[] = [];

  const claim = (userIndex: number, post: PostRef, kind: InteractionKind): boolean => {
    if (perUser[userIndex]! >= PER_USER_INTERACTION_CAP) return false;
    const key = `${kind}:${userIndex}:${keyOf(post)}`;
    if (used.has(key)) return false;
    used.add(key);
    perUser[userIndex]! += 1;
    out.push({ userIndex, post, kind });
    return true;
  };

  const pickActor = (authorIndex: number): number => {
    // Distinct from the author; deterministic rotation + faker nudge.
    const offset = faker.number.int({ min: 1, max: userCount - 1 });
    return (authorIndex + offset) % userCount;
  };

  const standalone = posts.filter((p) => p.replyTo === null);

  // Reposts (must surface as repost feed entries): standalone posts only.
  const repostTargets = faker.helpers.arrayElements(standalone, REPOST_COUNT).sort(byAuthorOrdinal);
  for (const post of repostTargets) {
    claim(pickActor(post.authorIndex), post, 'repost');
  }

  // Bookmarks before likes: "a few, scattered" must not be crowded out by
  // the like distribution when per-user budgets run low.
  const bookmarkTargets = faker.helpers.arrayElements(posts, BOOKMARK_COUNT).sort(byAuthorOrdinal);
  for (const post of bookmarkTargets) {
    claim(pickActor(post.authorIndex), post, 'bookmark');
  }

  // Hot posts carry a burst of likes; the rest are cold (0-2).
  const hot = faker.helpers.arrayElements(posts, HOT_POST_COUNT).sort(byAuthorOrdinal);
  const hotSet = new Set(hot.map(keyOf));
  for (const post of hot) {
    const likers = faker.number.int({ min: 5, max: 8 });
    const seen = new Set<number>();
    for (let k = 0; k < likers; k++) {
      const actor = pickActor(post.authorIndex);
      if (seen.has(actor)) continue;
      seen.add(actor);
      claim(actor, post, 'like');
    }
  }
  for (const post of posts) {
    if (hotSet.has(keyOf(post))) continue;
    const likers = faker.number.int({ min: 0, max: 2 });
    const seen = new Set<number>();
    for (let k = 0; k < likers; k++) {
      const actor = pickActor(post.authorIndex);
      if (seen.has(actor)) continue;
      seen.add(actor);
      claim(actor, post, 'like');
    }
  }

  out.sort(
    (a, b) =>
      kindOrder(a.kind) - kindOrder(b.kind) ||
      a.userIndex - b.userIndex ||
      a.post.authorIndex - b.post.authorIndex ||
      a.post.ordinal - b.post.ordinal,
  );
  return out;
}

const kindOrder = (kind: InteractionKind): number => ({ like: 0, bookmark: 1, repost: 2 })[kind];

const byAuthorOrdinal = (a: PostRef, b: PostRef): number =>
  a.authorIndex - b.authorIndex || a.ordinal - b.ordinal;

// ---------------------------------------------------------------------------
// Derived expectations
// ---------------------------------------------------------------------------

/**
 * Feed entries each user should hold once fanout consumes the seed events:
 * own posts + posts of followed authors (follows precede posts in seed
 * order, so backfill adds nothing) + repost entries landing in their feed
 * (the reposter's audience, per entriesForRepost).
 */
function expectedFeedEntries(
  userCount: number,
  follows: CorpusFollow[],
  posts: CorpusPost[],
  interactions: CorpusInteraction[],
): number[] {
  const followedBy: Set<number>[] = Array.from({ length: userCount }, () => new Set<number>());
  for (const { followerIndex, followeeIndex } of follows) {
    followedBy[followerIndex]!.add(followeeIndex);
  }
  const postsByAuthor = new Array<number>(userCount).fill(0);
  for (const post of posts) postsByAuthor[post.authorIndex]! += 1;
  const repostsByUser = new Array<number>(userCount).fill(0);
  for (const { userIndex, kind } of interactions) {
    if (kind === 'repost') repostsByUser[userIndex]! += 1;
  }

  return Array.from({ length: userCount }, (_, u) => {
    let entries = postsByAuthor[u]!;
    for (const author of followedBy[u]!) entries += postsByAuthor[author]!;
    for (let r = 0; r < userCount; r++) {
      if (r === u || followedBy[u]!.has(r)) entries += repostsByUser[r]!;
    }
    return entries;
  });
}

function sentence(words: number): string {
  const parts = Array.from({ length: words }, () => faker.lorem.word());
  const joined = parts.join(' ');
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}
