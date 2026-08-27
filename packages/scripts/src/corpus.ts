/**
 * Deterministic seed corpus (spec: data 02). Pure faker(42) generation - no
 * I/O, no clocks - so every environment derives the identical corpus from
 * this module. The seeder (seed.ts) turns it into service calls; tests
 * assert the volumes and the cross-run fingerprint.
 *
 * Age offsets (#150): every post carries an `ageMs` derived from a pure
 * slot hash (never faker, never a clock), spread over ~7 days before the
 * seed run - thread roots older than their replies, same-author posts
 * clustered into bursts. The seeder stamps `createdAt = seedTime - ageMs`
 * through the posts internal create, so the corpus stays clock-free while
 * the seeded world stops looking like it was minted in one 16-second window.
 */
import { createHash } from 'node:crypto';
import { faker } from '@faker-js/faker';
import {
  DEMO_IMAGE_PATTERNS,
  DEMO_IMAGE_SIZES,
  mulberry32,
  type DemoImageSpec,
} from './lib/images.js';

/** Recorded in docs/specs/data/02-seeding.md as the determinism contract. */
export const SEED_CONSTANT = 42;

const DEFAULT_USER_COUNT = 10;
const DEFAULT_POSTS_PER_USER = 12;
/** ~30% of the ordered user pairs (each user follows ~3 of the other 9). */
export const DEFAULT_FOLLOW_DENSITY = 0.3;

/**
 * Image posts (#150): one generated PNG per demo user (capped so oversized
 * dev corpora keep the upload volume sane), each a distinct pattern/aspect
 * from the demo palette.
 */
const IMAGE_MAX_USERS = 10;

/**
 * Conversation threads (#150): 3 roots x 4 replies, MIXED - each thread
 * chains its first replies (root -> reply -> reply-to-reply) so the thread
 * view (#152) has real depth to render, with the remainder answering the
 * root directly.
 */
const THREAD_COUNT = 3;
const REPLIES_PER_THREAD = 4;
const REPOST_COUNT = 8;
const BOOKMARK_COUNT = 15;
const HOT_POST_COUNT = 5;
/** Per-user interaction cap: comfortably under the 20-burst interact limit. */
const PER_USER_INTERACTION_CAP = 12;

// --- Age offsets (#150) -------------------------------------------------------

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Newest a seeded post may be: comfortably older than the seed run itself. */
export const MIN_POST_AGE_MS = 10 * MINUTE_MS;
/** Oldest a seeded post may be: the ~7-day pre-reset history (#150). */
export const MAX_POST_AGE_MS = 7 * DAY_MS;

/**
 * Burst bands: a user's posts cluster around one anchor per band (people
 * post in bursts); the bands spread those bursts across the window. Thread
 * roots are pinned to the older two bands so reply chains always fit below
 * them without breaching MIN_POST_AGE_MS.
 */
const AGE_BANDS = [
  { lo: 5 * DAY_MS, hi: 6.5 * DAY_MS }, // late last week
  { lo: 2.5 * DAY_MS, hi: 4.5 * DAY_MS }, // midweek
  { lo: 12 * MINUTE_MS, hi: 30 * HOUR_MS }, // today / yesterday
] as const;

/** How far after its parent a reply lands (hash-derived per reply). */
const REPLY_GAP_MIN_MS = 15 * MINUTE_MS;
const REPLY_GAP_SPAN_MS = 6 * HOUR_MS - REPLY_GAP_MIN_MS;

