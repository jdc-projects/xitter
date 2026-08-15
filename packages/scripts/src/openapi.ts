#!/usr/bin/env tsx
/**
 * Collect per-service openapi.json artifacts (produced by each service's
 * `openapi:gen` turbo task) into docs/specs/architecture/openapi/ so the specs
 * stay self-contained and current.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "@xitter/config";

const root = findRepoRoot();
const servicesDir = join(root, "apps", "services");
const outDir = join(root, "docs", "specs", "architecture", "openapi");

mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const service of readdirSync(servicesDir, { withFileTypes: true })) {
  if (!service.isDirectory()) continue;
  const source = join(servicesDir, service.name, "openapi.json");
  if (!existsSync(source)) continue;
  copyFileSync(source, join(outDir, `${service.name}.json`));
  console.log(`openapi: ${service.name}`);
  copied++;
}

if (copied === 0) {
  console.log("no openapi.json artifacts found - run `npm run openapi:gen`");
}
