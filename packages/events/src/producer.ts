import { Kafka, type Producer } from "kafkajs";
import { z } from "zod";
import { eventEnvelopeSchema, type EventEnvelope } from "./envelope.js";
import { TOPICS, type TopicName } from "./topics.js";

export interface EventProducerOptions {
  clientId: string;
  brokers: string[];
  /** Suffix (e.g. env name) for isolation in shared clusters; empty for local. */
  topicPrefix?: string;
}

export interface EventProducer {
  /** Emit a typed domain event wrapped in the shared envelope. */
  emit(topic: TopicName, event: Omit<EventEnvelope, "eventId" | "eventVersion" | "producer"> & { producer: string }): Promise<void>;
  producer: Producer;
  disconnect(): Promise<void>;
}

export function createEventProducer(options: EventProducerOptions): EventProducer {
  const kafka = new Kafka({ clientId: options.clientId, brokers: options.brokers });
  const producer = kafka.producer();
  const prefix = options.topicPrefix ? `${options.topicPrefix}.` : "";
  const started = producer.connect();

  return {
    producer,
    async emit(topic, event) {
      await started;
      const envelope: EventEnvelope = eventEnvelopeSchema.parse({
        ...event,
        eventVersion: 1,
        eventId: crypto.randomUUID(),
      });
      await producer.send({
        topic: `${prefix}${topic}`,
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

/** Narrow an unknown parsed value to a specific event schema, for tests and tooling. */
export function expectEvent<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  return schema.parse(value);
}

export { TOPICS };
