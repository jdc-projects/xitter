import {
  type ArgumentsHost,
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ErrorEnvelopeFilter } from './error.filter.js';

function run(exception: unknown): { status: number; body: unknown } {
  const sent: { status: number; body: unknown } = { status: 0, body: undefined };
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({
        status(code: number) {
          sent.status = code;
          return { send: (body: unknown) => void (sent.body = body) };
        },
      }),
    }),
  } as unknown as ArgumentsHost;
  new ErrorEnvelopeFilter().catch(exception, host);
  return sent;
}

describe('ErrorEnvelopeFilter', () => {
  it('passes through already-shaped envelopes untouched', () => {
    const exception = new HttpException(
      { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
      429,
    );
    expect(run(exception)).toEqual({
      status: 429,
      body: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
    });
  });

  it('maps Nest built-in exceptions to contract codes', () => {
    expect(run(new NotFoundException())).toEqual({
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Not Found' } },
    });
    expect(run(new BadRequestException(['text is required', 'text too long']))).toEqual({
      status: 400,
      body: { error: { code: 'VALIDATION_ERROR', message: 'text is required, text too long' } },
    });
  });

  it('collapses unknown errors to a 500 INTERNAL envelope without leaking details', () => {
    expect(run(new Error('password=hunter2 at /etc/shadow'))).toEqual({
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'Internal server error' } },
    });
  });
});
