import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '@xitter/events';
import { handleEvent } from './handlers.js';

describe('media-process handleEvent (skeleton)', () => {
  it('ignores non-upload events', async () => {
    await expect(
      handleEvent(
        { eventType: EVENT_TYPES.postCreated },
        { mediaInternalUrl: 'http://localhost:8103' },
      ),
    ).resolves.toBeUndefined();
  });
});
