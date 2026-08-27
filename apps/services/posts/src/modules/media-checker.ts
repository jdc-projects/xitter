import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { MediaClient } from '@xitter/api-client';
import type { MediaAsset } from '@xitter/api-contracts';
import { createLogger } from '@xitter/observability';

const logger = createLogger({ service: 'posts' });

/** Attach-validation seam: the service depends on this port, not MediaClient. */
export interface MediaChecker {
  /**
   * Assets among mediaIds that exist AND are owned by ownerId. Optional
   * altTexts (#133) persist onto the owned assets in the same call.
   */
  resolveForAttach(
    ownerId: string,
    mediaIds: string[],
    altTexts?: Record<string, string>,
  ): Promise<MediaAsset[]>;
}

/** Injection token (string token so test doubles are easy to provide). */
export const MEDIA_CHECKER = 'MEDIA_CHECKER';

/**
 * Inert checker for tests: every requested id resolves as a ready asset with
 * placeholder variants (shape only - nothing reads variant URLs in tests).
 * altTexts (#133) are echoed back so snapshots/reads behave like production.
 */
export class NullMediaChecker implements MediaChecker {
  resolveForAttach(
    _ownerId: string,
    mediaIds: string[],
    altTexts: Record<string, string> = {},
  ): Promise<MediaAsset[]> {
    return Promise.resolve(
      mediaIds.map((id) => ({
        id,
        ownerId: _ownerId,
        status: 'ready' as const,
        variants: [],
        ...(altTexts[id] ? { altText: altTexts[id] } : {}),
        createdAt: '2026-08-18T00:00:00.000Z',
      })),
    );
  }
}

/**
 * Media-backed attach validation via the internal lookup endpoint (spec 03),
 * authenticated with this service's client-credentials token (audience
 * svc-media). Fails CLOSED: when media cannot answer, posts with images are
 * rejected - availability yields to "only ready, owned images attach".
 */
@Injectable()
export class MediaServiceChecker implements MediaChecker {
  private readonly media: MediaClient;

  constructor(options: {
    baseUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    fetchImpl?: typeof fetch;
  }) {
    this.media = new MediaClient({
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
      internal: {
        tokenUrl: options.tokenUrl,
        clientId: options.clientId,
        clientSecret: options.clientSecret,
      },
    });
  }

  async resolveForAttach(
    ownerId: string,
    mediaIds: string[],
    altTexts: Record<string, string> = {},
  ): Promise<MediaAsset[]> {
    try {
      const { items } = await this.media.internalLookup(ownerId, mediaIds, altTexts);
      return items;
    } catch (err) {
      logger.error({ err }, 'media attach lookup failed');
      throw new ServiceUnavailableException({
        error: {
          code: 'INTERNAL',
          message: 'Cannot verify attached images right now - try again shortly',
        },
      });
    }
  }
}
