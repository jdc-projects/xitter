/** Single source of truth for local port defaults. Offset by XITTER_PORT_OFFSET for parallel envs. */
export const PORT_DEFAULTS = {
  edge: 8080,
  web: 3000,
  cms: 3001,
  admin: 3002,
  social: 8101,
  posts: 8102,
  media: 8103,
  feed: 8104,
  search: 8105,
  postgres: 5532,
  kafka: 9092,
  opensearch: 9200,
  rustfs: 9000,
  rustfsConsole: 9001,
  valkey: 6379,
  keycloak: 8090,
} as const;

export type PortName = keyof typeof PORT_DEFAULTS;

export function portOffset(): number {
  const raw = process.env.XITTER_PORT_OFFSET ?? "0";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Resolve a local port: env override `XITTER_<NAME>_PORT` wins, else default + offset. */
export function localPort(name: PortName): number {
  const envKey = `XITTER_${name.replace(/([A-Z])/g, "_$1").toUpperCase()}_PORT`;
  const override = process.env[envKey];
  if (override) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return PORT_DEFAULTS[name] + portOffset();
}

/** Local service/dependency hosts (docker on host network via forwarded ports). */
export function localUrl(name: PortName): string {
  return `http://localhost:${localPort(name)}`;
}
