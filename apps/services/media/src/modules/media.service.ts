import { Injectable } from '@nestjs/common';

/**
 * Image uploads and RustFS-backed storage.
 * Skeleton - pre-signed URLs, variant processing events, and object storage
 * land with the media feature ticket.
 */
@Injectable()
export class MediaService {
  getMedia(mediaId: string): { id: string; status: string } {
    return { id: mediaId, status: 'pending' };
  }

  placeholder(): { ok: boolean } {
    return { ok: true };
  }
}
