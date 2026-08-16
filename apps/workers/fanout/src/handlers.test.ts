import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '@xitter/events';
import { handleEvent } from './handlers.js';

describe('fanout handleEvent (skeleton)', () => {
  it('accepts known event types without throwing', async () => {
    await expect(
      handleEvent(
        { eventType: EVENT_TYPES.postCreated },
        { feedInternalUrl: 'http://localhost:8104' },
      ),
    ).resolves.toBeUndefined();
  });

  it('ignores unknown event types', async () => {
    await expect(
      handleEvent(
        { eventType: 'nothing.interesting' },
        { feedInternalUrl: 'http://localhost:8104' },
      ),
    ).resolves.toBeUndefined();
  });
});
