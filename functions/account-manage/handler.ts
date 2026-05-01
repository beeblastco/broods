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
import { deleteAccountRuntimeData } from "../_shared/account-cleanup.ts";
import {
    errorResponse,
    jsonResponse,
    normalizeHeaders,
    normalizePath,
    parseJsonBody,
} from "../_shared/http.ts";
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
            return errorResponse(401, "Unauthorized");
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
            return deleteAccountResponse(account);
        }

        if (auth.kind !== "admin") {
            return errorResponse(403, "Forbidden");
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
                    : errorResponse(404, "Account not found");
            }

            if (method === "PATCH") {
                return updateAccountResponse(accountId, parseAccountPatch(event));
            }

            if (method === "DELETE") {
                const account = await getAccount(accountId);
                if (!account) {
                    return errorResponse(404, "Account not found");
                }
                return deleteAccountResponse(account);
            }
        }

        const rotateMatch = rawPath.match(/^\/accounts\/([^/]+)\/rotate-secret$/);
        if (method === "POST" && rotateMatch?.[1]) {
            return rotateSecretResponse(decodeURIComponent(rotateMatch[1]));
        }

        return errorResponse(404, "Not found");
    } catch (err) {
        if (err instanceof RateLimitExceededError) {
            return errorResponse(429, "Rate limit exceeded", {}, {
                "Retry-After": String(err.retryAfterSeconds),
            });
        }
        return errorResponse(400, err instanceof Error ? err.message : "Invalid request");
    }
}

async function updateAccountResponse(accountId: string, input: unknown): Promise<LambdaResponse> {
    const account = await updateAccount(accountId, input as never);
    return account
        ? jsonResponse(200, { account: toPublicAccount(account) })
        : errorResponse(404, "Account not found");
}

async function rotateSecretResponse(accountId: string): Promise<LambdaResponse> {
    const rotated = await rotateAccountSecret(accountId);
    return rotated
        ? jsonResponse(200, {
            account: toPublicAccount(rotated.account),
            accountSecret: rotated.accountSecret,
        })
        : errorResponse(404, "Account not found");
}

async function deleteAccountResponse(account: Extract<AuthContext, { kind: "account" }>["account"]): Promise<LambdaResponse> {
    const cleanup = await deleteAccountRuntimeData(account);
    await deleteAccount(account.accountId);
    return jsonResponse(200, { deleted: true, cleanup });
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
