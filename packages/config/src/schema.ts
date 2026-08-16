import type { z } from 'zod';

/**
 * Parse and validate process.env against a zod schema.
 * Throws with a readable error listing every problem - fail fast at boot.
 * Generic over Output/Input so schemas using `.default()` (whose input type
 * differs from output) type-check correctly.
 */
export function parseEnv<T extends z.ZodType<unknown, unknown>>(
  schema: T,
  source: NodeJS.ProcessEnv = process.env,
): z.output<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  return result.data;
}

/** Typed accessor for optional-with-default string env values. */
export function envString(key: string, fallback?: string): string {
  const value = process.env[key];
  if (value === undefined || value === '') {
    if (fallback === undefined) throw new Error(`Missing required env var: ${key}`);
    return fallback;
  }
  return value;
}

export function envInt(key: string, fallback: number): number {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`Env var ${key} is not an integer: ${value}`);
  return parsed;
}

export function envBool(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
