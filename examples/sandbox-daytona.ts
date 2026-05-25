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
            "Use the filesystem tool to write source files and data files first, then execute only those files.",
            "Sandboxed code should use normal relative file APIs from the workspace root.",
            "Do not use inline execution such as node -e or python -c.",
            "After running files, summarize stdout, generated files, and status for each run.",
        ].join("\n"),
    },
    workspace: {
        enabled: true,
        needsApproval: false,
        memory: {
            enabled: false,
        },
        filesystem: {
            enabled: true,
        },
        sandbox: {
            enabled: true,
            provider: "daytona",
            outputLimitBytes: 65536,
            options: {
                apiKey: daytonaApiKey,
                organizationId: daytonaOrganizationId,
                apiUrl: "https://app.daytona.io/api",
                target: "eu",
                snapshot: "fuse-s3",
                workspaceRoot: "/mnt/workspaces",
                mountAwsS3Buckets: true
            },
        },
        tasks: {
            enabled: false,
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
                    text: [
                        "Run this exact native mounted sandbox smoke test.",
                        "",
                        "1. Write /numbers.json with {\"left\":21,\"right\":2}.",
                        "2. Write /sandbox-demo.js with JavaScript that reads ./numbers.json using fs.readFileSync, then prints JSON.stringify({ language: 'javascript', answer: left * right }).",
                        "3. Run node /sandbox-demo.js.",
                        "4. Write /sandbox-demo.py with Python that reads numbers.json with pathlib.Path, writes result.json with {'language': 'python', 'answer': 6 * 7}, and prints the result JSON.",
                        "5. Run python3 /sandbox-demo.py.",
                        "6. Read /result.json with the filesystem tool.",
                        "7. Return the stdout and status objects from both runs, plus the result.json content.",
                    ].join("\n"),
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
