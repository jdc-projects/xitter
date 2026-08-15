import { EVENT_TYPES } from '@xitter/events';

export interface HandlerDeps {
  mediaInternalUrl: string;
}

/**
 * Event dispatch for the media-process worker.
 * Skeleton - sharp transforms and variant reporting (via the media service
 * internal API) land with the media feature ticket.
 */
export async function handleEvent(envelope: unknown, _deps: HandlerDeps): Promise<void> {
  const { eventType } = envelope as { eventType: string };
  if (eventType !== EVENT_TYPES.mediaUploaded) return;
  // fetch original from RustFS, derive variants with sharp, POST results to
  // the media service internal API, then mark the asset ready.
}
