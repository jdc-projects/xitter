import { Kafka, type Producer } from 'kafkajs';
import { eventEnvelopeSchema, type EventEnvelope } from './envelope.js';
import { applyKafkaRequestQueueFix } from './kafka-request-queue-fix.js';
import { TOPICS, type TopicName } from './topics.js';

void applyKafkaRequestQueueFix();

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
  /**
   * Partition key - the aggregate id (postId, followerId, mediaId, ...).
   * Same key = same partition = ordered consumption for that aggregate
   * (spec 04). Omitted keys fall back to the eventType, which orders only
   * per event type.
   */
  key?: string;
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
  // Eager connect for first-emit latency; send() also (re)connects on demand,
  // so a broker outage at boot degrades the first emit instead of bricking it.
  producer.connect().catch(() => undefined);

  const send = (
    topic: TopicName,
    messages: Array<{ key: string; value: string; headers: { eventType: string } }>,
  ) => producer.send({ topic: `${prefix}${TOPICS[topic]}`, messages });

  return {
    producer,
    async emit(topic: TopicName, event: EmitInput) {
      const envelope: EventEnvelope = eventEnvelopeSchema.parse({
        ...event,
        eventVersion: 1,
        eventId: crypto.randomUUID(),
      });
      const messages = [envelopeMessages(event, envelope)];
      try {
        await send(topic, messages);
      } catch (err) {
        // kafkajs send() connects on demand; a failed eager connect at boot
        // is retried here, so a broker outage at startup must not brick the
        // producer. A DROPPED connection is the harder case: send() rejects
        // with 'The producer is disconnected' and never self-heals, so
        // reconnect and retry once for exactly that failure.
        if (!(err instanceof Error) || !err.message.includes('producer is disconnected')) {
          throw err;
        }
        await producer.connect();
        await send(topic, messages);
      }
    },
    async disconnect() {
      await producer.disconnect();
    },
  };
}

function envelopeMessages(
  event: EmitInput,
  envelope: EventEnvelope,
): { key: string; value: string; headers: { eventType: string } } {
  return {
    key: event.key ?? envelope.eventType,
    value: JSON.stringify(envelope),
    headers: { eventType: envelope.eventType },
  };
}
