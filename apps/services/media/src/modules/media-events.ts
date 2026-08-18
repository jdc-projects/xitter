import type { EventProducer, TopicName } from '@xitter/events';

/** Domain events media emits on xitter.media.v1 (spec 04 catalogue). */
export type MediaEventType = 'media.media.uploaded' | 'media.media.processed';

export interface MediaEvents {
  /** `key` is the mediaId (per-aggregate ordering, spec 04). */
  emit(eventType: MediaEventType, payload: Record<string, unknown>, key?: string): Promise<void>;
  shutdown(): Promise<void>;
}

/** Injection token (string token so test doubles are easy to provide). */
export const MEDIA_EVENTS = 'MEDIA_EVENTS';

export class NullMediaEvents implements MediaEvents {
  emit(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Kafka-backed emitter: one producer per service process, shared topic. */
export class KafkaMediaEvents implements MediaEvents {
  constructor(
    private readonly producer: EventProducer,
    private readonly topic: TopicName,
  ) {}

  emit(eventType: MediaEventType, payload: Record<string, unknown>, key?: string): Promise<void> {
    return this.producer.emit(this.topic, {
      eventType,
      producer: 'media',
      occurredAt: new Date().toISOString(),
      payload,
      key,
    });
  }

  shutdown(): Promise<void> {
    return this.producer.disconnect();
  }
}
