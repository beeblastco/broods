"use client";

const STORAGE_KEY = "cherry-coke.skillsBearerToken.v1";

function canUseSessionStorage(): boolean {
    return typeof window !== "undefined" && typeof window.sessionStorage !== "undefined";
}

export function getSkillsBearerToken(): string | undefined {
    if (!canUseSessionStorage()) return undefined;
    try {
        return window.sessionStorage.getItem(STORAGE_KEY) ?? undefined;
    } catch {
        return undefined;
    }
}

export function setSkillsBearerToken(token: string): void {
    if (!canUseSessionStorage()) return;
    try {
        window.sessionStorage.setItem(STORAGE_KEY, token);
    } catch {
        // ignore
    }
}

export function clearSkillsBearerToken(): void {
    if (!canUseSessionStorage()) return;
    try {
        window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
        // ignore
    }
}
