#!/usr/bin/env tsx
/**
 * Kafka topic management: `tsx packages/scripts/src/topics.ts create`.
 * Idempotent - safe to re-run (part of bootstrap and reset).
 */
import { Kafka } from 'kafkajs';
import { localPort, loadRepoEnv } from '@xitter/config';
import { ALL_TOPICS } from '@xitter/events';

export const TOPIC_CONFIG = [
  { name: 'retention.ms', value: String(7 * 24 * 60 * 60 * 1000) },
  { name: 'cleanup.policy', value: 'delete' },
] as const;

/**
 * Ensure every topic exists (creating missing ones with the standard config).
 * Shared by bootstrap and the reset flow's topic recreation - one creation
 * code path. Takes the Kafka instance so the reset can target a cluster.
 */
export async function ensureTopics(kafka: Kafka): Promise<void> {
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
            topics: [{ topic, numPartitions: 6, replicationFactor: 1, configEntries: [...TOPIC_CONFIG] }],
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
    await admin.disconnect().catch(() => undefined);
  }
}

loadRepoEnv();

const command = process.argv[2] ?? 'create';

if (command !== 'create') {
  console.error(`Unknown command: ${command}. Use create.`);
  process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('topics.ts')) {
  const kafka = new Kafka({
    clientId: 'xitter-topics',
    brokers: [`localhost:${localPort('kafka')}`],
  });
  await ensureTopics(kafka);
}
