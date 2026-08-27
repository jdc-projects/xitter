-- CreateTable
CREATE TABLE "FeedCheckpoint" (
    "id" TEXT NOT NULL,
    "consumerKey" TEXT NOT NULL,
    "topicPartition" TEXT NOT NULL,
    "lastOffset" BIGINT NOT NULL,
    "lastEventId" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FeedCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One resume position per (consumer, topic-partition): the fanout worker
-- upserts its position after every processed event (#149), so a restart
-- outside a reset resumes exactly after the last one instead of seeking to
-- the log end and skipping the downtime gap.
CREATE UNIQUE INDEX "FeedCheckpoint_consumerKey_topicPartition_key" ON "FeedCheckpoint"("consumerKey", "topicPartition");
