import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildCorpus,
  corpusFingerprint,
  DEFAULT_FOLLOW_DENSITY,
  SEED_CONSTANT,
  type SeedCorpus,
} from './corpus.js';
import { demoPng } from './lib/images.js';

/**
 * Corpus contracts (spec data 02): identical everywhere, fixed volumes,
 * structurally valid graph/content. The fingerprint equality across two
 * independent builds is THE determinism guarantee every environment
 * inherits.
 */
describe('buildCorpus', () => {
  const corpus = buildCorpus();

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
    expect(corpus.counts.imagePosts).toBeGreaterThanOrEqual(4);
    expect(corpus.counts.reposts).toBeGreaterThanOrEqual(5);
    expect(corpus.counts.bookmarks).toBeGreaterThanOrEqual(10);
    expect(corpus.counts.likes).toBeGreaterThan(corpus.counts.reposts);
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
    // already exist when it is created.
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
    const rootCounts = new Map<string, number>();
    for (const post of corpus.posts) {
      if (!post.replyTo) continue;
      const key = `${post.replyTo.authorIndex}/${post.replyTo.ordinal}`;
      rootCounts.set(key, (rootCounts.get(key) ?? 0) + 1);
    }
    const threads = [...rootCounts.values()];
    expect(threads.length).toBeLessThanOrEqual(5); // concentrated, not scattered
    expect(Math.max(...threads)).toBeGreaterThanOrEqual(3); // real conversations
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

  it('stays well under the media size cap', () => {
    for (const seed of [0, 1, 2, 3, 9]) {
      expect(demoPng(seed).byteLength).toBeLessThan(64 * 1024);
    }
  });
});
