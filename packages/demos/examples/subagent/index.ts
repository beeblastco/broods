/**
 * Example subagent dispatch over the sync SSE API.
 */

import { createAccount, createAgent, deleteAccount, streamSSE } from "filthy-panty";

const googleApiKey = process.env.ACCOUNT_GOOGLE_API_KEY!;
const tavilyApiKey = process.env.ACCOUNT_TAVILY_API_KEY!;

const account = await createAccount(`subagent-${Date.now()}`);

const subagent = await createAgent(account.secret, "Subagent assistant",
    {
        provider: {
            google: {
                apiKey: googleApiKey,
            },
        },
        model: {
            provider: "google",
            modelId: "gemma-4-31b-it",
        },
        agent: {
            system: `Knowledge cutoff: Janurary 2025.\n\nYou are a helpful personal assistant that can use tools to get information and perform tasks for the user.\n\nYou also have access to web search and web fetch tools. Always use these tools to research and get up-to-date information or when you are asked for. Your knowledge was limited by cutoff training data date so do not rely on it for up-to-date information or fact checks. Only research and answer the question, don't put additional information.`,
        },
        tools: {
            tavilySearch: {
                enabled: true,
                apiKey: tavilyApiKey,
                searchDepth: "advanced",
                topic: "news",
                includeAnswer: true,
                maxResults: 3,
            },
        }
    },
    "Specialized research agent"
);

const parent = await createAgent(account.secret, "Parent assistant",
    {
        provider: {
            google: {
                apiKey: googleApiKey,
            },
        },
        model: {
            provider: "google",
            modelId: "gemma-4-31b-it",
        },
        agent: {
            system: "You are a helpful assistant. Please answer based on the informations provided",
        },
        subagent: {
            enabled: true,
            allowed: [subagent.agentId], // Add the subagent ID here
            context: "new",
        },
    },
);


console.log("Created test account:", JSON.stringify(account));
console.log("Created subagent:", JSON.stringify(subagent));
console.log("Created parent agent:", JSON.stringify(parent));

try {
    const timestamp = Date.now();
    const body = {
        agentId: parent.agentId,
        eventId: `subagent-${timestamp}`,
        conversationKey: `subagent-${timestamp}`,
        events: [
            {
                role: "user",
                content: [{
                    type: "text",
                    text: [
                        "Launch two subagents in parallel to",
                        "research the newest model release from OpenAI",
                        "and the newest model release from Anthropic.",
                        "Compare their coding capabilities and say which is better for coding.",
                    ].join(" "),
                }],
            },
        ],
    };

    for await (const chunk of streamSSE(body, account.secret)) {
        process.stdout.write(chunk + "\n\n");
    }
} finally {
    await deleteAccount(account.secret);
    console.log("\nDeleted test account");
}
