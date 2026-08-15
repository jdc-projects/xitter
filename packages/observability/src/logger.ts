import pino from "pino";

export interface LoggerOptions {
  service: string;
  /** Pretty-print logs when developing locally. */
  pretty?: boolean;
  level?: string;
}

export type Logger = ReturnType<typeof pino>;

export function createLogger(options: LoggerOptions): Logger {
  const pretty =
    options.pretty ??
    (process.env.XITTER_ENV === undefined || process.env.XITTER_ENV === "local");
  return pino({
    level: options.level ?? process.env.LOG_LEVEL ?? "info",
    base: { service: options.service, env: process.env.XITTER_ENV ?? "local" },
    ...(pretty ? { transport: { target: "pino-pretty" } } : {}),
  });
}
