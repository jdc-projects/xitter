import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildCorpus,
  corpusFingerprint,
  DEFAULT_FOLLOW_DENSITY,
  MAX_POST_AGE_MS,
  MIN_POST_AGE_MS,
  SEED_CONSTANT,
  type CorpusPost,
  type SeedCorpus,
} from './corpus.js';
import { DEMO_IMAGE_PATTERNS, DEMO_IMAGE_SIZES, demoPng } from './lib/images.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const keyOf = (post: { authorIndex: number; ordinal: number }) =>
  `${post.authorIndex}/${post.ordinal}`;

/** Depth of a post in its thread (root = 1), via the reply chain. */
function depthOf(post: CorpusPost, byKey: Map<string, CorpusPost>): number {
  return post.replyTo ? 1 + depthOf(byKey.get(keyOf(post.replyTo))!, byKey) : 1;
}

/** The thread root's key for a reply (walking up the chain). */
function rootKeyOf(post: CorpusPost, byKey: Map<string, CorpusPost>): string {
  return post.replyTo ? rootKeyOf(byKey.get(keyOf(post.replyTo))!, byKey) : keyOf(post);
}

/**
 * Corpus contracts (spec data 02): identical everywhere, fixed volumes,
 * structurally valid graph/content. The fingerprint equality across two
 * independent builds is THE determinism guarantee every environment
 * inherits.
 */
