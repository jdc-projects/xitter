/**
 * Kafka topics. One topic per producing service+domain, versioned in the name.
 * Events are JSON with a shared envelope (see envelope.ts); consumers select by `eventType`.
 */
export const TOPICS = {
  posts: "xitter.posts.v1",
  social: "xitter.social.v1",
  media: "xitter.media.v1",
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];

export const ALL_TOPICS = Object.values(TOPICS);

/** Consumer groups - one per logical consumer, used as the reset baseline. */
export const CONSUMER_GROUPS = {
  fanoutWorker: "xitter-fanout-worker",
  mediaProcessWorker: "xitter-media-process-worker",
  searchIndexWorker: "xitter-search-index-worker",
} as const;
