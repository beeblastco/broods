"use client";

type StoredDeploymentCredential = {
    endpointId: string;
    apiKey: string;
    projectSlug?: string;
    environmentSlug?: string;
    savedAt: number;
};

const STORAGE_KEY = "cherry-coke.deploymentCredentials.v1";
const LEGACY_STORAGE_KEY = "clonee.deploymentCredentials.v1";

function canUseSessionStorage(): boolean {
    return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

function readCredentialStore(): Record<string, StoredDeploymentCredential> {
    if (!canUseSessionStorage()) {
        return {};
    }

    try {
        window.sessionStorage.removeItem(LEGACY_STORAGE_KEY);
        const raw = window.sessionStorage.getItem(STORAGE_KEY);
        if (!raw) {
            return {};
        }

        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return {};
        }

        return parsed as Record<string, StoredDeploymentCredential>;
    } catch {
        return {};
    }
}

function writeCredentialStore(store: Record<string, StoredDeploymentCredential>) {
    if (!canUseSessionStorage()) {
        return;
    }

    try {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
        // Ignore storage failures and keep the UI usable.
    }
}

export function rememberDeploymentCredential({
    endpointId,
    apiKey,
    projectSlug,
    environmentSlug,
}: {
    endpointId: string;
    apiKey: string;
    projectSlug?: string;
    environmentSlug?: string;
}) {
    const store = readCredentialStore();
    store[endpointId] = {
        endpointId: endpointId,
        apiKey: apiKey,
        projectSlug: projectSlug,
        environmentSlug: environmentSlug,
        savedAt: Date.now(),
    };
    writeCredentialStore(store);
}

export function getRememberedDeploymentApiKey(
    endpointId: string | undefined,
    fallbackApiKey?: string,
): string | undefined {
    if (typeof fallbackApiKey === "string" && fallbackApiKey.length > 0) {
        return fallbackApiKey;
    }
    if (!endpointId) {
        return undefined;
    }

    return readCredentialStore()[endpointId]?.apiKey;
}

export function forgetDeploymentCredential(endpointId: string | undefined) {
    if (!endpointId) {
        return;
    }

    const store = readCredentialStore();
    delete store[endpointId];
    writeCredentialStore(store);
}
