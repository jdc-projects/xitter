import { OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { API_VERSION } from "./version.js";

export interface ServiceApiSpec {
  service: string;
  title: string;
  description: string;
  /** Base path without version, e.g. "/api/social" - the version segment is appended. */
  basePath: string;
  tags?: { name: string; description?: string }[];
}

/**
 * Assemble a self-contained OpenAPI v3 document for one service from its registry.
 * Each service exposes an `openapi:gen` script that writes `openapi.json` next to it.
 */
export function buildServiceDocument(
  spec: ServiceApiSpec,
  registry: OpenAPIRegistry,
): Record<string, unknown> {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: spec.title,
      description: spec.description,
      version: API_VERSION,
    },
    servers: [{ url: `${spec.basePath}/${API_VERSION}` }],
    tags: spec.tags,
  }) as Record<string, unknown>;
}
