import {
  ACCOUNT_ENV_REFS_ONLY_PATTERN,
  CREDENTIAL_HEADER_VALUE_PATTERN,
} from "./envRefs";
import { configObject, parseOr } from "./storedJson";
import { isSecretName } from "./secretNames";

export const REDACTED_SECRET_VALUE = "********";

export function mergeConfigObjects(
  existing: object,
  patch: object,
): Record<string, unknown> {
  return parseOr(configObject, mergeConfigValue(existing, patch), {});
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
  const patchObject = parseOr(configObject, patch);
  if (!patchObject) {
    return patch;
  }

  const existingObject = parseOr(configObject, existing, {});
  const merged = { ...existingObject };
  for (const [key, value] of Object.entries(patchObject)) {
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
  const object = parseOr(configObject, value);
  if (!object) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(object).map(([key, entry]): [string, unknown] => {
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
