/**
 * Fanout worker: turns post.created / interaction events into materialised
 * feed entries. Deployed as a Knative service; consumes Kafka only.
 */
import { loadRepoEnv, localPort, parseEnv } from "@xitter/config";
import { CONSUMER_GROUPS, TOPICS, createEventConsumer } from "@xitter/events";
import { initSentry, initTracing } from "@xitter/observability";
import { z } from "zod";
import { handleEvent } from "./handlers.js";

loadRepoEnv();

const env = parseEnv(
  z.object({
    KAFKA_BROKERS: z.string().min(1),
    METRICS_PORT: z.coerce.number().int().positive().default(localPort("feed") + 100),
    FEED_INTERNAL_URL: z.string().url().default("http://localhost:8104"),
  }),
);

const tracing = initTracing("fanout-worker");
initSentry("fanout-worker");

const consumer = createEventConsumer({
  clientId: "xitter-fanout-worker",
  brokers: env.KAFKA_BROKERS.split(","),
  groupId: CONSUMER_GROUPS.fanoutWorker,
  topics: [TOPICS.posts, TOPICS.social],
});

await consumer.run(async (envelope) => {
  await handleEvent(envelope, { feedInternalUrl: env.FEED_INTERNAL_URL });
});

console.log(`fanout worker consuming ${TOPICS.posts} + ${TOPICS.social}`);

process.once("SIGTERM", () => {
  void (async () => {
    await consumer.disconnect();
    await tracing.shutdown();
    process.exit(0);
  })();
});
