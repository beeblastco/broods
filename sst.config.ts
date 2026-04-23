/// <reference path="./.sst/platform/config.d.ts" />

// SST infrastructure for the single-entrypoint architecture: one streaming harness Lambda for both direct API calls and Telegram webhooks.
const AWS_REGION = "eu-central-1";
const AWS_ACCOUNT_ID = "123456789012";
const PROJECT_NAME = "filthy-panty";
const PROJECT_OWNER_EMAIL = "owner@example.com";
const GOOGLE_MODEL_ID = "gemma-4-31b-it";
const SLIDING_CONTEXT_WINDOW = "20";
const MAX_AGENT_ITERATIONS = "20";
const TELEGRAM_REACTION_EMOJI = "👀";
const AWS_PROFILE = process.env.CI ? undefined : (process.env.AWS_PROFILE ?? "default");


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
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const DEFAULT_SYSTEM_PROMPT = readFileSync(join(process.cwd(), "SYSTEM.md"), "utf8");

    const stage = $app.stage;
    const names = {
      conversations: resourceName("conversations", stage),
      processedEvents: resourceName("processed-events", stage),
      harnessProcessing: resourceName("harness-processing", stage),
      memory: resourceName("memory", stage),
    };

    const telegramBotToken = new sst.Secret("TelegramBotToken");
    const telegramWebhookSecret = new sst.Secret("TelegramWebhookSecret");
    const allowedChatIds = new sst.Secret("AllowedChatIds");
    const googleApiKey = new sst.Secret("GoogleApiKey");
    const tavilyApiKey = new sst.Secret("TavilyApiKey");

    const conversationsTable = new sst.aws.Dynamo("Conversations", {
      fields: {
        conversationKey: "string",
        createdAt: "string",
      },
      primaryIndex: { hashKey: "conversationKey", rangeKey: "createdAt" },
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
    const memoryBucketArn = `arn:aws:s3:::${names.memory}`;

    const harnessProcessing = new sst.aws.Function("HarnessProcessing", {
      name: names.harnessProcessing,
      runtime: "provided.al2023",
      architecture: "arm64",
      bundle: "dist/harness-processing",
      handler: "bootstrap",
      description: "Runs the streaming agent loop: dedupe, load context, call tools inline, and return SSE.",
      timeout: "10 minutes",
      memory: "256 MB",
      streaming: true,
      url: {
        authorization: "none",
      },
      logging: { format: "json", retention: "1 month" },
      environment: {
        GOOGLE_API_KEY: googleApiKey.value,
        GOOGLE_MODEL_ID,
        CONVERSATIONS_TABLE_NAME: conversationsTable.name,
        PROCESSED_EVENTS_TABLE_NAME: processedEventsTable.name,
        DEFAULT_SYSTEM_PROMPT,
        SLIDING_CONTEXT_WINDOW,
        MAX_AGENT_ITERATIONS,
        TELEGRAM_BOT_TOKEN: telegramBotToken.value,
        TELEGRAM_WEBHOOK_SECRET: telegramWebhookSecret.value,
        ALLOWED_CHAT_IDS: allowedChatIds.value,
        TELEGRAM_REACTION_EMOJI,
        TAVILY_API_KEY: tavilyApiKey.value,
        AWS_S3_BUCKET: names.memory,
      },
      permissions: [
        {
          actions: [
            "dynamodb:BatchWriteItem",
            "dynamodb:Query",
            "dynamodb:PutItem",
            "dynamodb:DeleteItem",
          ],
          resources: [conversationsTable.arn, processedEventsTable.arn],
        },
        {
          actions: [
            "s3:GetObject",
            "s3:PutObject",
            "s3:DeleteObject",
          ],
          resources: [`${memoryBucketArn}/*`],
        },
        {
          actions: ["s3:ListBucket"],
          resources: [memoryBucketArn],
        },
      ],
    });

    const memoryBucket = new sst.aws.Bucket("Memory", {
      versioning: true,
      policy: [
        {
          effect: "deny",
          principals: "*",
          actions: [
            "s3:GetObject",
            "s3:PutObject",
            "s3:DeleteObject",
            "s3:ListBucket",
          ],
          conditions: [
            {
              test: "StringNotLikeIfExists",
              variable: "aws:PrincipalArn",
              values: [
                harnessProcessing.nodes.role.arn,
                $interpolate`arn:aws:sts::${AWS_ACCOUNT_ID}:assumed-role/${harnessProcessing.nodes.role.name}/*`,
              ],
            },
          ],
        },
      ],
      transform: {
        bucket: {
          bucket: names.memory,
        },
        publicAccessBlock: {
          blockPublicAcls: true,
          ignorePublicAcls: true,
          blockPublicPolicy: true,
          restrictPublicBuckets: true,
        },
      },
    });

    return {
      telegramWebhookUrl: harnessProcessing.url,
      harnessProcessingUrl: harnessProcessing.url,
      conversationsTableName: conversationsTable.name,
      processedEventsTableName: processedEventsTable.name,
      memoryBucketName: memoryBucket.name,
    };
  },
});
