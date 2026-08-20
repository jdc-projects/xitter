import { Body, Controller, Delete, Get, HttpCode, Post, Query } from '@nestjs/common';
import { Internal } from '@xitter/auth-nest';
import {
  refreshSearchAuthorsRequestSchema,
  searchCheckpointPutRequestSchema,
  upsertSearchDocumentsRequestSchema,
  type RefreshSearchAuthorsRequest,
  type SearchCheckpointPutRequest,
  type UpsertSearchDocumentsRequest,
} from '@xitter/api-contracts';
import { ZodValidationPipe } from '@xitter/service-kit';
import { z } from 'zod';
import { SearchService } from './search.service.js';

// Single-value param pipes take scalar schemas (object schemas would 400).
const consumerKeyQuery = new ZodValidationPipe(z.string().min(1).max(100));

/**
 * Service-to-service endpoints (spec 03 internal table): the search-index
 * worker materialises the posts index and reports checkpoints; the reset
 * job clears state. No version segment - they sit at
 * /api/search/internal/... and require a service token whose audience is
 * svc-search (global AuthGuard via `@Internal()`).
 */
@Controller('internal')
export class InternalSearchController {
  constructor(private readonly search: SearchService) {}

  /** Bulk idempotent index upsert by postId; tombstones included (spec 04). */
  @Post('search/index')
  @Internal()
  @HttpCode(200)
  upsertDocuments(
    @Body(new ZodValidationPipe(upsertSearchDocumentsRequestSchema))
    body: UpsertSearchDocumentsRequest,
  ) {
    return this.search.upsertDocuments(body.documents);
  }

  /** Refresh denormalised author names (social.profile.updated). */
  @Post('search/index/authors')
  @Internal()
  @HttpCode(200)
  refreshAuthors(
    @Body(new ZodValidationPipe(refreshSearchAuthorsRequestSchema))
    body: RefreshSearchAuthorsRequest,
  ) {
    return this.search.refreshAuthors(body.authors);
  }

  /** Clear the posts index (reset job); mapping survives for reuse. */
  @Delete('search/index')
  @Internal()
  clearIndex() {
    return this.search.clearIndex();
  }

  /** Persist the worker's last processed position (durable resume cursor). */
  @Post('search/checkpoint')
  @Internal()
  @HttpCode(204)
  putCheckpoint(
    @Body(new ZodValidationPipe(searchCheckpointPutRequestSchema))
    body: SearchCheckpointPutRequest,
  ) {
    return this.search.reportCheckpoint(body);
  }

  /** Resume positions for one consumer (worker boot). */
  @Get('search/checkpoint')
  @Internal()
  getCheckpoints(@Query('consumerKey', consumerKeyQuery) consumerKey: string) {
    return this.search.checkpointPositions(consumerKey).then((positions) => ({ positions }));
  }

  /** Truncate search service state (reset job: checkpoints are disposable). */
  @Post('reseed')
  @Internal()
  // 200 to match the documented contract (spec 03 / OpenAPI registry).
  @HttpCode(200)
  reseed() {
    return this.search.reseed().then((r) => ({ ok: true, deleted: r.deleted }));
  }
}
