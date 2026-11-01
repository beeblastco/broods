import {
  ACCOUNT_ENV_REFS_ONLY_PATTERN,
  CREDENTIAL_HEADER_VALUE_PATTERN,
} from "./envRefs";
import { isPlainObject } from "./objects";
import { isSecretName } from "./secretNames";

export const REDACTED_SECRET_VALUE = "********";

export function mergeConfigObjects(
  existing: object,
  patch: object,
): Record<string, unknown> {
  const merged = mergeConfigValue(existing, patch);

  return isPlainObject(merged) ? merged : {};
}

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
    // JSON.parse makes "__proto__" an own key; assigning it would swap the prototype.
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

// Any header value but `${NAME}` refs is masked: a sync resolves refs into the stored config.
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
      // A list is masked whole, so sending it back keeps the stored one.
      const exposed = (Array.isArray(entry) ? entry : [entry]).some(
        (item): boolean =>
          typeof item === "string" && !ACCOUNT_ENV_REFS_ONLY_PATTERN.test(item),
      );

      return [key, exposed ? REDACTED_SECRET_VALUE : redactSecrets(entry)];
    }),
  );
}
