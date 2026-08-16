import { Kafka, type Consumer, type EachMessagePayload } from 'kafkajs';
import { eventEnvelopeSchema } from './envelope.js';
import { TOPICS, type TopicName } from './topics.js';

export interface EventConsumerOptions {
  clientId: string;
  brokers: string[];
  groupId: string;
  /** Topics to consume. */
  topics: TopicName[];
  /** Suffix (e.g. env name) for isolation in shared clusters; empty for local. */
  topicPrefix?: string;
}

export interface EventConsumer {
  consumer: Consumer;
  /**
   * Subscribe and process messages. Malformed envelopes are logged and
   * skipped. Handlers must be idempotent (at-least-once delivery); a thrown
   * handler error retries per the consumer retry policy and eventually parks
   * the partition.
   */
  run(handler: (envelope: unknown, raw: EachMessagePayload) => Promise<void>): Promise<void>;
  disconnect(): Promise<void>;
}

export function createEventConsumer(options: EventConsumerOptions): EventConsumer {
  const kafka = new Kafka({ clientId: options.clientId, brokers: options.brokers });
  const consumer = kafka.consumer({ groupId: options.groupId });
  const prefix = options.topicPrefix ? `${options.topicPrefix}.` : '';
  return {
    consumer,
    async run(handler) {
      await consumer.connect();
      for (const topic of options.topics) {
        await consumer.subscribe({ topic: `${prefix}${TOPICS[topic]}`, fromBeginning: false });
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
