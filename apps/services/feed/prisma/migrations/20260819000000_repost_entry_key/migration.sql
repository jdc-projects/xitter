-- Repost natural key (#8): the (userId, postId, reason) unique index cannot
-- distinguish two different reposters of the same post - the second fan-out
-- row was silently dropped by skipDuplicates. entryKey is a derived,
-- NOT-NULL identity of the fanning-out source (`post:{postId}` or
-- `repost:{postId}:{repostedById}`), so a nullable column never enters the
-- key and Postgres NULL-distinct semantics cannot open holes.

-- CreateTable (column first, backfill, then constrain)
ALTER TABLE "FeedEntry" ADD COLUMN "entryKey" TEXT NOT NULL DEFAULT '';

-- Backfill: every existing row is a reason='post' entry (reposts land with
-- this migration), so the key is the post-prefixed form.
UPDATE "FeedEntry" SET "entryKey" = 'post:' || "postId";

-- Drop and recreate the natural key on the derived identity.
DROP INDEX "FeedEntry_userId_postId_reason_key";
CREATE UNIQUE INDEX "FeedEntry_userId_entryKey_key" ON "FeedEntry"("userId", "entryKey");
