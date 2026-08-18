-- AlterTable
-- Denormalised ready-asset snapshot taken at post creation (variants are
-- immutable post-processing, so the snapshot cannot drift).
ALTER TABLE "Post" ADD COLUMN "media" JSONB NOT NULL DEFAULT '[]';
