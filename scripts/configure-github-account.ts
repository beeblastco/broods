/**
 * CI configuration helper for the default GitHub account.
 * Creates or updates account config for GitHub App integration.
 */

import {
    accountManageUrl,
    createScriptAccountRuntimeConfig,
    harnessProcessingUrl,
    requireScriptEnv,
    upsertScriptAccount,
} from "./utils.ts";

const accountManageUrlValue = accountManageUrl();
const harnessProcessingUrlValue = harnessProcessingUrl();
const adminSecret = requireScriptEnv("ADMIN_ACCOUNT_SECRET");
const githubAppId = requireScriptEnv("GITHUB_APP_ID");
const githubPrivateKey = requireScriptEnv("GITHUB_PRIVATE_KEY");
const githubWebhookSecret = requireScriptEnv("GITHUB_WEBHOOK_SECRET");
const allowedRepos = parseAllowedRepos(requireScriptEnv("GITHUB_ALLOWED_REPOS"));
const username = process.env.GITHUB_ACCOUNT_USERNAME?.trim();
const description = process.env.GITHUB_ACCOUNT_DESCRIPTION?.trim();

const account = await upsertGitHubAccount();
const webhookUrl = `${harnessProcessingUrlValue}/webhooks/${encodeURIComponent(account.accountId)}/github`;

console.log(`Configured GitHub account ${account.accountId}`);
console.log(`Register this webhook URL in your GitHub App: ${webhookUrl}`);

async function upsertGitHubAccount() {
    const config = {
        ...createScriptAccountRuntimeConfig(),
        channels: {
            github: {
                appId: githubAppId,
                privateKey: githubPrivateKey,
                webhookSecret: githubWebhookSecret,
                allowedRepos,
            },
        },
    };

    return upsertScriptAccount({
        accountManageUrl: accountManageUrlValue,
        adminSecret,
        username,
        description,
        config,
    });
}

function parseAllowedRepos(raw: string): string[] {
    const repos = raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    if (repos.length === 0) {
        throw new Error("GITHUB_ALLOWED_REPOS must contain at least one repository in owner/repo format");
    }

    return repos;
}
