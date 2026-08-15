/**
 * Boots the search service: tracing, Sentry, Fastify/Nest app, graceful shutdown.
 * Env: see .env.example - all endpoints/ports are env-driven.
 */
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module.js";
import { localPort, parseEnv } from "@xitter/config";
import { z } from "zod";
import { initSentry, initTracing } from "@xitter/observability";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(localPort("search")),
  KEYCLOAK_BASE_URL: z.string().url(),
  DEMO_REALM: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  KAFKA_BROKERS: z.string().min(1),
});

const env = parseEnv(envSchema);
const tracing = initTracing("search");
initSentry("search");

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: true }));

  app.setGlobalPrefix("api/search/v1");
  app.enableShutdownHooks();

  await app.listen(env.PORT, "0.0.0.0");
  console.log(`search listening on :${env.PORT}`);
}

bootstrap()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    process.once("SIGTERM", () => void tracing.shutdown());
  });
