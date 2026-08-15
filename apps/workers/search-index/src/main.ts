/**
 * Search-index worker: projects post and social events into the OpenSearch
 * posts index. Deployed as a Knative service; consumes Kafka only.
 */
import { loadRepoEnv, parseEnv } from "@xitter/config";
import { CONSUMER_GROUPS, TOPICS, createEventConsumer } from "@xitter/events";
import { initSentry, initTracing } from "@xitter/observability";
import { z } from "zod";
import { handleEvent } from "./handlers.js";

loadRepoEnv();

const env = parseEnv(
  z.object({
    KAFKA_BROKERS: z.string().min(1),
    SEARCH_INTERNAL_URL: z.string().url().default("http://localhost:8105"),
  }),
);

const tracing = initTracing("search-index-worker");
initSentry("search-index-worker");

const consumer = createEventConsumer({
  clientId: "xitter-search-index-worker",
  brokers: env.KAFKA_BROKERS.split(","),
  groupId: CONSUMER_GROUPS.searchIndexWorker,
  topics: [TOPICS.posts, TOPICS.social],
});

await consumer.run(async (envelope) => {
  await handleEvent(envelope, { searchInternalUrl: env.SEARCH_INTERNAL_URL });
});

console.log(`search-index worker consuming ${TOPICS.posts} + ${TOPICS.social}`);

process.once("SIGTERM", () => {
  void (async () => {
    await consumer.disconnect();
    await tracing.shutdown();
    process.exit(0);
  })();
});
