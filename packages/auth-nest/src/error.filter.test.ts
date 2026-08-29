import {
  type ArgumentsHost,
  BadRequestException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ErrorEnvelopeFilter } from './error.filter.js';

// vi.mock hoists above imports - the mock fn must come from vi.hoisted.
const { pinoMock } = vi.hoisted(() => ({ pinoMock: vi.fn() }));
vi.mock('@xitter/observability', () => ({
  createLogger: () => ({ error: pinoMock }),
}));

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
    pinoMock.mockClear();
    expect(run(new Error('password=hunter2 at /etc/shadow'))).toEqual({
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'Internal server error' } },
    });
  });

  it('LOGS the exception before sending the INTERNAL envelope (#182)', () => {
    pinoMock.mockClear();
    const boom = new Error('pipe got a schema');
    run(boom);
    expect(pinoMock).toHaveBeenCalledTimes(1);
    // The err object rides the pino context; the message names the collapse.
    const [context, message] = pinoMock.mock.calls[0]!;
    expect((context as { err?: unknown }).err).toBe(boom);
    expect(String(message)).toContain('INTERNAL');
  });
});
