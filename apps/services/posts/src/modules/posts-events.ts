import type { EventProducer, TopicName } from '@xitter/events';

/** Domain events posts emits on xitter.posts.v1 (spec 04 catalogue). */
export type PostsEventType = 'posts.post.created' | 'posts.post.deleted';

export interface PostsEvents {
  emit(eventType: PostsEventType, payload: Record<string, unknown>): Promise<void>;
  shutdown(): Promise<void>;
}

/** Injection token (string token so test doubles are easy to provide). */
export const POSTS_EVENTS = 'POSTS_EVENTS';

export class NullPostsEvents implements PostsEvents {
  emit(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/** Kafka-backed emitter: one producer per service process, shared topic. */
export class KafkaPostsEvents implements PostsEvents {
  constructor(
    private readonly producer: EventProducer,
    private readonly topic: TopicName,
  ) {}

  emit(eventType: PostsEventType, payload: Record<string, unknown>): Promise<void> {
    return this.producer.emit(this.topic, {
      eventType,
      producer: 'posts',
      occurredAt: new Date().toISOString(),
      payload,
    });
  }

  shutdown(): Promise<void> {
    return this.producer.disconnect();
  }
}
