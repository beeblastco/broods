/**
 * Account management HTTP API.
 * Keep account CRUD orchestration here and shared account storage in _shared.
 */

import type { LambdaFunctionURLEvent } from "aws-lambda";
import {
    createAccount,
    deleteAccount,
    getAccount,
    listAccounts,
    resolveBearerAuth,
    rotateAccountSecret,
    toPublicAccount,
    updateAccount,
    type AuthContext,
} from "../_shared/accounts.ts";
import type { LambdaResponse } from "../_shared/runtime.ts";
import { enforceAccountSignupRateLimit, RateLimitExceededError } from "./rate-limit.ts";

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaResponse> {
    const method = event.requestContext.http.method;
    const rawPath = normalizePath(event.rawPath);
    const headers = normalizeHeaders(event.headers);

    try {
        if (method === "GET" && rawPath === "/") {
            return jsonResponse(200, { status: "ok" });
        }

        if (method === "POST" && rawPath === "/accounts") {
            await enforceAccountSignupRateLimit(event);
            const body = parseJsonBody(event);
            const created = await createAccount(body as never);
            return jsonResponse(201, {
                account: toPublicAccount(created.account),
                accountSecret: created.accountSecret,
            });
        }

        const auth = await resolveBearerAuth(headers);
        if (!auth) {
            return textResponse(401, "Unauthorized");
        }

        if (method === "GET" && rawPath === "/accounts/me") {
            const account = requireAccountAuth(auth);
            return jsonResponse(200, { account: toPublicAccount(account) });
        }

        if (method === "PATCH" && rawPath === "/accounts/me") {
            const account = requireAccountAuth(auth);
            return updateAccountResponse(account.accountId, parseAccountPatch(event));
        }

        if (method === "POST" && rawPath === "/accounts/me/rotate-secret") {
            const account = requireAccountAuth(auth);
            return rotateSecretResponse(account.accountId);
        }

        if (method === "DELETE" && rawPath === "/accounts/me") {
            const account = requireAccountAuth(auth);
            await deleteAccount(account.accountId);
            return jsonResponse(200, { deleted: true });
        }

        if (auth.kind !== "admin") {
            return textResponse(403, "Forbidden");
        }

        if (method === "GET" && rawPath === "/accounts") {
            const accounts = await listAccounts();
            return jsonResponse(200, { accounts: accounts.map(toPublicAccount) });
        }

        const accountMatch = rawPath.match(/^\/accounts\/([^/]+)$/);
        if (accountMatch?.[1]) {
            const accountId = decodeURIComponent(accountMatch[1]);
            if (method === "GET") {
                const account = await getAccount(accountId);
                return account
                    ? jsonResponse(200, { account: toPublicAccount(account) })
                    : textResponse(404, "Account not found");
            }

            if (method === "PATCH") {
                return updateAccountResponse(accountId, parseAccountPatch(event));
            }

            if (method === "DELETE") {
                const account = await getAccount(accountId);
                if (!account) {
                    return textResponse(404, "Account not found");
                }
                await deleteAccount(accountId);
                return jsonResponse(200, { deleted: true });
            }
        }

        const rotateMatch = rawPath.match(/^\/accounts\/([^/]+)\/rotate-secret$/);
        if (method === "POST" && rotateMatch?.[1]) {
            return rotateSecretResponse(decodeURIComponent(rotateMatch[1]));
        }

        return textResponse(404, "Not found");
    } catch (err) {
        if (err instanceof RateLimitExceededError) {
            return {
                statusCode: 429,
                headers: {
                    "Content-Type": "text/plain; charset=utf-8",
                    "Retry-After": String(err.retryAfterSeconds),
                },
                body: "Rate limit exceeded",
            };
        }
        return textResponse(400, err instanceof Error ? err.message : "Invalid request");
    }
}

async function updateAccountResponse(accountId: string, input: unknown): Promise<LambdaResponse> {
    const account = await updateAccount(accountId, input as never);
    return account
        ? jsonResponse(200, { account: toPublicAccount(account) })
        : textResponse(404, "Account not found");
}

async function rotateSecretResponse(accountId: string): Promise<LambdaResponse> {
    const rotated = await rotateAccountSecret(accountId);
    return rotated
        ? jsonResponse(200, {
            account: toPublicAccount(rotated.account),
            accountSecret: rotated.accountSecret,
        })
        : textResponse(404, "Account not found");
}

function requireAccountAuth(auth: AuthContext): Extract<AuthContext, { kind: "account" }>["account"] {
    if (auth.kind !== "account") {
        throw new Error("Admin must use account-specific endpoints");
    }

    return auth.account;
}

function parseAccountPatch(event: LambdaFunctionURLEvent): unknown {
    const body = parseJsonBody(event);
    if (!isRecord(body)) {
        return body;
    }

    if ("username" in body || "description" in body || "config" in body) {
        return body;
    }

    return { config: body };
}

function parseJsonBody(event: LambdaFunctionURLEvent): unknown {
    const body = decodeBody(event.body, event.isBase64Encoded);
    if (!body.trim()) {
        return {};
    }

    try {
        return JSON.parse(body);
    } catch (err) {
        throw new Error(`Invalid request JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
}

function normalizeHeaders(headers: Record<string, string | undefined>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        if (typeof value === "string") {
            normalized[key.toLowerCase()] = value;
        }
    }
    return normalized;
}

function normalizePath(rawPath: string): string {
    return rawPath.length > 1 ? rawPath.replace(/\/+$/, "") : rawPath;
}

function decodeBody(body: string | undefined, isBase64Encoded?: boolean): string {
    const raw = body ?? "";
    return isBase64Encoded ? Buffer.from(raw, "base64").toString("utf-8") : raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function jsonResponse(statusCode: number, body: unknown): LambdaResponse {
    return {
        statusCode,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    };
}

function textResponse(statusCode: number, body: string): LambdaResponse {
    return {
        statusCode,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body,
    };
}
