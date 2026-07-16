/**
 * Workspace-config validation and public response mapping for the Convex
 * config plane (epic #85 phase 9, stage 4). Ports core's former
 * storage/workspace-config.ts normalizer so the public /v1/workspaces
 * contract is unchanged. Workspace config holds no secrets (a roleArn is not
 * a secret), so it is stored and returned in plaintext. Pure module — safe
 * for the default Convex runtime.
 */

import type { Doc } from "../_generated/dataModel";
import { mergeConfigObjects } from "./configValues";
import { isPlainObject } from "./objects";

const FILESYSTEM_NAMESPACE_PREFIX = "fs-";
const HASH_HEX_LENGTH = 40;

export const WORKSPACE_STORAGE_PROVIDERS = ["s3"] as const;
export type WorkspaceStorageProvider = (typeof WORKSPACE_STORAGE_PROVIDERS)[number];

export type WorkspaceStorageAuth =
    | { type: "managed" }
    | { type: "assumeRole"; roleArn: string; externalId?: string };

export interface WorkspaceStorageConfig {
    provider: WorkspaceStorageProvider;
    bucket?: string;
    region?: string;
    endpoint?: string;
    prefix?: string;
    auth?: WorkspaceStorageAuth;
}

export interface WorkspaceConfig {
    storage: WorkspaceStorageConfig;
    isolation?: boolean;
    harness?: { enabled?: boolean; memory?: { enabled?: boolean } };
}

/**
 * Validate and normalize a workspace config object.
 * @param value the raw config value (null/undefined yields the s3 default)
 * @returns the normalized workspace config
 * @throws when a field is malformed or the storage provider is unsupported
 */
export function normalizeWorkspaceConfig(value: unknown): WorkspaceConfig {
    if (value == null) {
        return { storage: { provider: "s3" } };
    }
    if (!isPlainObject(value)) {
        throw new Error("config must be an object");
    }

    const config = value;
    const storage = normalizeWorkspaceStorage(config.storage);
    assertOptionalBoolean(config.isolation, "config.isolation");
    const isolation = config.isolation as boolean | undefined;

    let harness: { enabled?: boolean; memory?: { enabled?: boolean } } | undefined;
    if (config.harness !== undefined) {
        if (!isPlainObject(config.harness)) {
            throw new Error("config.harness must be an object");
        }
        assertOptionalBoolean(config.harness.enabled, "config.harness.enabled");
        let memory: { enabled?: boolean } | undefined;
        if (config.harness.memory !== undefined) {
            if (!isPlainObject(config.harness.memory)) {
                throw new Error("config.harness.memory must be an object");
            }
            assertOptionalBoolean(config.harness.memory.enabled, "config.harness.memory.enabled");
            if (config.harness.memory.enabled !== undefined) {
                memory = { enabled: config.harness.memory.enabled as boolean };
            }
        }
        if (config.harness.enabled !== undefined || memory) {
            harness = {
                ...(config.harness.enabled !== undefined ? { enabled: config.harness.enabled as boolean } : {}),
                ...(memory ? { memory: memory } : {}),
            };
        }
    }

    return {
        storage: storage,
        ...(isolation === true ? { isolation: true } : {}),
        ...(harness ? { harness: harness } : {}),
    };
}

/**
 * Validate a create-workspace request body.
 * @param value the raw request body
 * @returns the normalized name/description/config
 * @throws when a field is missing or malformed
 */
export function normalizeCreateWorkspaceConfigInput(
    value: unknown,
): { name: string; description?: string; config: WorkspaceConfig } {
    if (!isPlainObject(value)) throw new Error("Request body must be an object");
    const name = requireString(value.name, "name");
    const description = optionalString(value.description, "description");
    const config = normalizeWorkspaceConfig(value.config);

    return { name: name, ...(description ? { description: description } : {}), config: config };
}

/**
 * Validate an update-workspace request body against the stored config.
 * @param existingConfig the stored workspace config (merge base)
 * @param value the raw request body
 * @returns the normalized patch with the fully merged config
 * @throws when a field is malformed
 */
export function normalizeUpdateWorkspaceConfigInput(
    existingConfig: WorkspaceConfig,
    value: unknown,
): { name?: string; description?: string | null; config: WorkspaceConfig } {
    if (!isPlainObject(value)) throw new Error("Request body must be an object");

    const config = "config" in value
        ? normalizeWorkspaceConfig(mergeConfigObjects(existingConfig, asObject(value.config)))
        : existingConfig;

    return {
        ...(value.name !== undefined ? { name: requireString(value.name, "name") } : {}),
        ...(value.description !== undefined
            ? { description: value.description === null ? null : optionalString(value.description, "description") }
            : {}),
        config: config,
    };
}

