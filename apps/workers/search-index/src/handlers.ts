import { EVENT_TYPES } from "@xitter/events";

export interface HandlerDeps {
  searchInternalUrl: string;
}

/**
 * Event dispatch for the search-index worker.
 * Skeleton - OpenSearch bulk indexing (via the search service internal API)
 * lands with the search feature ticket.
 */
export async function handleEvent(envelope: unknown, deps: HandlerDeps): Promise<void> {
  const { eventType } = envelope as { eventType: string };
  switch (eventType) {
    case EVENT_TYPES.postCreated:
    case EVENT_TYPES.postDeleted:
      return;
    default:
      return;
  }
}
