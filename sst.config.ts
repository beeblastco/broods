/// <reference path="./.sst/platform/config.d.ts" />

// SST infrastructure for the account-managed harness: one streaming runtime Lambda and one account-management Lambda.
const AWS_REGION = "eu-central-1";
const AWS_ACCOUNT_ID = "123456789012";
const PROJECT_NAME = "filthy-panty";
const PROJECT_OWNER_EMAIL = "owner@example.com";
const GOOGLE_MODEL_ID = "gemma-4-31b-it";
const SLIDING_CONTEXT_WINDOW = "20";
const MAX_AGENT_ITERATIONS = "20";
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
    const stage = $app.stage;
    const names = {
      conversations: resourceName("conversations", stage),
      processedEvents: resourceName("processed-events", stage),
      asyncResults: resourceName("async-results", stage),
      accountConfigs: resourceName("account-configs", stage),
      accountSignupRateLimits: resourceName("account-signup-rate-limits", stage),
      harnessProcessing: resourceName("harness-processing", stage),
      accountManage: resourceName("account-manage", stage),
      memory: resourceName("memory", stage),
    };

    const googleApiKey = new sst.Secret("GoogleApiKey");
    const tavilyApiKey = new sst.Secret("TavilyApiKey");
    const adminAccountSecret = new sst.Secret("AdminAccountSecret");
    const accountConfigEncryptionSecret = new sst.Secret("AccountConfigEncryptionSecret");

    const accountConfigsTable = new sst.aws.Dynamo("AccountConfig", {
      fields: {
        accountId: "string",
        secretHash: "string",
      },
      primaryIndex: { hashKey: "accountId" },
      globalIndexes: {
        SecretHashIndex: { hashKey: "secretHash" },
      },
      deletionProtection: stage === "production",
      transform: {
        table: {
          name: names.accountConfigs,
        },
      },
    });

    const accountSignupRateLimitTable = new sst.aws.Dynamo("AccountSignupRateLimit", {
      fields: {
        rateLimitKey: "string",
      },
      primaryIndex: { hashKey: "rateLimitKey" },
      ttl: "expiresAt",
      deletionProtection: stage === "production",
      transform: {
        table: {
          name: names.accountSignupRateLimits,
        },
      },
    });

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

    const asyncResultsTable = new sst.aws.Dynamo("AsyncResults", {
      fields: {
        eventId: "string",
      },
      primaryIndex: { hashKey: "eventId" },
      ttl: "expiresAt",
      deletionProtection: stage === "production",
      transform: {
        table: {
          name: names.asyncResults,
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
      description: "Runs the streaming and async direct API agent loop with channel webhook support.",
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
        ASYNC_RESULTS_TABLE_NAME: asyncResultsTable.name,
        ACCOUNT_CONFIGS_TABLE_NAME: accountConfigsTable.name,
        ACCOUNT_SECRET_INDEX_NAME: "SecretHashIndex",
        ACCOUNT_CONFIG_ENCRYPTION_SECRET: accountConfigEncryptionSecret.value,
        SLIDING_CONTEXT_WINDOW,
        MAX_AGENT_ITERATIONS,
        TAVILY_API_KEY: tavilyApiKey.value,
        FILESYSTEM_BUCKET_NAME: names.memory,
      },
      permissions: [
        {
          actions: [
            "dynamodb:GetItem",
            "dynamodb:Query",
          ],
          resources: [accountConfigsTable.arn, $interpolate`${accountConfigsTable.arn}/index/SecretHashIndex`],
        },
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
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
          ],
          resources: [asyncResultsTable.arn],
        },
        {
          actions: ["lambda:InvokeFunction"],
          resources: [`arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:${names.harnessProcessing}`],
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

    const accountManage = new sst.aws.Function("AccountManage", {
      name: names.accountManage,
      runtime: "provided.al2023",
      architecture: "arm64",
      bundle: "dist/account-manage",
      handler: "bootstrap",
      description: "Manages accounts, account secrets, and account-level harness configuration.",
      timeout: "10 seconds",
      memory: "128 MB",
      streaming: false,
      // Can configure additional service for authentication, here we keep it simple
      url: {
        authorization: "none",
      },
      logging: { format: "json", retention: "1 month" },
      environment: {
        ACCOUNT_CONFIGS_TABLE_NAME: accountConfigsTable.name,
        ACCOUNT_SECRET_INDEX_NAME: "SecretHashIndex",
        ACCOUNT_SIGNUP_RATE_LIMIT_TABLE_NAME: accountSignupRateLimitTable.name,
        ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR: "5",
        ADMIN_ACCOUNT_SECRET: adminAccountSecret.value,
        ACCOUNT_CONFIG_ENCRYPTION_SECRET: accountConfigEncryptionSecret.value,
      },
      permissions: [
        {
          actions: [
            "dynamodb:DeleteItem",
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:Query",
            "dynamodb:Scan",
            "dynamodb:UpdateItem",
          ],
          resources: [accountConfigsTable.arn, $interpolate`${accountConfigsTable.arn}/index/SecretHashIndex`],
        },
        {
          actions: [
            "dynamodb:UpdateItem",
          ],
          resources: [accountSignupRateLimitTable.arn],
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
      harnessProcessingUrl: harnessProcessing.url,
      accountManageUrl: accountManage.url,
      accountConfigsTableName: accountConfigsTable.name,
      accountSignupRateLimitTableName: accountSignupRateLimitTable.name,
      conversationsTableName: conversationsTable.name,
      processedEventsTableName: processedEventsTable.name,
      asyncResultsTableName: asyncResultsTable.name,
      filesystemBucketName: filesystemBucket.name,
    };
  },
});
