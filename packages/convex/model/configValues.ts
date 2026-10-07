/**
 * Shared config-object helpers for the Convex config plane: deep patch-merge
 * and secret redaction, ported from core's former
 * storage/agent-config.ts so PATCH semantics and public projections stay
 * byte-identical. Pure module, safe for the default Convex runtime.
 */

import {
  ACCOUNT_ENV_REFS_ONLY_PATTERN,
  CREDENTIAL_HEADER_VALUE_PATTERN,
} from "./envRefs";
import { isPlainObject } from "./objects";
import { isSecretName } from "./secretNames";

export const REDACTED_SECRET_VALUE = "********";

/**
 * Deep-merge a config patch into an existing config: null deletes a key,
 * a redacted placeholder keeps the existing (secret) value, arrays and
 * scalars replace, and nested objects merge recursively.
 * @param existing the stored config object
 * @param patch the caller-supplied partial config
 * @returns the merged config object
 */
export function mergeConfigObjects(
  existing: object,
  patch: object,
): Record<string, unknown> {
  const merged = mergeConfigValue(existing, patch);

  return isPlainObject(merged) ? merged : {};
}

/**
 * Recursively replace secret values, found by name or inside a `headers`
 * map, with the redaction placeholder for public API responses.
 * @param value the config value to project
 * @returns the value with secrets masked
 */
export function redactConfigSecrets<T>(value: T): T {
  return redactSecrets(value) as T;
}

function mergeConfigValue(existing: unknown, patch: unknown): unknown {
  if (patch === undefined) {
    return existing;
  }
  if (patch === REDACTED_SECRET_VALUE) {
    return existing;
  }
  if (patch === null) {
    return undefined;
  }
  if (Array.isArray(patch) || !isPlainObject(patch)) {
    return patch;
  }

  const existingObject = isPlainObject(existing) ? existing : {};
  const merged = { ...existingObject };
  for (const [key, value] of Object.entries(patch)) {
    // JSON.parse creates "__proto__" as an own key; assigning it below
    // would rewrite the merged object's prototype instead of a property.
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      continue;
    }
    const mergedValue = mergeConfigValue(existingObject[key], value);
    if (mergedValue === undefined) {
      delete merged[key];
    } else {
      merged[key] = mergedValue;
    }
  }

  return merged;
}

// Inside a `headers` map any value but `${NAME}` refs, after an optional auth
// scheme word, is masked: a sync resolves refs into the stored config whatever
// the header is called.
function redactSecrets(value: unknown, inHeaders = false): unknown {
  if (Array.isArray(value)) {
    return value.map((entry): unknown => redactSecrets(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]): [string, unknown] => {
      if (inHeaders) {
        return [
          key,
          typeof entry === "string" &&
          !CREDENTIAL_HEADER_VALUE_PATTERN.test(entry)
            ? REDACTED_SECRET_VALUE
            : entry,
        ];
      }
      if (!isSecretName(key)) {
        return [key, redactSecrets(entry, key === "headers")];
      }
      // Under a secret name only refs show. A list is masked whole, so
      // sending it back keeps the stored one.
      const exposed = (Array.isArray(entry) ? entry : [entry]).some(
        (item): boolean =>
          typeof item === "string" && !ACCOUNT_ENV_REFS_ONLY_PATTERN.test(item),
      );

      return [key, exposed ? REDACTED_SECRET_VALUE : redactSecrets(entry)];
    }),
  );
}
