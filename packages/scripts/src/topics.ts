#!/usr/bin/env tsx
/**
 * Kafka topic management: `tsx packages/scripts/src/topics.ts create`.
 * Idempotent - safe to re-run (part of bootstrap and reset).
 */
import { Kafka } from "kafkajs";
import { localPort, loadRepoEnv } from "@xitter/config";
import { ALL_TOPICS } from "@xitter/events";

loadRepoEnv();

const command = process.argv[2] ?? "create";

if (command !== "create") {
  console.error(`Unknown command: ${command}. Use create.`);
  process.exit(1);
}

const kafka = new Kafka({ clientId: "xitter-topics", brokers: [`localhost:${localPort("kafka")}`] });
const admin = kafka.admin();

await admin.connect();
try {
  const existing = new Set(await admin.listTopics());
  for (const topic of ALL_TOPICS) {
    if (existing.has(topic)) {
      console.log(`topic ${topic}: exists`);
      continue;
    }
    await admin.createTopics({
      topics: [
        {
          topic,
          numPartitions: 6,
          replicationFactor: 1,
          configEntries: [
            { name: "retention.ms", value: String(7 * 24 * 60 * 60 * 1000) },
            { name: "cleanup.policy", value: "delete" },
          ],
        },
      ],
    });
    console.log(`topic ${topic}: created`);
  }
} finally {
  await admin.disconnect();
}
