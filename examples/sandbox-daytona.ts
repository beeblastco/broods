/**
 * Example Daytona workspace sandbox execution.
 */

import { createAccount, createAgent, deleteAccount, streamSSE, requireEnv } from "./utils.ts";

const minimaxApiKey = requireEnv("ACCOUNT_MINIMAX_API_KEY");
const daytonaApiKey = requireEnv("DAYTONA_API_KEY");
const daytonaOrganizationId = process.env.DAYTONA_ORGANIZATION_ID!;
const username = `sandbox-${Date.now()}`;

const account = await createAccount(username);
const agent = await createAgent(account.secret, "Sandbox assistant", {
    provider: {
        minimax: {
            apiKey: minimaxApiKey,
        },
    },
    model: {
        provider: "minimax",
        modelId: "MiniMax-M2.7",
    },
    agent: {
        system: [
            "You are testing the workspace sandbox.",
            "The sandbox uses a native mounted workspace filesystem.",
            "Use the bash tool to write source files and data files first, then execute only file-based scripts. Node inline flags such as `node -e` are not supported.",
            "Sandboxed code should use normal relative file APIs from the workspace root.",
            "Do not use inline execution such as node -e or python -c.",
            "After running files, summarize stdout, generated files, and status for each run.",
        ].join("\n"),
    },
    workspace: {
        enabled: true,
        needsApproval: false,
        storage: {
            provider: "s3",
        },
        sandbox: {
            provider: "daytona",
            outputLimitBytes: 65536,
            options: {
                apiKey: daytonaApiKey,
                organizationId: daytonaOrganizationId,
                apiUrl: "https://app.daytona.io/api",
                target: "eu",
                snapshot: "fuse-s3",
                workspaceRoot: "/mnt/workspaces",
                mountAwsS3Buckets: true,
                networkBlockAll: false,
                networkAllowList: "0.0.0.0/0",
            },
        },
    },
});

console.log("Created test account:", JSON.stringify(account));
console.log("Created test agent:", JSON.stringify(agent));

try {
    const body = {
        agentId: agent.agentId,
        eventId: `sandbox-${Date.now()}`,
        conversationKey: `sandbox-${Date.now()}`,
        events: [
            {
                role: "user",
                content: [{
                    type: "text",
                    text: "Call outside API and check for me the weather in San Francisco, CA.",
                }],
            },
        ],
    };

    for await (const chunk of streamSSE(body, account.secret)) {
        process.stdout.write(`${chunk}\n\n`);
    }
} finally {
    await deleteAccount(account.secret);
    console.log("\n\nDeleted test account");
}