/**
 * Map a workspaceConfigs document to the public record shape core used to
 * return (workspaceId = _id, ISO timestamps, plaintext config).
 * @param doc the workspaceConfigs document
 * @returns the public workspace record
 */
export function toPublicWorkspaceConfigResponse(doc: Doc<"workspaceConfigs">): Record<string, unknown> {
    return {
        accountId: doc.accountId,
        workspaceId: doc._id,
        name: doc.name,
        ...(doc.description ? { description: doc.description } : {}),
        config: doc.config ?? { storage: { provider: "s3" } },
        createdAt: new Date(doc.createdAt).toISOString(),
        updatedAt: new Date(doc.updatedAt).toISOString(),
    };
}

/**
 * Derive a workspace's `fs-…` filesystem namespace. Matches core's
 * normalizeFilesystemNamespace byte-for-byte: S3 keys live under this prefix
 * and workspace-bound sandbox reservation keys are the namespace itself or
 * namespace-prefixed. Uses Web Crypto so it bundles for any Convex runtime.
 * @param accountId account owning the workspace
 * @param workspaceId the workspace config id
 * @returns the `fs-…` namespace prefix
 */
export async function workspaceNamespace(accountId: string, workspaceId: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`filesystem-namespace\0${accountId}:${workspaceId}`),
    );
    const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    return `${FILESYSTEM_NAMESPACE_PREFIX}${hex.slice(0, HASH_HEX_LENGTH)}`;
}

function normalizeWorkspaceStorage(value: unknown): WorkspaceStorageConfig {
    if (value === undefined) {
        return { provider: "s3" };
    }
    if (!isPlainObject(value)) {
        throw new Error("config.storage must be an object");
    }
    if (value.provider === "vercel") {
        throw new Error(
            'config.storage.provider "vercel" is not supported yet; Vercel Drive workspace storage is not wired. Use "s3" or omit config.storage.',
        );
    }
    assertOptionalEnum(value.provider, "config.storage.provider", WORKSPACE_STORAGE_PROVIDERS);

    const bucket = optionalString(value.bucket, "config.storage.bucket");
    const region = optionalString(value.region, "config.storage.region");
    const endpoint = optionalString(value.endpoint, "config.storage.endpoint");
    const prefix = optionalString(value.prefix, "config.storage.prefix");
    const auth = normalizeWorkspaceStorageAuth(value.auth);

    return {
        provider: (value.provider as WorkspaceStorageProvider | undefined) ?? "s3",
        ...(bucket ? { bucket: bucket } : {}),
        ...(region ? { region: region } : {}),
        ...(endpoint ? { endpoint: endpoint } : {}),
        ...(prefix ? { prefix: prefix } : {}),
        ...(auth ? { auth: auth } : {}),
    };
}

function normalizeWorkspaceStorageAuth(value: unknown): WorkspaceStorageAuth | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isPlainObject(value)) {
        throw new Error("config.storage.auth must be an object");
    }
    if (value.type === "managed") {
        return { type: "managed" };
    }
    if (value.type === "assumeRole") {
        const roleArn = requireString(value.roleArn, "config.storage.auth.roleArn");
        const externalId = optionalString(value.externalId, "config.storage.auth.externalId");

        return { type: "assumeRole", roleArn: roleArn, ...(externalId ? { externalId: externalId } : {}) };
    }
    throw new Error("config.storage.auth.type must be one of: managed, assumeRole");
}

function asObject(value: unknown): Record<string, unknown> {
    if (!isPlainObject(value)) throw new Error("config must be an object");

    return value;
}

function assertOptionalBoolean(value: unknown, name: string): void {
    if (value !== undefined && typeof value !== "boolean") {
        throw new Error(`${name} must be a boolean`);
    }
}

function assertOptionalEnum<T extends string>(value: unknown, name: string, allowed: readonly T[]): void {
    if (value !== undefined && (typeof value !== "string" || !allowed.includes(value as T))) {
        throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
    }
}

function requireString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`${name} must be a non-empty string`);
    }

    return value.trim();
}

function optionalString(value: unknown, name: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") throw new Error(`${name} must be a string`);
    const trimmed = value.trim();

    return trimmed.length > 0 ? trimmed : undefined;
}
