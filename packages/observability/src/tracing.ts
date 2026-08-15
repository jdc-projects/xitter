import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  FastifyInstrumentation,
} from "@opentelemetry/instrumentation-fastify";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { KafkaJsInstrumentation } from "@opentelemetry/instrumentation-kafkajs";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

/**
 * Initialise tracing for a Node process. No-op unless OTEL_EXPORTER_OTLP_ENDPOINT
 * is set, so local runs without a collector stay quiet.
 * Call once at process start, before the app boots; shut down on SIGTERM.
 */
export function initTracing(serviceName: string): { shutdown(): Promise<void> } {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) {
    return { shutdown: async () => undefined };
  }

  const sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({ url: `${endpoint.replace(/\/$/, "")}/v1/traces` }),
    instrumentations: [
      new HttpInstrumentation(),
      new FastifyInstrumentation(),
      new UndiciInstrumentation(),
      new KafkaJsInstrumentation(),
      new PgInstrumentation(),
    ],
  });

  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