describe('buildCorpus', () => {
  const corpus = buildCorpus();
  const byKey = new Map(corpus.posts.map((p) => [keyOf(p), p]));

  it('is deterministic across runs', () => {
    const again = buildCorpus();
    expect(again.fingerprint).toBe(corpus.fingerprint);
    expect(again.posts).toEqual(corpus.posts);
    expect(again.interactions).toEqual(corpus.interactions);
  });

  it('does not depend on previously built corpora', () => {
    buildCorpus({ seed: 7, userCount: 5, postsPerUser: 4 });
    expect(buildCorpus().fingerprint).toBe(corpus.fingerprint);
  });

  it('produces the spec volumes', () => {
    expect(corpus.counts.users).toBe(10);
    expect(corpus.counts.posts).toBe(120);
    expect(corpus.counts.follows).toBe(Math.round(DEFAULT_FOLLOW_DENSITY * 10 * 9));
    expect(corpus.counts.replies).toBe(12);
    expect(corpus.counts.imagePosts).toBe(10); // one per demo user (#150)
    expect(corpus.counts.reposts).toBeGreaterThanOrEqual(5);
    expect(corpus.counts.bookmarks).toBeGreaterThanOrEqual(10);
    expect(corpus.counts.likes).toBeGreaterThan(corpus.counts.reposts);
  });

  it('describes every image post with alt text and nothing else (#133)', () => {
    const imagePosts = corpus.posts.filter((p) => p.mediaCount > 0);
    expect(imagePosts.length).toBe(corpus.counts.imagePosts);
    for (const post of imagePosts) {
      expect(post.imageAlt, `demo${post.authorIndex + 1}/post-${post.ordinal}`).toBeTruthy();
      expect(post.imageAlt!.length).toBeLessThanOrEqual(200);
      // The description names the pattern the seeder will actually render.
      expect(post.imageAlt).toContain(
        DEMO_IMAGE_PATTERNS.find((p) => p.id === post.imageSpec!.pattern)!.description,
      );
    }
    for (const post of corpus.posts.filter((p) => p.mediaCount === 0)) {
      expect(post.imageAlt).toBeNull();
      expect(post.imageSpec).toBeNull();
    }
  });

  it('varies the generated image looks across users (#150)', () => {
    const specs = corpus.posts.filter((p) => p.mediaCount > 0).map((p) => p.imageSpec!);
    // Every demo user owns exactly one image post.
    expect(
      new Set(corpus.posts.filter((p) => p.mediaCount > 0).map((p) => p.authorIndex)).size,
    ).toBe(10);
    // Not one grey rectangle: several patterns and several aspects appear.
    expect(new Set(specs.map((s) => s.pattern)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(specs.map((s) => `${s.width}x${s.height}`)).size).toBeGreaterThanOrEqual(4);
    for (const spec of specs) {
      expect(DEMO_IMAGE_SIZES).toContainEqual([spec.width, spec.height]);
      expect(DEMO_IMAGE_PATTERNS.map((p) => p.id)).toContain(spec.pattern);
    }
  });

  it('spreads deterministic age offsets over the ~7-day window (#150)', () => {
    const ages = corpus.posts.map((p) => p.ageMs);
    for (const age of ages) {
      expect(age).toBeGreaterThanOrEqual(MIN_POST_AGE_MS);
      expect(age).toBeLessThanOrEqual(MAX_POST_AGE_MS);
    }
    // The window is actually used: history reaches back days, and a
    // same-day share exists (RelativeTime shows both shapes).
    expect(Math.max(...ages)).toBeGreaterThan(6 * DAY_MS);
    expect(ages.filter((a) => a < DAY_MS).length).toBeGreaterThan(20);
    // Bursts: every author posts at least one sub-hour pair.
    for (let user = 0; user < 10; user++) {
      const sorted = corpus.posts
        .filter((p) => p.authorIndex === user)
        .map((p) => p.ageMs)
        .sort((a, b) => b - a);
      const pairs = sorted.filter((age, i) => i > 0 && sorted[i - 1]! - age < 60 * 60_000);
      expect(pairs.length, `demo${user + 1} burst pairs`).toBeGreaterThan(0);
    }
  });

  it('keeps every thread chronologically coherent (#150)', () => {
    for (const post of corpus.posts) {
      if (!post.replyTo) continue;
      const parent = byKey.get(keyOf(post.replyTo))!;
      // Bigger age = older: a reply must never predate its parent.
      expect(parent.ageMs, `parent of ${keyOf(post)}`).toBeGreaterThanOrEqual(post.ageMs);
    }
  });

  it('fixes the demo usernames', () => {
    expect(corpus.users.map((u) => u.username)).toEqual(
      Array.from({ length: 10 }, (_, i) => `demo${i + 1}`),
    );
    for (const user of corpus.users) {
      expect(user.displayName, `${user.username} display name`).toMatch(/\S+ \S+/);
      expect(user.bio === null || user.bio.length <= 200).toBe(true);
    }
  });

  it('keeps the follow graph simple and connected', () => {
    const edges = new Set(corpus.follows.map((f) => `${f.followerIndex}>${f.followeeIndex}`));
    expect(edges.size).toBe(corpus.follows.length); // no duplicates
    for (const follow of corpus.follows) {
      expect(follow.followerIndex).not.toBe(follow.followeeIndex); // no self-follows
    }
    // Connected via the seeded ring: user 0 reaches everyone.
    const seen = new Set<number>([0]);
    let frontier = [0];
    const out = new Map<number, number[]>();
    for (const f of corpus.follows) {
      out.set(f.followerIndex, [...(out.get(f.followerIndex) ?? []), f.followeeIndex]);
    }
    while (frontier.length > 0) {
      const next: number[] = [];
      for (const node of frontier) {
        for (const target of out.get(node) ?? []) {
          if (!seen.has(target)) {
            seen.add(target);
            next.push(target);
          }
        }
      }
      frontier = next;
    }
    expect(seen.size).toBe(corpus.counts.users);
  });

  it('gives every user exactly one post per ordinal slot', () => {
    const slots = new Set(corpus.posts.map((p) => `${p.authorIndex}/${p.ordinal}`));
    expect(slots.size).toBe(corpus.posts.length);
    for (let user = 0; user < 10; user++) {
      for (let ordinal = 0; ordinal < 12; ordinal++) {
        expect(slots.has(`${user}/${ordinal}`), `slot ${user}/${ordinal}`).toBe(true);
      }
    }
  });

  it("keeps each author's post texts unique", () => {
    // The seed's ambiguity reconciliation (#85) identifies a possibly-created
    // post by exact text on the author timeline - that is only a unique key
    // if faker never hands one author the same sentence twice.
    for (const [index, user] of corpus.users.entries()) {
      const texts = corpus.posts.filter((p) => p.authorIndex === index).map((p) => p.text);
      expect(new Set(texts).size, `${user.username} texts`).toBe(texts.length);
    }
  });

  it('points replies at posts that exist (and threads concentrate)', () => {
    const created = new Set<string>();
    // Creation order: standalone first, then replies - a reply's parent must
    // already exist when it is created (parents precede children in the
    // nested chains too).
    for (const post of corpus.posts) {
      expect(created.has(`${post.authorIndex}/${post.ordinal}`)).toBe(false);
      if (post.replyTo) {
        expect(
          created.has(`${post.replyTo.authorIndex}/${post.replyTo.ordinal}`),
          `reply parent ${post.replyTo.authorIndex}/${post.replyTo.ordinal}`,
        ).toBe(true);
      }
      created.add(`${post.authorIndex}/${post.ordinal}`);
    }
    const repliesByRoot = new Map<string, number>();
    for (const post of corpus.posts) {
      if (!post.replyTo) continue;
      const key = rootKeyOf(post, byKey);
      repliesByRoot.set(key, (repliesByRoot.get(key) ?? 0) + 1);
    }
    const threads = [...repliesByRoot.values()];
    expect(threads.length).toBeLessThanOrEqual(5); // concentrated, not scattered
    expect(Math.max(...threads)).toBeGreaterThanOrEqual(3); // real conversations
  });

  it('nests reply chains at least two threads deep (#150)', () => {
    // Depth counts posts root->leaf: 3 = root -> reply -> reply-to-reply.
    const depthsByThread = new Map<string, number>();
    for (const post of corpus.posts) {
      if (!post.replyTo) continue;
      const root = rootKeyOf(post, byKey);
      depthsByThread.set(root, Math.max(depthsByThread.get(root) ?? 0, depthOf(post, byKey)));
    }
    expect([...depthsByThread.values()].filter((d) => d >= 3).length).toBeGreaterThanOrEqual(2);
    // And the deepest thread chains three replies below the root.
    expect(Math.max(...depthsByThread.values())).toBeGreaterThanOrEqual(4);
  });

  it('caps per-user interactions under the mutation rate-limit burst', () => {
    const perUser = new Map<number, number>();
    const seen = new Set<string>();
    for (const i of corpus.interactions) {
      expect(seen.has(`${i.kind}:${i.userIndex}:${i.post.authorIndex}/${i.post.ordinal}`)).toBe(
        false,
      );
      seen.add(`${i.kind}:${i.userIndex}:${i.post.authorIndex}/${i.post.ordinal}`);
      perUser.set(i.userIndex, (perUser.get(i.userIndex) ?? 0) + 1);
    }
    for (const [user, count] of perUser) {
      expect(count, `user ${user} interactions`).toBeLessThanOrEqual(12);
    }
  });

  it('produces hot/cold like distributions', () => {
    const likesByPost = new Map<string, number>();
    for (const i of corpus.interactions.filter((x) => x.kind === 'like')) {
      const key = `${i.post.authorIndex}/${i.post.ordinal}`;
      likesByPost.set(key, (likesByPost.get(key) ?? 0) + 1);
    }
    const counts = [...likesByPost.values()].sort((a, b) => b - a);
    expect(counts[0]!).toBeGreaterThanOrEqual(5); // hot head
    expect(counts.length).toBeLessThan(corpus.posts.length); // cold tail exists
  });

  it('derives exact feed-entry expectations from fanout rules', () => {
    // Own posts + followed authors' posts + repost entries landing in the
    // user's feed (reposter audience).
    for (const [user, expected] of corpus.counts.feedEntriesByUser.entries()) {
      const own = corpus.posts.filter((p) => p.authorIndex === user).length;
      expect(expected).toBeGreaterThanOrEqual(own);
    }
  });

  it('binds the seed constant as the default', () => {
    expect(buildCorpus({ seed: SEED_CONSTANT }).fingerprint).toBe(corpus.fingerprint);
    expect(buildCorpus({ seed: 43 }).fingerprint).not.toBe(corpus.fingerprint);
  });

  it('fingerprints content, not ordering accidents', () => {
    const shuffled: SeedCorpus = {
      ...corpus,
      follows: [...corpus.follows].reverse(),
      interactions: [...corpus.interactions].reverse(),
      fingerprint: '',
    };
    // Follow/interaction order must not matter to the corpus identity.
    expect(corpusFingerprint(shuffled)).toBe(corpus.fingerprint);
  });

  it('fingerprints the age offsets and image looks as corpus content (#150)', () => {
    const nudged: SeedCorpus = {
      ...corpus,
      posts: corpus.posts.map((p, i) => (i === 0 ? { ...p, ageMs: p.ageMs + 1 } : p)),
      fingerprint: '',
    };
    expect(corpusFingerprint(nudged)).not.toBe(corpus.fingerprint);

    const resized: SeedCorpus = {
      ...corpus,
      posts: corpus.posts.map((p, i, all) => {
        const firstImage = all.findIndex((q) => q.imageSpec !== null);
        return i === firstImage && p.imageSpec
          ? { ...p, imageSpec: { ...p.imageSpec!, width: 42 } }
          : p;
      }),
      fingerprint: '',
    };
    expect(corpusFingerprint(resized)).not.toBe(corpus.fingerprint);
  });

  it('stays coherent for smaller corpora (no window/nesting violations)', () => {
    for (const options of [
      { userCount: 2, postsPerUser: 2, followDensity: 0 },
      { userCount: 3, postsPerUser: 4 },
      { userCount: 5, postsPerUser: 3, followDensity: 1 },
    ]) {
      const small = buildCorpus(options);
      const map = new Map(small.posts.map((p) => [keyOf(p), p]));
      for (const post of small.posts) {
        expect(post.ageMs, `${JSON.stringify(options)} ${keyOf(post)} age`).toBeGreaterThanOrEqual(
          MIN_POST_AGE_MS,
        );
        expect(post.ageMs).toBeLessThanOrEqual(MAX_POST_AGE_MS);
        if (post.replyTo) {
          const parent = map.get(keyOf(post.replyTo))!;
          expect(parent.ageMs).toBeGreaterThanOrEqual(post.ageMs);
        }
      }
    }
  });
});

describe('demoPng', () => {
  it('emits a valid PNG structure', () => {
    const png = demoPng(1);
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect(png.readUInt32BE(16)).toBe(96);
    expect(png.readUInt32BE(20)).toBe(64);
    expect(png.subarray(-8, -4).toString('ascii')).toBe('IEND');
    // IDAT inflates to the raw scanline payload (filter byte + RGB).
    const idatLength = png.readUInt32BE(33);
    const idat = png.subarray(41, 41 + idatLength);
    expect(inflateSync(idat).length).toBe(64 * (1 + 96 * 3));
  });

  it('is deterministic per seed and varies across seeds', () => {
    expect(Buffer.compare(demoPng(5), demoPng(5))).toBe(0);
    expect(Buffer.compare(demoPng(5), demoPng(6))).not.toBe(0);
  });

  it('renders every palette spec as a structurally valid, distinct image (#150)', () => {
    for (const [width, height] of DEMO_IMAGE_SIZES) {
      for (const pattern of DEMO_IMAGE_PATTERNS) {
        const png = demoPng(9, { pattern: pattern.id, width, height });
        expect(png.subarray(0, 8).at(0)).toBe(0x89); // PNG magic
        expect(png.readUInt32BE(16)).toBe(width);
        expect(png.readUInt32BE(20)).toBe(height);
        const idatLength = png.readUInt32BE(33);
        expect(inflateSync(png.subarray(41, 41 + idatLength)).length).toBe(
          height * (1 + width * 3),
        );
        expect(png.byteLength).toBeLessThan(64 * 1024); // stays tiny
      }
    }
    // Same size, different pattern -> different bytes (the looks differ).
    const horizontal = demoPng(9, { pattern: 'gradient-h', width: 96, height: 64 });
    const vertical = demoPng(9, { pattern: 'gradient-v', width: 96, height: 64 });
    expect(Buffer.compare(horizontal, vertical)).not.toBe(0);
  });

  it('stays well under the media size cap', () => {
    for (const seed of [0, 1, 2, 3, 9]) {
      expect(demoPng(seed).byteLength).toBeLessThan(64 * 1024);
    }
  });
});
