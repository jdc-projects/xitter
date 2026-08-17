import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe.js';

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(z.object({ name: z.string().min(2) }));

  it('passes valid values through as the parsed type', () => {
    expect(pipe.transform({ name: 'demo1' })).toEqual({ name: 'demo1' });
  });

  it('rejects invalid values with the spec-03 error envelope', () => {
    try {
      pipe.transform({ name: 'x' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as BadRequestException).getResponse();
      expect(body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
      expect(JSON.stringify(body)).toContain('fieldErrors');
    }
  });
});
