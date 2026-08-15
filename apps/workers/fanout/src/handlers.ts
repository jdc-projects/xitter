import { EVENT_TYPES } from "@xitter/events";

export interface HandlerDeps {
  feedInternalUrl: string;
}

/**
 * Event dispatch for the fanout worker.
 * Skeleton - feed entry writes (via the feed service internal API) land with
 * the feed feature ticket.
 */
export async function handleEvent(envelope: unknown, deps: HandlerDeps): Promise<void> {
  const { eventType } = envelope as { eventType: string };
  switch (eventType) {
    case EVENT_TYPES.postCreated:
    case EVENT_TYPES.interactionCreated:
      // fanout to author's followers via feed internal API
      return;
    case EVENT_TYPES.followCreated:
      // backfill followee's recent posts into the new follower's feed
      return;
    default:
      return;
  }
}
