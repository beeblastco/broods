/// <reference path="./.sst/platform/config.d.ts" />

// SST infrastructure for the account-managed harness: one streaming runtime Lambda and one account-management Lambda.
const AWS_ACCOUNT_ID = "403012596812";
const PROJECT_NAME = "filthy-panty";
const PROJECT_OWNER_EMAIL = "phickstran@beeblast.co";
const AWS_PROFILE = process.env.CI ? undefined : (process.env.AWS_PROFILE ?? "default");
const ENABLE_DIRECT_API = parseBooleanEnv("ENABLE_DIRECT_API", false);
const ENABLE_WEBSOCKET = parseBooleanEnv("ENABLE_WEBSOCKET", false);
const SANDBOX_WORKSPACE_MOUNT_PATH = "/mnt/workspaces";
const NATS_URL = process.env.NATS_URL?.trim();

if (ENABLE_WEBSOCKET && !NATS_URL) {
  throw new Error("NATS_URL must be set when ENABLE_WEBSOCKET=true");
}

function awsRegion(): string {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (region) {
    return region;
  }

  if (process.env.CI) {
    throw new Error("AWS_REGION must be set in CI");
  }

  return "eu-central-1";
}

function resourceName(service: string, stage: string, region: string): string {
  const stagePrefix = stage === "production" ? "" : `${stage}-`;
  return `${stagePrefix}${PROJECT_NAME}-${service}-${region}-${AWS_ACCOUNT_ID}`;
}

function parseBooleanEnv(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`${name} must be a boolean-like value`);
}

function sandboxRuntimePermissions(
  filesystemBucketArn: string,
  s3FilesFileSystemArn: $util.Input<string>,
  s3FilesAccessPointArn: $util.Input<string>,
) : {
  actions: string[];
  resources: $util.Input<string>[];
}[] {
  return [
    {
      actions: [
        "s3files:ClientMount",
        "s3files:ClientWrite",
      ],
      resources: [s3FilesFileSystemArn, s3FilesAccessPointArn],
    },
    {
      actions: [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:PutObject",
        "s3:DeleteObject",
      ],
      resources: [`${filesystemBucketArn}/*`],
    },
    {
      actions: ["s3:ListBucket"],
      resources: [filesystemBucketArn],
    },
  ];
}

function denyUnlessPrincipalAllowed(allowedPrincipalArns: $util.Input<string>[]) {
  return {
    effect: "deny" as const,
    principals: "*" as const,
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
        values: allowedPrincipalArns,
      },
    ],
  };
}

