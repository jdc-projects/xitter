import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Parses params/query/bodies with the contract schema. Failures surface as
 * the spec-03 error envelope (VALIDATION_ERROR + field-level details), which
 * ErrorEnvelopeFilter passes through untouched.
 */
export class ZodValidationPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: result.error.flatten(),
        },
      });
    }
    return result.data;
  }
}
