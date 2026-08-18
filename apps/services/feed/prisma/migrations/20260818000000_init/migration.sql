-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "FeedEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "repostedById" TEXT,
    "postCreatedAt" TIMESTAMP(3) NOT NULL,
    "insertedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeedEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Natural key (spec 04 idempotency); repostedById is excluded because
-- Postgres unique indexes treat NULLs as distinct (see schema comment).
CREATE UNIQUE INDEX "FeedEntry_userId_postId_reason_key" ON "FeedEntry"("userId", "postId", "reason");

-- CreateIndex
CREATE INDEX "FeedEntry_userId_postCreatedAt_id_idx" ON "FeedEntry"("userId", "postCreatedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "FeedEntry_postId_idx" ON "FeedEntry"("postId");

-- CreateIndex
CREATE INDEX "FeedEntry_userId_authorId_idx" ON "FeedEntry"("userId", "authorId");
