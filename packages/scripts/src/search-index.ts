#!/usr/bin/env tsx
/**
 * Idempotent creation of the OpenSearch `posts` index (spec 05): the same
 * shared definition the search service applies at boot (@xitter/config).
 * Bootstrap creates it up front so a freshly reset environment has the
 * mapping before the first event lands; the service's boot-time ensure and
 * every index write tolerate it already existing.
 */
// fallow-ignore-file unused-file -- run via bootstrap.ts (tsx), not imported
import { Client } from '@opensearch-project/opensearch';
import { loadRepoEnv, opensearchUrl, POSTS_INDEX, postsIndexDefinition } from '@xitter/config';

loadRepoEnv();

const client = new Client({ node: opensearchUrl(), ssl: { rejectUnauthorized: false } });

try {
  await client.indices.create({ index: POSTS_INDEX, body: postsIndexDefinition() });
  console.log(`created OpenSearch index ${POSTS_INDEX}`);
} catch (err) {
  const type = (err as { body?: { error?: { type?: string } } }).body?.error?.type;
  if (type === 'resource_already_exists_exception') {
    console.log(`OpenSearch index ${POSTS_INDEX} already present`);
  } else {
    throw err;
  }
} finally {
  await client.close().catch(() => undefined);
}
