import { describe, expect, it, vi } from 'vitest';
import { Client } from '@opensearch-project/opensearch';
import { createOpenSearchClient } from './opensearch-client.js';

// Only the construction options are under test - the mock never touches a
// cluster (#195).
vi.mock('@opensearch-project/opensearch', () => ({ Client: vi.fn() }));

describe('createOpenSearchClient (#195)', () => {
  it('bounds every request with a timeout so a degraded cluster cannot wedge boot', () => {
    createOpenSearchClient('http://opensearch.local:9200');

    expect(Client).toHaveBeenCalledWith(expect.objectContaining({ requestTimeout: 5_000 }));
  });

  it('targets the configured node with the security-plugin-off ssl relaxation', () => {
    createOpenSearchClient('http://opensearch.local:9200');

    expect(Client).toHaveBeenCalledWith(
      expect.objectContaining({
        node: 'http://opensearch.local:9200',
        ssl: { rejectUnauthorized: false },
      }),
    );
  });
});
