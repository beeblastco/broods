/// <reference path="./.sst/platform/config.d.ts" />

// SST infrastructure for the single-entrypoint architecture: one streaming harness Lambda for direct API calls and optional channel webhooks.
const AWS_REGION = "eu-central-1";
const AWS_ACCOUNT_ID = "123456789012";
const PROJECT_NAME = "filthy-panty";
const PROJECT_OWNER_EMAIL = "owner@example.com";
const GOOGLE_MODEL_ID = "gemma-4-31b-it";
const SLIDING_CONTEXT_WINDOW = "20";
const MAX_AGENT_ITERATIONS = "20";
const TELEGRAM_REACTION_EMOJI = "👀";
const GITHUB_ALLOWED_REPOS = process.env.GITHUB_ALLOWED_REPOS;
const SLACK_ALLOWED_CHANNEL_IDS = process.env.SLACK_ALLOWED_CHANNEL_IDS;
const DISCORD_ALLOWED_GUILD_IDS = process.env.DISCORD_ALLOWED_GUILD_IDS;
const ENABLE_DIRECT_API = process.env.ENABLE_DIRECT_API === "true";
const ENABLE_TELEGRAM_INTEGRATION = process.env.ENABLE_TELEGRAM_INTEGRATION === "true";
const ENABLE_GITHUB_INTEGRATION = process.env.ENABLE_GITHUB_INTEGRATION === "true";
const ENABLE_SLACK_INTEGRATION = process.env.ENABLE_SLACK_INTEGRATION === "true";
const ENABLE_DISCORD_INTEGRATION = process.env.ENABLE_DISCORD_INTEGRATION === "true";
const AWS_PROFILE = process.env.CI ? undefined : (process.env.AWS_PROFILE ?? "default");


function resourceName(service: string, stage: string): string {
  const stagePrefix = stage === "production" ? "" : `${stage}-`;
  return `${stagePrefix}${PROJECT_NAME}-${service}-${AWS_REGION}-${AWS_ACCOUNT_ID}`;
}

