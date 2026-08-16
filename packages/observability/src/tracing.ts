import { NodeSDK } from '@opentelemetry/sdk-node';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { KafkaJsInstrumentation } from '@opentelemetry/instrumentation-kafkajs';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

/**
 * Initialise tracing for a Node process. No-op unless OTEL_EXPORTER_OTLP_ENDPOINT
 * is set, so local runs without a collector stay quiet.
 * Call once at process start, before the app boots; shut down on SIGTERM.
 *
 * Fastify request spans come from the @fastify/otel plugin instead of an
 * instrumentation here - register it on each service's Fastify instance via
 * registerFastifyOtel() (it needs the running app, not just the SDK).
 */
export function initTracing(serviceName: string): { shutdown(): Promise<void> } {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    return { shutdown: async () => undefined };
  }

  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
    }),
    instrumentations: [
      new HttpInstrumentation(),
      new UndiciInstrumentation(),
      new KafkaJsInstrumentation(),
      new PgInstrumentation(),
    ],
  });

  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}

/**
 * Fastify OpenTelemetry binding for NestJS Fastify-adapter services.
 * Pass the FastifyInstance from NestFactory's adapter; no-op when tracing
 * is disabled (same env check as initTracing).
 */
export async function registerFastifyOtel(app: {
  register: (plugin: unknown, opts?: unknown) => Promise<unknown>;
}): Promise<void> {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
  const { FastifyOtelInstrumentation } = await import('@fastify/otel');
  await app.register(new FastifyOtelInstrumentation());
}
