import { buildCorpus, MAX_POST_AGE_MS, MIN_POST_AGE_MS } from '../src/corpus.js';

const corpus = buildCorpus();
const byKey = new Map(corpus.posts.map((p) => [`${p.authorIndex}/${p.ordinal}`, p]));

console.log('users', corpus.counts.users, 'posts', corpus.counts.posts);
console.log(
  'replies', corpus.counts.replies,
  'imagePosts', corpus.counts.imagePosts,
  'likes', corpus.counts.likes,
  'reposts', corpus.counts.reposts,
  'bookmarks', corpus.counts.bookmarks,
);
console.log('fingerprint', corpus.fingerprint);

// Age spread
const ages = corpus.posts.map((p) => p.ageMs).sort((a, b) => b - a);
const day = 86_400_000;
console.log('age oldest (d)', (ages[0]! / day).toFixed(3), 'newest (min)', (ages.at(-1)! / 60_000).toFixed(1));
const outOfBounds = corpus.posts.filter((p) => p.ageMs < MIN_POST_AGE_MS || p.ageMs > MAX_POST_AGE_MS);
console.log('out-of-bounds ages:', outOfBounds.length);
const within24h = corpus.posts.filter((p) => p.ageMs < day).length;
console.log('posts within 24h:', within24h);

// Parent chronology
let badChronology = 0;
for (const p of corpus.posts) {
  if (!p.replyTo) continue;
  const parent = byKey.get(`${p.replyTo.authorIndex}/${p.replyTo.ordinal}`)!;
  if (parent.ageMs < p.ageMs) badChronology += 1;
}
console.log('replies newer than parent (violations):', badChronology);

// Burst check: same author pairs within 60 min
const bursts = new Map<string, number>();
for (const a of corpus.users.keys()) {
  const sorted = corpus.posts.filter((p) => p.authorIndex === a).map((p) => p.ageMs).sort((x, y) => y - x);
  let pairs = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i - 1]! - sorted[i]! < 60 * 60_000) pairs += 1;
  bursts.set(`demo${a + 1}`, pairs);
}
console.log('same-author <60min pairs per user:', [...bursts.values()]);

// Thread nesting
const depthOf = (key: string, memo = new Map<string, number>()): number => {
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const post = byKey.get(key)!;
  const d = post.replyTo ? 1 + depthOf(`${post.replyTo.authorIndex}/${post.replyTo.ordinal}`, memo) : 1;
  memo.set(key, d);
  return d;
};
const threads = new Map<string, number[]>();
for (const p of corpus.posts) {
  if (!p.replyTo) continue;
  let root: typeof p = p;
  while (root.replyTo) root = byKey.get(`${root.replyTo.authorIndex}/${root.replyTo.ordinal}`)!;
  const key = `${root.authorIndex}/${root.ordinal}`;
  threads.set(key, [...(threads.get(key) ?? []), depthOf(`${p.authorIndex}/${p.ordinal}`)]);
}
for (const [root, depths] of threads) {
  console.log('thread root', root, 'replies', depths.length, 'max depth', Math.max(...depths));
}

// Image variety
const imagePosts = corpus.posts.filter((p) => p.mediaCount > 0);
console.log('image authors', new Set(imagePosts.map((p) => p.authorIndex)).size);
console.log('patterns', new Set(imagePosts.map((p) => p.imageSpec!.pattern)).size,
  'sizes', new Set(imagePosts.map((p) => `${p.imageSpec!.width}x${p.imageSpec!.height}`)).size);
console.log('alt sample:', imagePosts[0]!.imageAlt);

// Determinism
const again = buildCorpus();
console.log('deterministic:', again.fingerprint === corpus.fingerprint);

// Small corpora don't crash
for (const opts of [
  { userCount: 2, postsPerUser: 2, followDensity: 0 },
  { userCount: 3, postsPerUser: 4 },
  { userCount: 5, postsPerUser: 3, followDensity: 1 },
]) {
  const c = buildCorpus(opts);
  const violations = c.posts.filter((p) => p.ageMs < MIN_POST_AGE_MS || p.ageMs > MAX_POST_AGE_MS).length;
  let chrono = 0;
  const map = new Map(c.posts.map((p) => [`${p.authorIndex}/${p.ordinal}`, p]));
  for (const p of c.posts) {
    if (!p.replyTo) continue;
    if ((map.get(`${p.replyTo.authorIndex}/${p.replyTo.ordinal}`)!.ageMs ?? 0) < p.ageMs) chrono += 1;
  }
  console.log(
    `opts ${JSON.stringify(opts)} -> posts ${c.counts.posts} replies ${c.counts.replies} images ${c.counts.imagePosts} ageViolations ${violations} chronoViolations ${chrono}`,
  );
}