function requireExplicitAllowList(
  stage: string,
  enabled: boolean,
  name: string,
  raw: string | undefined,
): string | undefined {
  if (!enabled) {
    return raw;
  }

  const normalized = raw?.trim();
  if (stage === "dev") {
    return normalized;
  }

  if (!normalized || normalized.toLowerCase() === "open") {
    throw new Error(`${name} must be explicitly configured when the integration is enabled outside dev`);
  }

  return normalized;
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
    const gitHubAllowedRepos = requireExplicitAllowList(stage, ENABLE_GITHUB_INTEGRATION, "GITHUB_ALLOWED_REPOS", GITHUB_ALLOWED_REPOS);
    const slackAllowedChannelIds = requireExplicitAllowList(
      stage,
      ENABLE_SLACK_INTEGRATION,
      "SLACK_ALLOWED_CHANNEL_IDS",
      SLACK_ALLOWED_CHANNEL_IDS,
    );
    const discordAllowedGuildIds = requireExplicitAllowList(
      stage,
      ENABLE_DISCORD_INTEGRATION,
      "DISCORD_ALLOWED_GUILD_IDS",
      DISCORD_ALLOWED_GUILD_IDS,
    );
    const names = {
      conversations: resourceName("conversations", stage),
      processedEvents: resourceName("processed-events", stage),
      harnessProcessing: resourceName("harness-processing", stage),
      memory: resourceName("memory", stage),
    };

    const googleApiKey = new sst.Secret("GoogleApiKey");
    const tavilyApiKey = new sst.Secret("TavilyApiKey");
    const directApiSecret = ENABLE_DIRECT_API ? new sst.Secret("DirectApiSecret") : null;
    const telegramBotToken = ENABLE_TELEGRAM_INTEGRATION ? new sst.Secret("TelegramBotToken") : null;
    const telegramWebhookSecret = ENABLE_TELEGRAM_INTEGRATION ? new sst.Secret("TelegramWebhookSecret") : null;
    const allowedChatIds = ENABLE_TELEGRAM_INTEGRATION ? new sst.Secret("AllowedChatIds") : null;
    const gitHubWebhookSecret = ENABLE_GITHUB_INTEGRATION ? new sst.Secret("GitHubWebhookSecret") : null;
    const gitHubPrivateKey = ENABLE_GITHUB_INTEGRATION ? new sst.Secret("GitHubPrivateKey") : null;
    const gitHubAppId = ENABLE_GITHUB_INTEGRATION ? new sst.Secret("GitHubAppId") : null;
    const slackBotToken = ENABLE_SLACK_INTEGRATION ? new sst.Secret("SlackBotToken") : null;
    const slackSigningSecret = ENABLE_SLACK_INTEGRATION ? new sst.Secret("SlackSigningSecret") : null;
    const discordBotToken = ENABLE_DISCORD_INTEGRATION ? new sst.Secret("DiscordBotToken") : null;
    const discordPublicKey = ENABLE_DISCORD_INTEGRATION ? new sst.Secret("DiscordPublicKey") : null;

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
    const filesystemBucketArn = `arn:aws:s3:::${names.memory}`;

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
        SLIDING_CONTEXT_WINDOW,
        MAX_AGENT_ITERATIONS,
        TAVILY_API_KEY: tavilyApiKey.value,
        FILESYSTEM_BUCKET_NAME: names.memory,
        ...(ENABLE_DIRECT_API && directApiSecret
          ? {
            ENABLE_DIRECT_API: "true",
            DIRECT_API_SECRET: directApiSecret.value,
          }
          : {
            ENABLE_DIRECT_API: "false",
          }),
        ...(ENABLE_TELEGRAM_INTEGRATION && telegramBotToken && telegramWebhookSecret && allowedChatIds
          ? {
            TELEGRAM_BOT_TOKEN: telegramBotToken.value,
            TELEGRAM_WEBHOOK_SECRET: telegramWebhookSecret.value,
            ALLOWED_CHAT_IDS: allowedChatIds.value,
            TELEGRAM_REACTION_EMOJI,
          }
          : {}),
        ...(ENABLE_GITHUB_INTEGRATION && gitHubWebhookSecret && gitHubPrivateKey && gitHubAppId
          ? {
            GITHUB_WEBHOOK_SECRET: gitHubWebhookSecret.value,
            GITHUB_PRIVATE_KEY: gitHubPrivateKey.value,
            GITHUB_APP_ID: gitHubAppId.value,
            ...(gitHubAllowedRepos ? { GITHUB_ALLOWED_REPOS: gitHubAllowedRepos } : {}),
          }
          : {}),
        ...(ENABLE_SLACK_INTEGRATION && slackBotToken && slackSigningSecret
          ? {
            SLACK_BOT_TOKEN: slackBotToken.value,
            SLACK_SIGNING_SECRET: slackSigningSecret.value,
            ...(slackAllowedChannelIds ? { SLACK_ALLOWED_CHANNEL_IDS: slackAllowedChannelIds } : {}),
          }
          : {}),
        ...(ENABLE_DISCORD_INTEGRATION && discordBotToken && discordPublicKey
          ? {
            DISCORD_BOT_TOKEN: discordBotToken.value,
            DISCORD_PUBLIC_KEY: discordPublicKey.value,
            ...(discordAllowedGuildIds ? { DISCORD_ALLOWED_GUILD_IDS: discordAllowedGuildIds } : {}),
          }
          : {}),
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
          resources: [`${filesystemBucketArn}/*`],
        },
        {
          actions: ["s3:ListBucket"],
          resources: [filesystemBucketArn],
        },
      ],
    });

    const filesystemBucket = new sst.aws.Bucket("Memory", {
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
      filesystemBucketName: filesystemBucket.name,
    };
  },
});
