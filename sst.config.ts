/// <reference path="./.sst/platform/config.d.ts" />

import type { Output } from "@pulumi/pulumi";

const AWS_REGION = "eu-central-1";
const AWS_ACCOUNT_ID = "123456789012";
const PROJECT_NAME = "filthy-panty";
const PROJECT_OWNER_EMAIL = "owner@example.com";
const GOOGLE_MODEL_ID = "gemma-4-31b-it";
const MAX_AGENT_ITERATIONS = 20;
const SLIDING_CONTEXT_WINDOW = 20;

const DEFAULT_SYSTEM_PROMPT = [
  "You are a helpful AI assistant.",
  "Reply in the same language as the user unless asked otherwise.",
  "Be concise, helpful, and safe.",
  "If the user asks something ambiguous, ask a short clarifying question.",
].join(" ");

const AWS_PROFILE =
  process.env.CI ? undefined : (process.env.AWS_PROFILE ?? "default");

function resourceName(service: string, stage: string): string {
  const stagePrefix = stage === "production" ? "" : `${stage}-`;
  return `${stagePrefix}${PROJECT_NAME}-${service}-${AWS_REGION}-${AWS_ACCOUNT_ID}`;
}

export default $config({
  app(input) {
    const stage = input?.stage ?? "dev";

    return {
      name: PROJECT_NAME,
      removal: stage === "production" ? "retain" : "remove",
      protect: stage === "production",
      home: "aws",
      providers: {
        aws: {
          region: AWS_REGION,
          version: "7.20.0",
          ...(AWS_PROFILE ? { profile: AWS_PROFILE } : {}),
          defaultTags: {
            tags: {
              terraform: "false",
              project: PROJECT_NAME,
              owner: PROJECT_OWNER_EMAIL,
            },
          },
        },
      },
    };
  },

  async run() {
    const stage = $app.stage;
    const names = {
      conversations: resourceName("conversations", stage),
      processedEvents: resourceName("processed-events", stage),
      telegramIntegration: resourceName("telegram-integration", stage),
      harnessProcessing: resourceName("harness-processing", stage),
    };

    const telegramBotToken = new sst.Secret("TelegramBotToken");
    const telegramWebhookSecret = new sst.Secret("TelegramWebhookSecret");
    const allowedChatIds = new sst.Secret("AllowedChatIds");
    const googleApiKey = new sst.Secret("GoogleApiKey");

    // ── DynamoDB ──────────────────────────────────────────────────────────

    const conversationsTable = new sst.aws.Dynamo("Conversations", {
      fields: {
        conversationKey: "string",
      },
      primaryIndex: { hashKey: "conversationKey" },
      deletionProtection: stage === "production",
      transform: {
        table: {
          name: names.conversations,
        },
      },
    });

    const processedEventsTable = new sst.aws.Dynamo("ProcessedEvents", {
      fields: {
        eventId: "string",
      },
      primaryIndex: { hashKey: "eventId" },
      ttl: "expiresAt",
      deletionProtection: stage === "production",
      transform: {
        table: {
          name: names.processedEvents,
        },
      },
    });

    // ── Tool Lambdas ──────────────────────────────────────────────────────
    // Add your tool Lambdas here. Each tool is a small Lambda invoked by
    // the harness-processing agent loop when the model returns tool_use.
    //
    // Example:
    //   const toolMyTool = new sst.aws.Function("ToolMyTool", {
    //     name: resourceName("tool-my-tool", stage),
    //     runtime: "provided.al2023",
    //     architecture: "arm64",
    //     bundle: "dist/tool-my-tool",
    //     handler: "bootstrap",
    //     timeout: "10 seconds",
    //     memory: "128 MB",
    //     logging: { format: "json", retention: "1 month" },
    //   });

    const toolLambdaArns: Output<string>[] = [];
    const toolArnMapping: Record<string, Output<string>> = {};

    // ── Harness Processing Lambda ─────────────────────────────────────────

    const harnessProcessing = new sst.aws.Function("HarnessProcessing", {
      name: names.harnessProcessing,
      runtime: "provided.al2023",
      architecture: "arm64",
      bundle: "dist/harness-processing",
      handler: "bootstrap",
      description:
        "Runs the agentic AI loop: dedup, load context, Google AI streaming converse, tool execution, persist, and send reply via SSE.",
      timeout: "5 minutes",
      memory: "256 MB",
      url: {
        authorization: "none",
        invokeMode: "response_stream",
      },
      logging: { format: "json", retention: "1 month" },
      environment: {
        GOOGLE_API_KEY: googleApiKey.value,
        GOOGLE_MODEL_ID,
        CONVERSATIONS_TABLE_NAME: conversationsTable.name,
        PROCESSED_EVENTS_TABLE_NAME: processedEventsTable.name,
        DEFAULT_SYSTEM_PROMPT,
        SLIDING_CONTEXT_WINDOW: String(SLIDING_CONTEXT_WINDOW),
        MAX_AGENT_ITERATIONS: String(MAX_AGENT_ITERATIONS),
        TOOL_ARN_MAPPING: $resolve(toolArnMapping).apply((resolved) =>
          JSON.stringify(resolved),
        ),
      },
      permissions: [
        {
          actions: [
            "dynamodb:GetItem",
            "dynamodb:UpdateItem",
            "dynamodb:PutItem",
            "dynamodb:DeleteItem",
          ],
          resources: [conversationsTable.arn, processedEventsTable.arn],
        },
        ...(toolLambdaArns.length > 0
          ? [
              {
                actions: ["lambda:InvokeFunction"],
                resources: toolLambdaArns,
              },
            ]
          : []),
      ],
    });

    // ── Telegram Integration Lambda ───────────────────────────────────────

    const telegramIntegration = new sst.aws.Function("TelegramIntegration", {
      name: names.telegramIntegration,
      runtime: "provided.al2023",
      architecture: "arm64",
      bundle: "dist/telegram-integration",
      handler: "bootstrap",
      description:
        "Receives Telegram webhook events, handles commands, and streams harness processing via Function URL.",
      timeout: "60 seconds",
      memory: "128 MB",
      url: true,
      logging: { format: "json", retention: "1 month" },
      environment: {
        HARNESS_PROCESSING_URL: harnessProcessing.url,
        TELEGRAM_BOT_TOKEN: telegramBotToken.value,
        TELEGRAM_WEBHOOK_SECRET: telegramWebhookSecret.value,
        ALLOWED_CHAT_IDS: allowedChatIds.value,
        CONVERSATIONS_TABLE_NAME: conversationsTable.name,
      },
      permissions: [
        {
          actions: ["dynamodb:DeleteItem"],
          resources: [conversationsTable.arn],
        },
      ],
    });

    return {
      telegramWebhookUrl: telegramIntegration.url,
      harnessProcessingUrl: harnessProcessing.url,
      conversationsTableName: conversationsTable.name,
      processedEventsTableName: processedEventsTable.name,
    };
  },
});
