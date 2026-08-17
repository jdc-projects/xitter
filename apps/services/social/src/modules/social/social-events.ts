import type { EventProducer, TopicName } from '@xitter/events';

/**
 * Domain events social emits on xitter.social.v1 (spec 04 catalogue).
 * `social.profile.updated` keeps downstream snapshots (search docs) fresh.
 */
export type SocialEventType =
  | 'social.follow.created'
  | 'social.follow.deleted'
  | 'social.block.created'
  | 'social.block.deleted'
  | 'social.profile.updated';

export interface SocialEvents {
  emit(eventType: SocialEventType, payload: Record<string, unknown>): Promise<void>;
  shutdown(): Promise<void>;
}

/** Injection token (string token so test doubles are easy to provide). */
export const SOCIAL_EVENTS = 'SOCIAL_EVENTS';

export class NullSocialEvents implements SocialEvents {
  emit(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Kafka-backed emitter: one producer per service process, shared topic. */
export class KafkaSocialEvents implements SocialEvents {
  constructor(
    private readonly producer: EventProducer,
    private readonly topic: TopicName,
  ) {}

  emit(eventType: SocialEventType, payload: Record<string, unknown>): Promise<void> {
    return this.producer.emit(this.topic, {
      eventType,
      producer: 'social',
      occurredAt: new Date().toISOString(),
      payload,
    });
  }

  shutdown(): Promise<void> {
    return this.producer.disconnect();
  }
}
