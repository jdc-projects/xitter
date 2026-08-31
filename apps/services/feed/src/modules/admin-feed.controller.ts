import { Controller, Get, Inject } from '@nestjs/common';
import { Internal } from '@xitter/auth-nest';
import type { ResetStatus } from '@xitter/api-contracts';
import { RESET_STATUS, type ResetStatusReader } from './reset-status.js';

/**
 * Internal admin endpoints (spec 03 §admin): the panel's read-only window on
 * the data lifecycle. Admin-role-gated (`@Internal({ admin: true })` - the
 * panel's admin-realm user token or the svc-admin machine client; the guard
 * owns that decision). The reset job's own machine path stays on the plain
 * service-token route in internal-feed.controller.ts.
 */
@Controller('internal/admin')
export class AdminFeedController {
  constructor(@Inject(RESET_STATUS) private readonly resetStatusReader: ResetStatusReader) {}

  /**
   * Last reset/reseed run (T13) for the admin health tile. Null = no reset
   * recorded (e.g. a fresh local env) - an empty state, not an error.
   */
  @Get('reset-status')
  @Internal({ admin: true })
  resetStatus(): Promise<ResetStatus | null> {
    return this.resetStatusReader.latest();
  }
}
