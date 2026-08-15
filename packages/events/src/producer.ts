import { Kafka, type Producer } from 'kafkajs';
import { eventEnvelopeSchema, type EventEnvelope } from './envelope.js';
import { TOPICS, type TopicName } from './topics.js';

export interface EventProducerOptions {
  clientId: string;
  brokers: string[];
  /** Prefix (e.g. env name) for topic isolation in shared clusters; empty for local. */
  topicPrefix?: string;
}

export interface EmitInput {
  eventType: string;
  producer: string;
  occurredAt: string;
  payload: unknown;
}

export interface EventProducer {
  /** Emit a typed domain event wrapped in the shared envelope. */
  emit(topic: TopicName, event: EmitInput): Promise<void>;
  producer: Producer;
  disconnect(): Promise<void>;
}

export function createEventProducer(options: EventProducerOptions): EventProducer {
  const kafka = new Kafka({ clientId: options.clientId, brokers: options.brokers });
  const producer = kafka.producer();
  const prefix = options.topicPrefix ? `${options.topicPrefix}.` : '';
  // Eager connect for first-emit latency; swallow rejection so an early broker
  // outage surfaces at emit instead of as an unhandled rejection.
  const started = producer.connect();
  started.catch(() => undefined);

  return {
    producer,
    async emit(topic: TopicName, event: EmitInput) {
      await started;
      const envelope: EventEnvelope = eventEnvelopeSchema.parse({
        ...event,
        eventVersion: 1,
        eventId: crypto.randomUUID(),
      });
      await producer.send({
        topic: `${prefix}${TOPICS[topic]}`,
        messages: [
          {
            key: envelope.eventType,
            value: JSON.stringify(envelope),
            headers: { eventType: envelope.eventType },
          },
        ],
      });
    },
    async disconnect() {
      await producer.disconnect();
    },
  };
}
