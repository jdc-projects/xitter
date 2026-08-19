import { badRequest } from './errors.js';

/** Opaque cursor = (createdAt, id) keyset position. */
export interface PageCursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }),
  ).toString('base64url');
}

export function decodeCursor(raw: string): PageCursor | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as Partial<PageCursor>;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

/**
 * A cursor that doesn't decode to a valid keyset position must 400, not
 * silently restart at page 1 (clients would re-walk forever) or blow up as
 * a 500 in Prisma (non-date createdAt).
 */
export function assertValidCursor(cursor: string | undefined): void {
  if (!cursor) return;
  const parsed = decodeCursor(cursor);
  const createdAt = parsed ? new Date(parsed.createdAt).getTime() : Number.NaN;
  if (parsed === null || Number.isNaN(createdAt) || !parsed.id) {
    throw badRequest('Invalid pagination cursor');
  }
}
