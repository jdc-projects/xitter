-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "SearchCheckpoint" (
    "id" TEXT NOT NULL,
    "consumerKey" TEXT NOT NULL,
    "topicPartition" TEXT NOT NULL,
    "lastOffset" BIGINT NOT NULL,
    "lastEventId" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SearchCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One resume position per (consumer, topic-partition): the worker upserts
-- its position after every processed message (spec 05: SearchCheckpoint).
CREATE UNIQUE INDEX "SearchCheckpoint_consumerKey_topicPartition_key" ON "SearchCheckpoint"("consumerKey", "topicPartition");
