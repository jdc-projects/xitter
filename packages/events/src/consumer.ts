import { Kafka, type Consumer, type EachMessagePayload } from 'kafkajs';
import { eventEnvelopeSchema } from './envelope.js';
import { TOPICS, type TopicName } from './topics.js';

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

export interface EventConsumer {
  consumer: Consumer;
  /**
   * Subscribe and process messages. Malformed envelopes are logged and
   * skipped. Handlers must be idempotent (at-least-once delivery); a thrown
   * handler error retries per the consumer retry policy and eventually parks
   * the partition.
   */
  run(
    handler: (envelope: unknown, raw: EachMessagePayload) => Promise<void>,
    runOptions?: EventConsumerRunOptions,
  ): Promise<void>;
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
  return {
    consumer,
    async run(handler, runOptions) {
      if (runOptions?.resumeFrom && runOptions.resumeFrom.size > 0) {
        // Seeks must land after assignment but before the first fetch.
        // GROUP_JOIN is emitted inside joinAndSync - before the runner
        // schedules its fetch manager - so seeks registered here apply to
        // the very first fetch of each assigned partition. Stale map
        // entries for partitions we no longer hold are ignored (seeks are
        // keyed per topic-partition and consumed on first fetch).
        consumer.on(consumer.events.GROUP_JOIN, (event) => {
          for (const [topic, partitions] of Object.entries(event.payload.memberAssignment)) {
            for (const partition of partitions) {
              const nextOffset = runOptions.resumeFrom?.get(`${topic}:${partition}`);
              if (nextOffset !== undefined) {
                consumer.seek({ topic, partition, offset: String(nextOffset) });
              }
            }
          }
        });
      }
      await consumer.connect();
      for (const topic of options.topics) {
        await consumer.subscribe({
          topic: `${prefix}${TOPICS[topic]}`,
          fromBeginning: options.fromBeginning ?? false,
        });
      }
      await consumer.run({
        eachMessage: async (payload) => {
          const value = payload.message.value?.toString('utf8') ?? '{}';
          let envelope: unknown;
          try {
            envelope = eventEnvelopeSchema.parse(JSON.parse(value));
          } catch (err) {
            // Poison message: log + skip (offset commits on return). A throw
            // here would crash the consumer and hot-loop the partition.
            console.error(
              `skipping malformed event on ${payload.topic}[${payload.partition}]@${payload.message.offset}`,
              err,
            );
            return;
          }
          await handler(envelope, payload);
        },
      });
    },
    async disconnect() {
      await consumer.disconnect();
    },
  };
}
