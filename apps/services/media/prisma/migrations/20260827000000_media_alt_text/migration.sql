-- Alt text for post images (#133): optional, set on the asset when the
-- owning post is created. Nullable so existing rows need no backfill.
ALTER TABLE "MediaAsset" ADD COLUMN "altText" TEXT;
