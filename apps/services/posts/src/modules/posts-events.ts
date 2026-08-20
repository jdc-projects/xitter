import type { EventProducer, TopicName } from '@xitter/events';

/**
 * Domain events posts emits on xitter.posts.v1 (spec 04 catalogue). All are
 * keyed by postId: a post's lifecycle (and its interactions) stay ordered on
 * one partition.
 */
export type PostsEventType =
  | 'posts.post.created'
  | 'posts.post.deleted'
  | 'posts.interaction.created'
  | 'posts.interaction.deleted';

export interface PostsEvents {
  /**
   * `key` is the aggregate id (postId): same post = same partition = ordered
   * lifecycle (create before delete, interactions after creation), per spec 04.
   */
  emit(eventType: PostsEventType, payload: Record<string, unknown>, key?: string): Promise<void>;
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

  emit(eventType: PostsEventType, payload: Record<string, unknown>, key?: string): Promise<void> {
    return this.producer.emit(this.topic, {
      eventType,
      producer: 'posts',
      occurredAt: new Date().toISOString(),
      payload,
      key,
    });
  }

  shutdown(): Promise<void> {
    return this.producer.disconnect();
  }
}
