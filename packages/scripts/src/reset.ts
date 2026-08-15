#!/usr/bin/env tsx
/**
 * Reset the local environment back to a clean state:
 * `tsx packages/scripts/src/reset.ts [--seed]`
 *
 * Destroys all dependency volumes (postgres, kafka, rustfs, opensearch, keycloak),
 * restarts them, and re-bootstraps. With --seed, refills with deterministic data.
 * This is the local twin of the nightly deployed reset - see
 * docs/specs/operations/02-data-reset.md.
 */
import { down, up } from "./lib/compose.js";

console.log("tearing down (removing volumes)...");
await down(true);

console.log("starting dependencies...");
await up();

await runBootstrap();

async function runBootstrap(): Promise<void> {
  const { run } = await import("./lib/exec.js");
  const args = ["packages/scripts/src/bootstrap.ts"];
  if (process.argv.includes("--seed")) args.push("--seed");
  await run("tsx", args);
}

console.log("reset complete");
