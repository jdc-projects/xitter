import { join } from "node:path";
import { findRepoRoot, loadRepoEnv } from "@xitter/config";
import { run, capture } from "./lib/exec.js";

const COMPOSE_FILE = join(findRepoRoot(), "infra", "docker", "compose.yaml");

/** Compose project name isolates every environment copy (containers, volumes, networks). */
export function composeProject(): string {
  return `xitter-${process.env.XITTER_ENV ?? "local"}`;
}

function composeArgs(): string[] {
  return ["compose", "--file", COMPOSE_FILE, "--project-name", composeProject()];
}

export async function up(detach = true): Promise<void> {
  loadRepoEnv();
  await run("docker", [...composeArgs(), "up", "--wait", ...(detach ? ["--detach"] : [])]);
}

export async function down(volumes = false): Promise<void> {
  loadRepoEnv();
  await run("docker", [...composeArgs(), "down", ...(volumes ? ["--volumes"] : [])]);
}

export async function status(): Promise<void> {
  loadRepoEnv();
  await run("docker", [...composeArgs(), "ps"]);
}

export async function isRunning(): Promise<boolean> {
  loadRepoEnv();
  const out = await capture("docker", [...composeArgs(), "ps", "--services", "--filter", "status=running"]);
  return out.length > 0;
}
