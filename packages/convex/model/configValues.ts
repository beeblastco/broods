/**
 * Shared config-object helpers for the Convex config plane (epic #85 phase 9,
 * stage 4): deep patch-merge and secret redaction, ported from core's former
 * storage/agent-config.ts so PATCH semantics and public projections stay
 * byte-identical. Pure module — safe for the default Convex runtime.
 */

import { isPlainObject } from "./objects";
import { containsEnvPlaceholder } from "./agentConfigCodec";

export const REDACTED_SECRET_VALUE = "********";

/**
 * Deep-merge a config patch into an existing config: null deletes a key,
 * a redacted placeholder keeps the existing (secret) value, arrays and
 * scalars replace, and nested objects merge recursively.
 * @param existing the stored config object
 * @param patch the caller-supplied partial config
 * @returns the merged config object
 */
export function mergeConfigObjects(existing: object, patch: object): Record<string, unknown> {
    const merged = mergeConfigValue(existing, patch);

    return isPlainObject(merged) ? merged : {};
}

/**
 * Recursively replace secret-shaped string values with the redaction
 * placeholder for public API responses.
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

function redactSecrets(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(redactSecrets);
    }
    if (!isPlainObject(value)) {
        return value;
    }

    return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
            key,
            isSecretConfigKey(key) && typeof entry === "string" && !containsEnvPlaceholder(entry)
                ? REDACTED_SECRET_VALUE
                : redactSecrets(entry),
        ]),
    );
}

function isSecretConfigKey(key: string): boolean {
    const normalized = key.toLowerCase();

    return normalized.includes("secret") ||
        normalized.includes("token") ||
        normalized.includes("privatekey") ||
        normalized.includes("private_key") ||
        normalized.includes("credential") ||
        normalized.includes("kubeconfig") ||
        normalized.includes("certificate") ||
        normalized.includes("accesskey") ||
        normalized.includes("access_key") ||
        normalized.includes("password") ||
        normalized.includes("passwd") ||
        normalized === "apikey" ||
        normalized === "api_key";
}
