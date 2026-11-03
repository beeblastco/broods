// Kept apart from inputSchema: the dashboard's first load bundles this, not every schema.
import { z } from "zod/mini";

export const configObject = z.record(z.string(), z.unknown());

export const stringValues = z.record(z.string(), z.string());

// A lenient read of stored JSON: the parsed value, or `fallback` when it does not fit.
export function parseOr<T>(
  schema: z.core.$ZodType<T>,
  value: unknown,
  fallback: NoInfer<T>,
): T;
export function parseOr<T>(
  schema: z.core.$ZodType<T>,
  value: unknown,
): T | undefined;
export function parseOr<T>(
  schema: z.core.$ZodType<T>,
  value: unknown,
  fallback?: T,
): T | undefined {
  const result = z.safeParse(schema, value);

  return result.success ? result.data : fallback;
}
