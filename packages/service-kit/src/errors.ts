import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';

/**
 * Spec-03 error-envelope builders: every service failure the API contract
 * names gets one helper so the `{error: {code, message}}` shape and status
 * stay aligned across services. ErrorEnvelopeFilter passes these through.
 */

export const notFound = (message: string) =>
  new NotFoundException({ error: { code: 'NOT_FOUND', message } });

export const forbidden = (message: string) =>
  new ForbiddenException({ error: { code: 'FORBIDDEN', message } });

export const badRequest = (message: string, details?: object) =>
  new BadRequestException({
    error: { code: 'VALIDATION_ERROR', message, ...(details ? { details } : {}) },
  });

export const payloadTooLarge = (message: string) =>
  new PayloadTooLargeException({ error: { code: 'PAYLOAD_TOO_LARGE', message } });

export const unsupportedMediaType = (message: string) =>
  new UnsupportedMediaTypeException({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message } });
