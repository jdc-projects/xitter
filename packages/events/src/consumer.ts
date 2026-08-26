import {
  Kafka,
  type Consumer,
  type EachMessagePayload,
  type KafkaMessage,
} from 'kafkajs';
import { eventEnvelopeSchema } from './envelope.js';
import { TOPICS, type TopicName } from './topics.js';
import { applyKafkaRequestQueueFix } from './kafka-request-queue-fix.js';

void applyKafkaRequestQueueFix();

export interface EventConsumerOptions {
  clientId: string;
  brokers: string[];
  groupId: string;
  /** Topics to consume. */
  topics: TopicName[];
  /**
   * Start at the log beginning when the group has no committed offset
   * (default false = log end). Workers that build derived state from the
   * event log (search-index) want the full replay on a fresh group.
   */
  fromBeginning?: boolean;
  /** Suffix (e.g. env name) for isolation in shared clusters; empty for local. */
  topicPrefix?: string;
}

export interface EventConsumerRunOptions {
  /**
   * Resume positions keyed `topic:partition` -> next offset to consume,
   * applied as seeks on partition assignment. Overrides the default
   * (committed group offset / fromBeginning) so a worker with durable
   * checkpoints survives consumer-group loss. Idempotent handlers make a
   * stale map safe - it rewinds into harmless replays.
   */
  resumeFrom?: ReadonlyMap<string, number>;
}

/**
 * One envelope-parsed message from a batch, carrying the same per-message
 * Kafka context eachMessage provides (topic/partition/offset/heartbeat) so
 * batch handlers checkpoint exactly like message handlers do.
 */
export interface BatchedEvent {
  envelope: unknown;
  raw: EachMessagePayload;
}

/**
 * Batch handler: one kafkajs fetch batch = one topic-partition's slice of
 * the log, in order. The whole slice must be side-effected before
 * returning; kafkajs resolves (and later commits) the batch's offsets only
 * after the handler resolves, so a throw redelivers the entire batch -
 * handlers must therefore be idempotent across the batch, not just per
 * message.
 */
export type BatchHandler = (
  events: BatchedEvent[],
  context: { topic: string; partition: number },
) => Promise<void>;

/**
 * Apply resume positions on partition assignment. Seeks must land after
 * assignment but before the first fetch: GROUP_JOIN is emitted inside
 * joinAndSync - before the runner schedules its fetch manager - so seeks
 * registered here apply to the very first fetch of each assigned
 * partition. Stale map entries for partitions we no longer hold are
 * ignored (seeks are keyed per topic-partition and consumed on first
 * fetch).
 */
function registerResumeSeeks(consumer: Consumer, resumeFrom?: ReadonlyMap<string, number>) {
  if (!resumeFrom || resumeFrom.size === 0) return;
  consumer.on(consumer.events.GROUP_JOIN, (event) => {
    for (const [topic, partitions] of Object.entries(event.payload.memberAssignment)) {
      for (const partition of partitions) {
        const nextOffset = resumeFrom.get(`${topic}:${partition}`);
        if (nextOffset !== undefined) {
          consumer.seek({ topic, partition, offset: String(nextOffset) });
        }
      }
    }
  });
}

/**
 * Run one message with a short inline retry. Handlers are idempotent
 * (at-least-once contract), so this rides out transient upstream blips
 * (single ECONNRESET / Keycloak keep-alive race on an M2M token fetch)
 * without crashing the consumer - observed killing the search-index
 * worker mid-e2e-run, leaving its derived store silently stalled.
 * Persistent failures still exhaust kafkajs' own retries and crash as
 * before.
 */
