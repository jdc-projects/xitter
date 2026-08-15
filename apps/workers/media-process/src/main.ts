/**
 * Media-process worker: generates image variants (original, thumb) with sharp
 * and reports them back to the media service. Deployed as a Knative service;
 * consumes Kafka only.
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
    MEDIA_INTERNAL_URL: z.string().url().default("http://localhost:8103"),
  }),
);

const tracing = initTracing("media-process-worker");
initSentry("media-process-worker");

const consumer = createEventConsumer({
  clientId: "xitter-media-process-worker",
  brokers: env.KAFKA_BROKERS.split(","),
  groupId: CONSUMER_GROUPS.mediaProcessWorker,
  topics: [TOPICS.media],
});

await consumer.run(async (envelope) => {
  await handleEvent(envelope, { mediaInternalUrl: env.MEDIA_INTERNAL_URL });
});

console.log(`media-process worker consuming ${TOPICS.media}`);

process.once("SIGTERM", () => {
  void (async () => {
    await consumer.disconnect();
    await tracing.shutdown();
    process.exit(0);
  })();
});
