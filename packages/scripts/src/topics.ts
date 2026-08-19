#!/usr/bin/env tsx
/**
 * Kafka topic management: `tsx packages/scripts/src/topics.ts create`.
 * Idempotent - safe to re-run (part of bootstrap and reset).
 */
import { Kafka } from 'kafkajs';
import { localPort, loadRepoEnv } from '@xitter/config';
import { ALL_TOPICS } from '@xitter/events';

loadRepoEnv();

const command = process.argv[2] ?? 'create';

if (command !== 'create') {
  console.error(`Unknown command: ${command}. Use create.`);
  process.exit(1);
}

const kafka = new Kafka({
  clientId: 'xitter-topics',
  brokers: [`localhost:${localPort('kafka')}`],
});
const admin = kafka.admin();

await admin.connect();
try {
  const existing = new Set(await admin.listTopics());
  for (const topic of ALL_TOPICS) {
    if (existing.has(topic)) {
      console.log(`topic ${topic}: exists`);
      continue;
    }
    // Back-to-back creates can hit 'does not host this topic-partition':
    // the controller hasn't propagated the previous topic's metadata yet.
    // createTopics returning true already settled; transient protocol
    // errors are retried after a short pause.
    let created = false;
    for (let attempt = 1; attempt <= 5 && !created; attempt++) {
      try {
        await admin.createTopics({
          topics: [
            {
              topic,
              numPartitions: 6,
              replicationFactor: 1,
              configEntries: [
                { name: 'retention.ms', value: String(7 * 24 * 60 * 60 * 1000) },
                { name: 'cleanup.policy', value: 'delete' },
              ],
            },
          ],
        });
        created = true;
      } catch (err) {
        if (attempt === 5) throw err;
        console.log(`topic ${topic}: attempt ${attempt} not settled - retrying`);
        await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
      }
    }
    console.log(`topic ${topic}: created`);
  }
} finally {
  await admin.disconnect();
}