async function runWithInlineRetry(
  position: { topic: string; partition: number; message: { offset: string } },
  handle: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await handle();
      return;
    } catch (err) {
      if (attempt >= 2) throw err;
      console.warn(
        `handler error on ${position.topic}[${position.partition}]@${position.message.offset} (attempt ${attempt + 1}/3) - retrying`,
        err,
      );
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

export interface EventConsumer {
  consumer: Consumer;
  /**
   * Subscribe and process messages one at a time (eachMessage). Malformed
   * envelopes are logged and skipped. Handlers must be idempotent
   * (at-least-once delivery); a thrown handler error retries per the
   * consumer retry policy and eventually parks the partition.
   */
  run(
    handler: (envelope: unknown, raw: EachMessagePayload) => Promise<void>,
    runOptions?: EventConsumerRunOptions,
  ): Promise<void>;
  /**
   * Subscribe and process whole fetch batches (eachBatch, one batch per
   * topic-partition per fetch). Same envelope parsing, poison policy and
   * inline retry as `run`; offsets only advance when the batch handler
   * resolves, so a mid-batch failure redelivers the whole batch.
   */
  runBatch(handler: BatchHandler, runOptions?: EventConsumerRunOptions): Promise<void>;
  disconnect(): Promise<void>;
}

export function createEventConsumer(options: EventConsumerOptions): EventConsumer {
  const kafka = new Kafka({ clientId: options.clientId, brokers: options.brokers });
  const consumer = kafka.consumer({
    groupId: options.groupId,
    // Group-coordinator handover (fresh broker booting, rebalances) is
    // retriable, but the default 5 fast retries exhaust while
    // __consumer_offsets settles - crash-looping the consumer instead of
    // waiting out the handover. Seen on every testcontainers first-join.
    retry: { retries: 10, initialRetryTime: 500, maxRetryTime: 5_000 },
  });
  const prefix = options.topicPrefix ? `${options.topicPrefix}.` : '';
  const connectAndSubscribe = async (runOptions?: EventConsumerRunOptions) => {
    registerResumeSeeks(consumer, runOptions?.resumeFrom);
    await consumer.connect();
    for (const topic of options.topics) {
      await consumer.subscribe({
        topic: `${prefix}${TOPICS[topic]}`,
        fromBeginning: options.fromBeginning ?? false,
      });
    }
  };
  return {
    consumer,
    async run(handler, runOptions) {
      await connectAndSubscribe(runOptions);
      await consumer.run({
        eachMessage: async (payload) => {
          const envelope = parseEnvelope(payload.topic, payload.partition, payload.message);
          if (envelope === null) return;
          await runWithInlineRetry(payload, () => handler(envelope, payload));
        },
      });
    },
    async runBatch(handler, runOptions) {
      await connectAndSubscribe(runOptions);
      await consumer.run({
        eachBatch: async (payload) => {
          const { topic, partition, messages } = payload.batch;
          const events: BatchedEvent[] = [];
          for (const message of messages) {
            const envelope = parseEnvelope(topic, partition, message);
            if (envelope === null) continue;
            events.push({
              envelope,
              raw: { topic, partition, message, heartbeat: payload.heartbeat, pause: payload.pause },
            });
          }
          if (events.length === 0) return; // all poison: offsets commit, nothing to do
          const last = events[events.length - 1]!.raw.message.offset;
          await runWithInlineRetry({ topic, partition, message: { offset: last } }, () =>
            handler(events, { topic, partition }),
          );
        },
      });
    },
    async disconnect() {
      await consumer.disconnect();
    },
  };
}

/**
 * Envelope boundary shared by both run modes. Returns null for a poison
 * message (logged + skipped): a throw would crash the consumer and
 * hot-loop the partition.
 */
function parseEnvelope(
  topic: string,
  partition: number,
  message: KafkaMessage,
): unknown | null {
  const value = message.value?.toString('utf8') ?? '{}';
  try {
    return eventEnvelopeSchema.parse(JSON.parse(value));
  } catch (err) {
    console.error(
      `skipping malformed event on ${topic}[${partition}]@${message.offset}`,
      err,
    );
    return null;
  }
}