/** Salts keep the independent per-slot hash streams uncorrelated. */
const SALT_ANCHOR = 0x5eed_0001;
const SALT_BAND = 0x5eed_0002;
const SALT_INTRA_GAP = 0x5eed_0003;
const SALT_REPLY_GAP = 0x5eed_0004;
const SALT_PATTERN = 0x5eed_0005;
const SALT_SIZE = 0x5eed_0006;

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
  /** Descriptive alt text for the attached image (#133); null when none. */
  imageAlt: string | null;
  /** Which demo pattern/size the seeder renders for the image; null when none. */
  imageSpec: DemoImageSpec | null;
  /** Set for replies: the post this one answers. */
  replyTo: PostRef | null;
  /** Age before the seed's stamp time: the seeder writes seedTime - ageMs. */
  ageMs: number;
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

  // 4. Texts, image looks and reply parents (faker consumed in slot order =>
  //    stable); ages come from pure slot hashes, not faker.
  const ages = assignAges(slots, userCount);
  const imageKeys = [...slots.imageKeys].sort();
  const posts: CorpusPost[] = [];
  for (const slot of slots.standalone) {
    const hashtag = faker.number.int({ min: 0, max: 3 }) === 1;
    const text = sentence(faker.number.int({ min: 4, max: 16 }));
    const isImage = slots.imageKeys.has(keyOf(slot));
    const spec = isImage ? imageSpecFor(slot) : null;
    posts.push({
      ...slot,
      text: hashtag ? `${text} #${faker.lorem.word()}` : text,
      mediaCount: isImage ? 1 : 0,
      imageAlt: spec
        ? `Demo pattern ${imageKeys.indexOf(keyOf(slot)) + 1} of ${imageKeys.length}: ${describeImage(spec)}`
        : null,
      imageSpec: spec,
      replyTo: null,
      ageMs: ages.get(keyOf(slot))!,
    });
  }
  for (const thread of slots.threads) {
    for (const replySlot of thread.replies) {
      posts.push({
        ...replySlot,
        text: sentence(faker.number.int({ min: 3, max: 10 })),
        mediaCount: 0,
        imageAlt: null,
        imageSpec: null,
        replyTo: replySlot.parent,
        ageMs: ages.get(keyOf(replySlot))!,
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
      p.imageAlt,
      p.imageSpec,
      p.replyTo ? [p.replyTo.authorIndex, p.replyTo.ordinal] : null,
      p.ageMs,
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

/**
 * Honest description of the generated demo pattern (lib/images.ts) for one
 * image slot (#133); null for slots without an image. #150: the description
 * names the concrete pattern and size the seeder will render.
 */
function describeImage(spec: DemoImageSpec): string {
  const pattern = DEMO_IMAGE_PATTERNS.find((p) => p.id === spec.pattern)!;
  return `${pattern.description} (${spec.width}x${spec.height} pixels)`;
}

// ---------------------------------------------------------------------------
// Slot-hash randomness (ages + image looks)
// ---------------------------------------------------------------------------

/**
 * Pure per-slot PRNG stream. Deliberately NOT faker: ages and image specs
 * must not shift faker's sequence (texts/thread shapes stay stable under
 * unrelated changes), and a slot-keyed hash keeps each stream independent.
 */
function slotRandom(slot: PostRef, salt: number): () => number {
  let h = (SEED_CONSTANT ^ salt) >>> 0;
  h = Math.imul(h ^ (slot.authorIndex + 0x9e3779b9), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h ^ (slot.ordinal + 0xc2b2ae35), 0x27d4eb2f);
  h ^= h >>> 16;
  return mulberry32(h >>> 0);
}

/** Which demo pattern + size an image slot renders (varied, #150). */
function imageSpecFor(slot: PostRef): DemoImageSpec {
  const pattern = DEMO_IMAGE_PATTERNS[
    Math.floor(slotRandom(slot, SALT_PATTERN)() * DEMO_IMAGE_PATTERNS.length)
  ]!;
  const [width, height] = DEMO_IMAGE_SIZES[
    Math.floor(slotRandom(slot, SALT_SIZE)() * DEMO_IMAGE_SIZES.length)
  ]!;
  return { pattern: pattern.id, width, height };
}

/**
 * Age assignment (#150): standalone posts cluster into per-author burst
 * anchors (one per band); each successive post in a band lands minutes-to-
 * an-hour after the previous one. Thread replies land after their parent by
 * a hash-derived gap, clamped so no post is newer than MIN_POST_AGE_MS -
 * so every thread is chronologically coherent by construction.
 */
function assignAges(plan: SlotPlan, userCount: number): Map<string, number> {
  const ages = new Map<string, number>();

  // One anchor per (author, band): where that author's burst sits.
  const anchors: number[][] = [];
  for (let u = 0; u < userCount; u++) {
    anchors[u] = AGE_BANDS.map((band, b) => {
      const roll = slotRandom({ authorIndex: u, ordinal: -1 - b }, SALT_ANCHOR)();
      return Math.floor(band.lo + roll * (band.hi - band.lo));
    });
  }

  const perBand = new Map<string, number>(); // `author:band` -> posts already placed
  const bump = (authorIndex: number, band: number) => {
    const key = `${authorIndex}:${band}`;
    const next = (perBand.get(key) ?? 0) + 1;
    perBand.set(key, next);
    return next - 1; // this post's position within its author's burst
  };

  for (const slot of plan.standalone) {
    const isRoot = plan.rootKeys.has(keyOf(slot));
    // Roots stay in the older two bands: reply chains must fit below them.
    const band = isRoot
      ? Math.floor(slotRandom(slot, SALT_BAND)() * (AGE_BANDS.length - 1))
      : Math.floor(slotRandom(slot, SALT_BAND)() * AGE_BANDS.length);
    const position = bump(slot.authorIndex, band);
    // Successive posts in one burst: 4-40 minutes apart.
    const gap = 4 * MINUTE_MS + Math.floor(slotRandom(slot, SALT_INTRA_GAP)() * 36 * MINUTE_MS);
    ages.set(keyOf(slot), Math.min(MAX_POST_AGE_MS, anchors[slot.authorIndex]![band]! + position * gap));
  }

  for (const thread of plan.threads) {
    for (const reply of thread.replies) {
      const parentAge = ages.get(keyOf(reply.parent))!;
      const roll = slotRandom(reply, SALT_REPLY_GAP)();
      const gap = Math.min(
        REPLY_GAP_MIN_MS + Math.floor(roll * REPLY_GAP_SPAN_MS),
        Math.max(0, parentAge - MIN_POST_AGE_MS),
      );
      ages.set(keyOf(reply), parentAge - gap);
    }
  }

  return ages;
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

interface ReplySlot extends PostSlot {
  /** The post this reply answers (root or an earlier reply - #150 nesting). */
  parent: PostRef;
}

interface ThreadPlan {
  root: PostSlot;
  replies: ReplySlot[];
}

interface SlotPlan {
  standalone: PostSlot[];
  threads: ThreadPlan[];
  imageKeys: Set<string>;
  rootKeys: Set<string>;
}
const keyOf = (ref: PostRef): string => `${ref.authorIndex}/${ref.ordinal}`;

/** Slot bookkeeping shared by the planning phases below. */
interface SlotAllocator {
  /** Consume a slot (throws when already taken). */
  take(authorIndex: number, ordinal: number): PostSlot;
  /** First unconsumed ordinal for an author. */
  firstFree(authorIndex: number): number;
  isTaken(authorIndex: number, ordinal: number): boolean;
}

/** taken[author][ordinal] marks a slot consumed by images/roots/replies. */
function createSlotAllocator(userCount: number, postsPerUser: number): SlotAllocator {
  const taken: boolean[][] = Array.from({ length: userCount }, () =>
    Array.from({ length: postsPerUser }, () => false),
  );
  return {
    take(authorIndex, ordinal) {
      if (taken[authorIndex]![ordinal]) throw new Error(`slot ${authorIndex}/${ordinal} taken`);
      taken[authorIndex]![ordinal] = true;
      return { authorIndex, ordinal };
    },
    firstFree(authorIndex) {
      const ordinal = taken[authorIndex]!.indexOf(false);
      if (ordinal === -1) throw new Error(`no free slot for user ${authorIndex}`);
      return ordinal;
    },
    isTaken: (authorIndex, ordinal) => taken[authorIndex]![ordinal] === true,
  };
}

/**
 * Image posts (#150): every demo user (up to the cap) attaches one generated
 * PNG at a derived ordinal - no longer just the first post of every other
 * user.
 */
function planImageSlots(alloc: SlotAllocator, userCount: number, postsPerUser: number): Set<string> {
  const imageKeys = new Set<string>();
  for (let u = 0; u < Math.min(userCount, IMAGE_MAX_USERS); u++) {
    const roll = slotRandom({ authorIndex: u, ordinal: -1 }, SALT_SIZE);
    const ordinal = Math.min(postsPerUser - 1, 1 + Math.floor(roll() * (postsPerUser - 1)));
    if (alloc.isTaken(u, ordinal)) continue; // degenerate tiny corpora: skip, not crash
    imageKeys.add(keyOf(alloc.take(u, ordinal)));
  }
  return imageKeys;
}

/**
 * Thread roots: mid-range ordinals of non-image users, faker-chosen. The
 * roots themselves stay ordinary standalone posts (they carry text too);
 * only their ordinals are reserved here so replies can reference them.
 */
function planThreadRoots(
  alloc: SlotAllocator,
  userCount: number,
  postsPerUser: number,
): { roots: PostSlot[]; threads: ThreadPlan[] } {
  const rootCandidates: PostSlot[] = [];
  for (let u = 1; u < userCount; u++) {
    for (let o = Math.floor(postsPerUser / 2); o < postsPerUser - 1; o++) {
      if (!alloc.isTaken(u, o)) rootCandidates.push({ authorIndex: u, ordinal: o });
    }
  }
  const threadCount = Math.min(THREAD_COUNT, userCount - 1, rootCandidates.length);
  const roots = faker.helpers
    .arrayElements(rootCandidates, threadCount)
    .sort((a, b) => a.authorIndex - b.authorIndex || a.ordinal - b.ordinal);
  const threads = roots.map((root) => {
    alloc.take(root.authorIndex, root.ordinal);
    return { root, replies: [] as ReplySlot[] };
  });
  return { roots, threads };
}

/**
 * Reply chains (#150): each thread's first `2 + t` replies form a NESTED
 * chain (root -> reply -> reply-to-reply...), the rest answer the root
 * directly - the default shape yields depths 3/4/5 across the three
 * threads, so both the flat replies page and the thread view have content.
 */
function attachReplyChains(
  alloc: SlotAllocator,
  threads: ThreadPlan[],
  userCount: number,
  repliesPerThread: number,
): void {
  threads.forEach((thread, t) => {
    const chainLength = Math.min(repliesPerThread, 2 + t);
    let chainTip: PostRef = thread.root;
    for (let k = 1; k <= repliesPerThread; k++) {
      const authorIndex = (thread.root.authorIndex + k) % userCount;
      const slot = alloc.take(authorIndex, alloc.firstFree(authorIndex));
      const parent = k <= chainLength ? chainTip : thread.root;
      if (k <= chainLength) chainTip = slot;
      thread.replies.push({ ...slot, parent });
    }
  });
}

/** Standalone = every unclaimed slot PLUS the reserved roots and images. */
function collectStandalone(
  alloc: SlotAllocator,
  userCount: number,
  postsPerUser: number,
  specialKeys: Set<string>,
): PostSlot[] {
  const standalone: PostSlot[] = [];
  for (let u = 0; u < userCount; u++) {
    for (let o = 0; o < postsPerUser; o++) {
      if (!alloc.isTaken(u, o) || specialKeys.has(`${u}/${o}`)) {
        standalone.push({ authorIndex: u, ordinal: o });
      }
    }
  }
  return standalone;
}

function planSlots(userCount: number, postsPerUser: number): SlotPlan {
  const alloc = createSlotAllocator(userCount, postsPerUser);
  const imageKeys = planImageSlots(alloc, userCount, postsPerUser);
  const { roots, threads } = planThreadRoots(alloc, userCount, postsPerUser);
  attachReplyChains(
    alloc,
    threads,
    userCount,
    Math.min(REPLIES_PER_THREAD, Math.max(1, postsPerUser - 2)),
  );
  const specialKeys = new Set<string>([...roots.map(keyOf), ...imageKeys]);
  return {
    standalone: collectStandalone(alloc, userCount, postsPerUser, specialKeys),
    threads,
    imageKeys,
    rootKeys: new Set(roots.map(keyOf)),
  };
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
  const scatterLikes = (targets: CorpusPost[], min: number, max: number) => {
    for (const post of targets) {
      const likers = faker.number.int({ min, max });
      const seen = new Set<number>();
      for (let k = 0; k < likers; k++) {
        const actor = pickActor(post.authorIndex);
        if (seen.has(actor)) continue;
        seen.add(actor);
        claim(actor, post, 'like');
      }
    }
  };
  scatterLikes(hot, 5, 8);
  scatterLikes(
    posts.filter((p) => !hotSet.has(keyOf(p))),
    0,
    2,
  );

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
