import type { DataProvider } from '@refinedev/core';

/**
 * Data provider backed by the backend services' internal admin endpoints.
 * Skeleton - real CRUD wiring lands with the admin feature ticket.
 */
export const dataProvider: DataProvider = {
  getList: async () => ({ data: [], total: 0 }),
  getOne: async () => {
    throw new Error('Not implemented yet - see admin feature ticket');
  },
  create: async () => {
    throw new Error('Not implemented yet - see admin feature ticket');
  },
  update: async () => {
    throw new Error('Not implemented yet - see admin feature ticket');
  },
  deleteOne: async () => {
    throw new Error('Not implemented yet - see admin feature ticket');
  },
  getApiUrl: () => '/api',
};
