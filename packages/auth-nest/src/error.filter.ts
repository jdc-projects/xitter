import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';

interface ReplyLike {
  status(code: number): { send(body: unknown): void };
}

const CODE_BY_STATUS: Record<number, string> = {
  400: 'VALIDATION_ERROR',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL',
};

export function errorCodeFor(status: number): string {
  return CODE_BY_STATUS[status] ?? 'INTERNAL';
}

/**
 * Serialises every error to the single contract shape
 * `{ error: { code, message } }` (spec 03). Guards throw exceptions that are
 * already shaped; this filter normalises everything else, including Nest's
 * built-in 404s and validation errors.
 */
@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ReplyLike>();
    if (typeof response?.status !== 'function') return;

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (isEnvelope(body)) {
        response.status(status).send(body);
        return;
      }
      const message =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] }).message ?? exception.message);
      response.status(status).send({
        error: {
          code: errorCodeFor(status),
          message: Array.isArray(message) ? message.join(', ') : String(message),
        },
      });
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      error: { code: 'INTERNAL', message: 'Internal server error' },
    });
  }
}

interface ErrorEnvelope {
  error: { code: string; message: string };
}

function isEnvelope(body: unknown): body is ErrorEnvelope {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof (body as { error?: unknown }).error === 'object' &&
    (body as { error: { code?: unknown } }).error !== null &&
    typeof (body as { error: { code?: unknown } }).error.code === 'string'
  );
}