export default $config({
  app(input) {
    const stage = input?.stage ?? "dev";
    const region = awsRegion();

    return {
      name: PROJECT_NAME,
      removal: stage === "production" ? "retain" : "remove",
      protect: stage === "production",
      home: "aws",
      providers: {
        aws: {
          region,
          version: "7.30.0",
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
    const aws = await import("@pulumi/aws");
    const stage = $app.stage;
    const region = awsRegion();
    const names = {
      conversations: resourceName("conversations", stage, region),
      processedEvents: resourceName("processed-events", stage, region),
      asyncAgentResult: resourceName("async-agent-result", stage, region),
      asyncToolResult: resourceName("async-tool-result", stage, region),
      externalAsyncToolMock: resourceName("async-tool-mock", stage, region),
      webhookSubscribeMock: resourceName("webhook-sub-mock", stage, region),
      sandboxNode: resourceName("sandbox-node", stage, region),
      sandboxPython: resourceName("sandbox-python", stage, region),
      accountConfigs: resourceName("account-configs", stage, region),
      agentConfigs: resourceName("agent-configs", stage, region),
      accountSignupRateLimits: resourceName("account-signup-rate-limits", stage, region),
      harnessProcessing: resourceName("harness-processing", stage, region),
      accountManage: resourceName("account-manage", stage, region),
      memory: resourceName("memory", stage, region),
      skills: resourceName("skills", stage, region),
    };

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

    const agentConfigsTable = new sst.aws.Dynamo("AgentConfig", {
      fields: {
        accountId: "string",
        agentId: "string",
      },
      primaryIndex: { hashKey: "accountId", rangeKey: "agentId" },
      deletionProtection: stage === "production",
      transform: {
        table: {
          name: names.agentConfigs,
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

    const asyncAgentResultTable = new sst.aws.Dynamo("AsyncAgentResult", {
      fields: {
        eventId: "string",
      },
      primaryIndex: { hashKey: "eventId" },
      ttl: "expiresAt",
      deletionProtection: stage === "production",
      transform: {
        table: {
          name: names.asyncAgentResult,
        },
      },
    });
    const asyncToolResultTable = new sst.aws.Dynamo("AsyncToolResult", {
      fields: {
        resultId: "string",
        parentEventId: "string",
      },
      primaryIndex: { hashKey: "resultId" },
      globalIndexes: {
        ParentEventIdIndex: { hashKey: "parentEventId" },
      },
      ttl: "expiresAt",
      deletionProtection: stage === "production",
      transform: {
        table: {
          name: names.asyncToolResult,
        },
      },
    });
    const filesystemBucketArn = `arn:aws:s3:::${names.memory}`;
    const skillsBucketArn = `arn:aws:s3:::${names.skills}`;
    const filesystemBucketAllowedPrincipalArns: $util.Input<string>[] = [];
    const skillsBucketAllowedPrincipalArns: $util.Input<string>[] = [];

    const filesystemBucket = new sst.aws.Bucket("Memory", {
      versioning: true,
      policy: [denyUnlessPrincipalAllowed(filesystemBucketAllowedPrincipalArns)],
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

    const skillsBucket = new sst.aws.Bucket("Skills", {
      versioning: true,
      policy: [denyUnlessPrincipalAllowed(skillsBucketAllowedPrincipalArns)],
      transform: {
        bucket: {
          bucket: names.skills,
        },
        publicAccessBlock: {
          blockPublicAcls: true,
          ignorePublicAcls: true,
          blockPublicPolicy: true,
          restrictPublicBuckets: true,
        },
      },
    });

    // Setup the VPC for the sandbox connection.
    // It does not allow connect to outside internet, else we have to enable NAT Gateway which is
    // expensive asf.
    const sandboxNetwork = new sst.aws.Vpc("SandboxNetwork", {
      az: 2, // 2 az same price of 1 az.
    });

    const s3FilesRole = new aws.iam.Role("SandboxS3FilesRole", {
      name: resourceName("sandbox-s3files", stage, region),
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: "s3files.amazonaws.com" },
          Action: "sts:AssumeRole",
        }],
      }),
    });

    new aws.iam.RolePolicy("SandboxS3FilesRolePolicy", {
      role: s3FilesRole.id,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "s3:GetObject",
              "s3:GetObjectVersion",
              "s3:PutObject",
              "s3:DeleteObject",
            ],
            Resource: [`${filesystemBucketArn}/*`],
          },
          {
            Effect: "Allow",
            Action: ["s3:ListBucket"],
            Resource: [filesystemBucketArn],
          },
        ],
      }),
    });

    const sandboxS3Files = new aws.s3.FilesFileSystem("SandboxS3Files", {
      bucket: filesystemBucketArn,
      roleArn: s3FilesRole.arn,
      acceptBucketWarning: true,
    }, {
      dependsOn: [filesystemBucket],
    });

    const sandboxS3FilesAccessPoint = new aws.s3.FilesAccessPoint("SandboxS3FilesAccessPoint", {
      fileSystemId: sandboxS3Files.id,
      posixUsers: [{ uid: 1000, gid: 1000 }],
      rootDirectories: [{
        path: "/",
        creationPermissions: [{
          ownerUid: 1000,
          ownerGid: 1000,
          permissions: "755",
        }],
      }],
    });

    new aws.vpc.SecurityGroupIngressRule("SandboxS3FilesNfsIngress", {
      securityGroupId: sandboxNetwork.securityGroups.apply((ids) => ids[0]!),
      referencedSecurityGroupId: sandboxNetwork.securityGroups.apply((ids) => ids[0]!),
      ipProtocol: "tcp",
      fromPort: 2049,
      toPort: 2049,
    });

    new aws.s3.FilesMountTarget("SandboxS3FilesMountTargetA", {
      fileSystemId: sandboxS3Files.id,
      subnetId: sandboxNetwork.privateSubnets.apply((ids) => ids[0]!),
      securityGroups: sandboxNetwork.securityGroups,
    });

    new aws.s3.FilesMountTarget("SandboxS3FilesMountTargetB", {
      fileSystemId: sandboxS3Files.id,
      subnetId: sandboxNetwork.privateSubnets.apply((ids) => ids[1]!),
      securityGroups: sandboxNetwork.securityGroups,
    });

    const mockExternalAsyncTool = new sst.aws.Function("MockExternalAsyncTool", {
      name: names.externalAsyncToolMock,
      runtime: "python3.12",
      architecture: "arm64",
      bundle: "functions/mock-external-async-tool",
      handler: "handler.handler",
      description: "Mock external async tool for testing external-dispatch mode.",
      timeout: "30 seconds",
      memory: "128 MB",
      url: {
        authorization: "none",
      },
      logging: { format: "json", retention: "1 month" },
    });

    const mockWebhookSubscribe = new sst.aws.Function("MockWebhookSubscribe", {
      name: names.webhookSubscribeMock,
      runtime: "python3.12",
      architecture: "arm64",
      bundle: "functions/mock-webhook-subscribe",
      handler: "handler.handler",
      description: "Mock webhook subscription endpoint for testing inbound webhooks.",
      timeout: "30 seconds",
      memory: "128 MB",
      url: {
        authorization: "none",
      },
      logging: { format: "json", retention: "1 month" },
      environment: {
        MOCK_WEBHOOK_SECRET: process.env.MOCK_WEBHOOK_SECRET ?? "",
      },
    });

    const sandboxNode = new sst.aws.Function("SandboxNode", {
      name: names.sandboxNode,
      runtime: "nodejs22.x",
      architecture: "arm64",
      handler: "functions/sandbox-node/handler.handler",
      description: "Executes workspace JavaScript files without public network egress.",
      timeout: "2 minutes",
      memory: "512 MB", // Minimal memory required from AWS for S3 mount to sandbox execution.
      vpc: sandboxNetwork,
      environment: {
        SANDBOX_WORKSPACE_MOUNT_PATH,
      },
      permissions: sandboxRuntimePermissions(filesystemBucketArn, sandboxS3Files.arn, sandboxS3FilesAccessPoint.arn),
      logging: { format: "json", retention: "1 month" },
      transform: {
        function: (args) => {
          args.fileSystemConfig = {
            arn: sandboxS3FilesAccessPoint.arn,
            localMountPath: SANDBOX_WORKSPACE_MOUNT_PATH,
          };
        },
      },
    });

    const sandboxPython = new sst.aws.Function("SandboxPython", {
      name: names.sandboxPython,
      runtime: "python3.12",
      architecture: "arm64",
      bundle: "functions/sandbox-python",
      handler: "handler.handler",
      description: "Executes workspace Python files without public network egress.",
      timeout: "2 minutes",
      memory: "512 MB", // Minimal memory required from AWS for S3 mount to sandbox execution.
      vpc: sandboxNetwork,
      environment: {
        SANDBOX_WORKSPACE_MOUNT_PATH,
      },
      permissions: sandboxRuntimePermissions(filesystemBucketArn, sandboxS3Files.arn, sandboxS3FilesAccessPoint.arn),
      logging: { format: "json", retention: "1 month" },
      transform: {
        function: (args) => {
          args.fileSystemConfig = {
            arn: sandboxS3FilesAccessPoint.arn,
            localMountPath: SANDBOX_WORKSPACE_MOUNT_PATH,
          };
        },
      },
    });

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
        CONVERSATIONS_TABLE_NAME: conversationsTable.name,
        PROCESSED_EVENTS_TABLE_NAME: processedEventsTable.name,
        ASYNC_AGENT_RESULT_TABLE_NAME: asyncAgentResultTable.name,
        ASYNC_TOOL_RESULT_TABLE_NAME: asyncToolResultTable.name,
        ACCOUNT_CONFIGS_TABLE_NAME: accountConfigsTable.name,
        AGENT_CONFIGS_TABLE_NAME: agentConfigsTable.name,
        ACCOUNT_SECRET_INDEX_NAME: "SecretHashIndex",
        ACCOUNT_CONFIG_ENCRYPTION_SECRET: accountConfigEncryptionSecret.value,
        FILESYSTEM_BUCKET_NAME: names.memory,
        SKILLS_BUCKET_NAME: names.skills,
        ENABLE_DIRECT_API: ENABLE_DIRECT_API ? "true" : "false",
        ENABLE_WEBSOCKET: ENABLE_WEBSOCKET ? "true" : "false",
        MOCK_EXTERNAL_ASYNC_TOOL_URL: mockExternalAsyncTool.url,
        SANDBOX_NODE_FUNCTION_NAME: sandboxNode.name,
        SANDBOX_PYTHON_FUNCTION_NAME: sandboxPython.name,
        ...(NATS_URL ? { NATS_URL } : {}),
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
            "dynamodb:GetItem",
            "dynamodb:Query",
          ],
          resources: [agentConfigsTable.arn],
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
          resources: [asyncAgentResultTable.arn],
        },
        {
          actions: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
          ],
          resources: [asyncToolResultTable.arn],
        },
        {
          actions: ["lambda:InvokeFunction"],
          resources: [`arn:aws:lambda:${region}:${AWS_ACCOUNT_ID}:function:${names.harnessProcessing}`],
        },
        {
          actions: ["lambda:InvokeFunction"],
          resources: [
            sandboxNode.arn,
            sandboxPython.arn,
          ],
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
        {
          actions: [
            "s3:GetObject",
          ],
          resources: [`${skillsBucketArn}/*`],
        },
        {
          actions: ["s3:ListBucket"],
          resources: [skillsBucketArn],
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
      streaming: true,
      // Can configure additional service for authentication, here we keep it simple
      url: {
        authorization: "none",
      },
      logging: { format: "json", retention: "1 month" },
      environment: {
        ACCOUNT_CONFIGS_TABLE_NAME: accountConfigsTable.name,
        AGENT_CONFIGS_TABLE_NAME: agentConfigsTable.name,
        ACCOUNT_SECRET_INDEX_NAME: "SecretHashIndex",
        CONVERSATIONS_TABLE_NAME: conversationsTable.name,
        PROCESSED_EVENTS_TABLE_NAME: processedEventsTable.name,
        ASYNC_AGENT_RESULT_TABLE_NAME: asyncAgentResultTable.name,
        ASYNC_TOOL_RESULT_TABLE_NAME: asyncToolResultTable.name,
        FILESYSTEM_BUCKET_NAME: names.memory,
        SKILLS_BUCKET_NAME: names.skills,
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
            "dynamodb:DeleteItem",
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:Query",
            "dynamodb:UpdateItem",
          ],
          resources: [agentConfigsTable.arn],
        },
        {
          actions: [
            "dynamodb:BatchWriteItem",
            "dynamodb:DeleteItem",
            "dynamodb:Scan",
          ],
          resources: [conversationsTable.arn, processedEventsTable.arn, asyncAgentResultTable.arn, asyncToolResultTable.arn],
        },
        {
          actions: [
            "dynamodb:UpdateItem",
          ],
          resources: [accountSignupRateLimitTable.arn],
        },
        {
          actions: [
            "s3:DeleteObject",
          ],
          resources: [`${filesystemBucketArn}/*`],
        },
        {
          actions: ["s3:ListBucket"],
          resources: [filesystemBucketArn],
        },
        {
          actions: [
            "s3:GetObject",
            "s3:PutObject",
            "s3:DeleteObject",
          ],
          resources: [`${skillsBucketArn}/*`],
        },
        {
          actions: ["s3:ListBucket"],
          resources: [skillsBucketArn],
        },
      ],
    });

    filesystemBucketAllowedPrincipalArns.push(
      harnessProcessing.nodes.role.arn,
      $interpolate`arn:aws:sts::${AWS_ACCOUNT_ID}:assumed-role/${harnessProcessing.nodes.role.name}/*`,
      accountManage.nodes.role.arn,
      $interpolate`arn:aws:sts::${AWS_ACCOUNT_ID}:assumed-role/${accountManage.nodes.role.name}/*`,
      sandboxNode.nodes.role.arn,
      $interpolate`arn:aws:sts::${AWS_ACCOUNT_ID}:assumed-role/${sandboxNode.nodes.role.name}/*`,
      sandboxPython.nodes.role.arn,
      $interpolate`arn:aws:sts::${AWS_ACCOUNT_ID}:assumed-role/${sandboxPython.nodes.role.name}/*`,
      s3FilesRole.arn,
    );

    skillsBucketAllowedPrincipalArns.push(
      harnessProcessing.nodes.role.arn,
      $interpolate`arn:aws:sts::${AWS_ACCOUNT_ID}:assumed-role/${harnessProcessing.nodes.role.name}/*`,
      accountManage.nodes.role.arn,
      $interpolate`arn:aws:sts::${AWS_ACCOUNT_ID}:assumed-role/${accountManage.nodes.role.name}/*`,
    );

    return {
      agentServiceUrl: harnessProcessing.url,
      accountServiceUrl: accountManage.url,
      mockExternalAsyncToolUrl: mockExternalAsyncTool.url,
      mockWebhookSubscribeUrl: mockWebhookSubscribe.url,
      sandboxNodeFunctionName: sandboxNode.name,
      sandboxPythonFunctionName: sandboxPython.name,
      accountConfigsTableName: accountConfigsTable.name,
      agentConfigsTableName: agentConfigsTable.name,
      accountSignupRateLimitTableName: accountSignupRateLimitTable.name,
      conversationsTableName: conversationsTable.name,
      processedEventsTableName: processedEventsTable.name,
      asyncAgentResultTableName: asyncAgentResultTable.name,
      asyncToolResultTableName: asyncToolResultTable.name,
      filesystemBucketName: filesystemBucket.name,
      skillsBucketName: skillsBucket.name,
    };
  },
});
