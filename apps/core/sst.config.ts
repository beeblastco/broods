/// <reference path="./.sst/platform/config.d.ts" />

// SST infrastructure for the account-managed harness: one streaming runtime Lambda and one account-management Lambda.
// AWS account + project identity for resource names, IAM role ARNs, and tags.
// No in-source defaults — provided via repo vars / local env (see .env.example).
// CI injects them into the validate + deploy jobs; forks must set them to run
// `sst install` / deploy.
const AWS_ACCOUNT_ID = requiredEnv("AWS_ACCOUNT_ID");
const PROJECT_NAME = requiredEnv("PROJECT_NAME");
const PROJECT_OWNER_EMAIL = requiredEnv("PROJECT_OWNER_EMAIL");
const AWS_PROFILE = process.env.CI ? undefined : (process.env.AWS_PROFILE ?? "default");
const ENABLE_DIRECT_API = parseBooleanEnv("ENABLE_DIRECT_API", false);
const ENABLE_WEBSOCKET = parseBooleanEnv("ENABLE_WEBSOCKET", false);
// Whether to import (vs first-create) the region-scoped sandbox ECR repo. The 4 image-based
// sandbox Lambdas this used to gate are gone — the "lambda" provider is now an AWS Lambda
// MicroVM (MicrovmSandboxExecutor) whose image is built from an S3 zip, not pulled from ECR.
// The ECR repo is retained transitionally (the lambda-sanbdox container image still publishes
// there); its teardown belongs to the Phase 4 infra cleanup. See docs/workspace/sandbox/lambda.md.
const SANDBOX_IMAGE_READY = parseBooleanEnv("SANDBOX_IMAGE_READY", false);
const NATS_URL = process.env.NATS_URL?.trim();
// Token-auth credential for the NATS server; omit for an unauthenticated server.
const NATS_TOKEN = process.env.NATS_TOKEN?.trim();
// OpenTelemetry OTLP push target for durable logs/traces (otel.beeblast.co,
// http/protobuf). The endpoint is 401-gated, so OTEL_EXPORTER_OTLP_HEADERS
// carries the `Authorization=Basic ...` credential. Both are injected via CI —
// no inline default. When unset, otel.ts no-ops and only stdout/NATS emit.
const OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
const OTEL_EXPORTER_OTLP_HEADERS = process.env.OTEL_EXPORTER_OTLP_HEADERS?.trim();
// Convex storage provider credentials. Always set for production; also set for
// any other stage (e.g. dev) that opts into Convex storage. When present the
// stage runs the Convex provider instead of DynamoDB (see `useConvexStorage`).
const CONVEX_URL = process.env.CONVEX_URL?.trim();
const CONVEX_DEPLOY_KEY = process.env.CONVEX_DEPLOY_KEY?.trim();
const DAYTONA_ORGANIZATION_ID = process.env.DAYTONA_ORGANIZATION_ID?.trim();
const DAYTONA_API_URL = process.env.DAYTONA_API_URL?.trim();
const DAYTONA_TARGET = process.env.DAYTONA_TARGET?.trim();
// Secrets formerly held in the SST secret store are now plain environment
// variables injected by CI from GitHub Actions secrets (see deploy.yaml). No
// `sst.Secret` indirection. Required ones use `!` (CI validates they are set
// before deploy); optional provider creds default to empty so stages that do
// not use them still deploy.
const ADMIN_ACCOUNT_SECRET = requiredEnv("ADMIN_ACCOUNT_SECRET");
const ACCOUNT_CONFIG_ENCRYPTION_SECRET = requiredEnv("ACCOUNT_CONFIG_ENCRYPTION_SECRET");
const SERVICE_AUTH_SECRET = process.env.SERVICE_AUTH_SECRET ?? "";
const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY ?? "";

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

  return "eu-west-1";
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

function resourceName(service: string, stage: string, region: string): string {
  const stagePrefix = isProductionStage(stage) ? "" : `${stage}-`;
  return `${stagePrefix}${PROJECT_NAME}-${service}-${AWS_ACCOUNT_ID}-${region}`;
}

function accountRegionalBucketName(service: string, stage: string, region: string): string {
  const name = `${resourceName(service, stage, region)}-an`;
  if (name.length > 63) {
    throw new Error(`S3 bucket name is too long (${name.length}/63): ${name}`);
  }
  return name;
}

function isProductionStage(stage: string): boolean {
  return stage === "production" || stage.startsWith("production-");
}

function microvmPrereqsEnabled(region: string): boolean {
  return region !== "ap-southeast-1";
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

function ecrRepositoryExists(name: string, region: string): boolean {
  try {
    const result = Bun.spawnSync({
      cmd: [
        "aws",
        "ecr",
        "describe-repositories",
        "--repository-names",
        name,
        "--region",
        region,
        "--output",
        "json",
      ],
      stdout: "ignore",
      stderr: "ignore",
    });
    return result.success;
  } catch {
    return false;
  }
}

const LAMBDA_ASSUME_ROLE = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "lambda.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
});

// SST's `permissions` shorthand -> a raw IAM policy doc. Used by the sandbox
// functions, which run from a pre-built ECR image and so can't use sst.aws.Function
// (it has no `image` arg and always builds a zip). $jsonStringify resolves Outputs.
function permissionsPolicy(perms: { actions: string[]; resources: $util.Input<string>[] }[]) {
  return $jsonStringify({
    Version: "2012-10-17",
    Statement: perms.map((p) => ({
      Effect: "Allow",
      Action: p.actions,
      Resource: p.resources,
    })),
  });
}

function denyUnlessProjectPrincipal(stage: string, region: string) {
  return {
    effect: "deny" as const,
    principals: "*" as const,
    actions: ["s3:*"],
    conditions: [
      {
        test: "StringNotLikeIfExists",
        variable: "aws:PrincipalArn",
        values: [
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/${PROJECT_NAME}-${stage}-AccountManageRole-*`,
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/${PROJECT_NAME}-${stage}-HarnessProcessingRole-*`,
          // Scoped role assumed by the harness for provider-sandbox mount-s3 credentials.
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/${resourceName("sandbox-s3mount", stage, region)}`,
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/${resourceName("microvm-build", stage, region)}`,
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/${resourceName("microvm-execution", stage, region)}`,
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/github-actions-aws-infra-deploy`,
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/github-actions-aws-sst-infra-deploy`,
          `arn:aws:iam::${AWS_ACCOUNT_ID}:root`,
        ],
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
      removal: isProductionStage(stage) ? "retain" : "remove",
      protect: isProductionStage(stage),
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
    // Production = SaaS = Convex storage. Other stages = DynamoDB (default).
    // Async tools, dedupe, conversations still rely on DDB until those modules
    // are lifted into the StorageProvider abstraction in a follow-up.
    const isProduction = isProductionStage(stage);
    const enableMicrovmPrereqs = microvmPrereqsEnabled(region);
    // Convex storage is used whenever Convex credentials are supplied: always on
    // production, and opt-in on any other stage (e.g. dev) by setting CONVEX_URL +
    // CONVEX_DEPLOY_KEY. Stages without them fall back to DynamoDB. When a stage
    // switches to Convex the per-account config tables below are dropped from the
    // desired state, so the deploy also removes those DynamoDB tables.
    const useConvexStorage = Boolean(CONVEX_URL && CONVEX_DEPLOY_KEY);
    if (isProduction && !useConvexStorage) {
      throw new Error("Production stage requires CONVEX_URL and CONVEX_DEPLOY_KEY env vars");
    }
    const storageEnv: Record<string, string> = useConvexStorage
      ? {
          STORAGE_PROVIDER: "convex",
          CONVEX_URL: CONVEX_URL!,
          CONVEX_DEPLOY_KEY: CONVEX_DEPLOY_KEY!,
        }
      : { STORAGE_PROVIDER: "dynamodb" };
    const names = {
      conversations: resourceName("conversations", stage, region),
      chatSdkState: resourceName("chat-sdk-state", stage, region),
      processedEvents: resourceName("processed-events", stage, region),
      asyncAgentResult: resourceName("async-agent-result", stage, region),
      asyncToolResult: resourceName("async-tool-result", stage, region),
      usage: resourceName("usage", stage, region),
      persistentSandboxInstance: resourceName("persistent-sandbox-instance", stage, region),
      accountConfigs: resourceName("account-configs", stage, region),
      agentConfigs: resourceName("agent-configs", stage, region),
      sandboxConfigs: resourceName("sandbox-configs", stage, region),
      workspaceConfigs: resourceName("workspace-configs", stage, region),
      accountTools: resourceName("account-tools", stage, region),
      accountSignupRateLimits: resourceName("account-signup-rate-limits", stage, region),
      crons: resourceName("crons", stage, region),
      cronSchedules: resourceName("cron-schedules", stage, region),
      harnessProcessing: resourceName("harness-processing", stage, region),
      accountManage: resourceName("account-manage", stage, region),
      filesystem: accountRegionalBucketName("filesystem", stage, region),
      skills: accountRegionalBucketName("skills", stage, region),
      toolBundles: accountRegionalBucketName("tool-bundles", stage, region),
      microvmArtifacts: accountRegionalBucketName("microvm-artifacts", stage, region),
      microvmBuildRole: resourceName("microvm-build", stage, region),
      microvmExecutionRole: resourceName("microvm-execution", stage, region),
    };

    // ADMIN_ACCOUNT_SECRET, ACCOUNT_CONFIG_ENCRYPTION_SECRET, SERVICE_AUTH_SECRET, and
    // DAYTONA_API_KEY are read from the environment above (CI-injected) — no
    // `sst.Secret` resources.

    // accounts / agents / crons DDB tables are skipped on production —
    // those domains live in Convex on SaaS. Tables stay for dev / community
    // stages so the DynamoDB provider has somewhere to read/write.
    const accountConfigsTable = useConvexStorage
      ? null
      : new sst.aws.Dynamo("AccountConfig", {
          fields: {
            accountId: "string",
            secretHash: "string",
          },
          primaryIndex: { hashKey: "accountId" },
          globalIndexes: {
            SecretHashIndex: { hashKey: "secretHash" },
          },
          deletionProtection: false,
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
      deletionProtection: isProduction,
      transform: {
        table: {
          name: names.accountSignupRateLimits,
        },
      },
    });

    const agentConfigsTable = useConvexStorage
      ? null
      : new sst.aws.Dynamo("AgentConfig", {
          fields: {
            accountId: "string",
            agentId: "string",
          },
          primaryIndex: { hashKey: "accountId", rangeKey: "agentId" },
          deletionProtection: false,
          transform: {
            table: {
              name: names.agentConfigs,
            },
          },
        });

    // Account-scoped, reusable sandbox / workspace config records. Like agents,
    // these live in Convex on production and DynamoDB elsewhere.
    const sandboxConfigsTable = useConvexStorage
      ? null
      : new sst.aws.Dynamo("SandboxConfig", {
          fields: {
            accountId: "string",
            sandboxId: "string",
          },
          primaryIndex: { hashKey: "accountId", rangeKey: "sandboxId" },
          deletionProtection: false,
          transform: {
            table: {
              name: names.sandboxConfigs,
            },
          },
        });

    const workspaceConfigsTable = useConvexStorage
      ? null
      : new sst.aws.Dynamo("WorkspaceConfig", {
          fields: {
            accountId: "string",
            workspaceId: "string",
          },
          primaryIndex: { hashKey: "accountId", rangeKey: "workspaceId" },
          deletionProtection: false,
          transform: {
            table: {
              name: names.workspaceConfigs,
            },
          },
        });

    const accountToolsTable = useConvexStorage
      ? null
      : new sst.aws.Dynamo("AccountTool", {
          fields: {
            accountId: "string",
            toolId: "string",
          },
          primaryIndex: { hashKey: "accountId", rangeKey: "toolId" },
          deletionProtection: false,
          transform: {
            table: {
              name: names.accountTools,
            },
          },
        });

    const cronsTable = useConvexStorage
      ? null
      : new sst.aws.Dynamo("Cron", {
          fields: {
            accountId: "string",
            cronId: "string",
          },
          primaryIndex: { hashKey: "accountId", rangeKey: "cronId" },
          deletionProtection: false,
          transform: {
            table: {
              name: names.crons,
            },
          },
        });

    const conversationsTable = new sst.aws.Dynamo("Conversations", {
      fields: {
        conversationKey: "string",
        createdAt: "string",
      },
      primaryIndex: { hashKey: "conversationKey", rangeKey: "createdAt" },
      deletionProtection: isProduction,
      transform: {
        table: {
          name: names.conversations,
        },
      },
    });

    const chatSdkStateTable = new sst.aws.Dynamo("ChatSdkState", {
      fields: {
        pk: "string",
        sk: "string",
      },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
      ttl: "expiresAt",
      deletionProtection: isProduction,
      transform: {
        table: {
          name: names.chatSdkState,
        },
      },
    });

    const processedEventsTable = new sst.aws.Dynamo("ProcessedEvents", {
      fields: {
        eventId: "string",
      },
      primaryIndex: { hashKey: "eventId" },
      ttl: "expiresAt",
      deletionProtection: isProduction,
      transform: {
        table: {
          name: names.processedEvents,
        },
      },
    });

    // Per-task + rollup usage metering for DynamoDB-mode (OSS/self-host)
    // deployments only; Convex-mode stages meter through the Convex provider, so
    // this table (and USAGE_TABLE_NAME) is absent there. Composite pk/sk:
    // pk=ACCOUNT#<id>, sk=TASK#<taskId> or ROLLUP#<agent>#<provider>#<model>#<bucket>.
    const usageTable = useConvexStorage
      ? null
      : new sst.aws.Dynamo("Usage", {
          fields: {
            pk: "string",
            sk: "string",
          },
          primaryIndex: { hashKey: "pk", rangeKey: "sk" },
          deletionProtection: isProduction,
          transform: {
            table: {
              name: names.usage,
            },
          },
        });

    const asyncAgentResultTable = new sst.aws.Dynamo("AsyncAgentResult", {
      fields: {
        eventId: "string",
      },
      primaryIndex: { hashKey: "eventId" },
      ttl: "expiresAt",
      deletionProtection: isProduction,
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
      deletionProtection: isProduction,
      transform: {
        table: {
          name: names.asyncToolResult,
        },
      },
    });
    // Maps a workspace namespace -> the long-lived (reserved) provider sandbox
    // reserved for it, so a later request reconnects instead of recreating.
    const persistentSandboxInstanceTable = new sst.aws.Dynamo("PersistentSandboxInstance", {
      fields: {
        instanceKey: "string",
      },
      primaryIndex: { hashKey: "instanceKey" },
      ttl: "expiresAt",
      deletionProtection: isProduction,
      transform: {
        table: {
          name: names.persistentSandboxInstance,
        },
      },
    });
    const filesystemBucketArn = `arn:aws:s3:::${names.filesystem}`;
    const skillsBucketArn = `arn:aws:s3:::${names.skills}`;
    const toolBundlesBucketArn = `arn:aws:s3:::${names.toolBundles}`;
    const microvmArtifactsBucketArn = `arn:aws:s3:::${names.microvmArtifacts}`;
    const filesystemBucket = new sst.aws.Bucket("Filesystem", {
      versioning: true,
      policy: [denyUnlessProjectPrincipal(stage, region)],
      transform: {
        bucket: {
          bucket: names.filesystem,
          bucketNamespace: "account-regional",
        },
        publicAccessBlock: {
          blockPublicAcls: true,
          ignorePublicAcls: false,
          blockPublicPolicy: true,
          restrictPublicBuckets: true,
        },
      },
    });

    const skillsBucket = new sst.aws.Bucket("Skills", {
      versioning: true,
      policy: [denyUnlessProjectPrincipal(stage, region)],
      transform: {
        bucket: {
          bucket: names.skills,
          bucketNamespace: "account-regional",
        },
        publicAccessBlock: {
          blockPublicAcls: true,
          ignorePublicAcls: true,
          blockPublicPolicy: true,
          restrictPublicBuckets: true,
        },
      },
    });

    const toolBundlesBucket = new sst.aws.Bucket("ToolBundles", {
      versioning: true,
      policy: [denyUnlessProjectPrincipal(stage, region)],
      transform: {
        bucket: {
          bucket: names.toolBundles,
          bucketNamespace: "account-regional",
        },
        publicAccessBlock: {
          blockPublicAcls: true,
          ignorePublicAcls: true,
          blockPublicPolicy: true,
          restrictPublicBuckets: true,
        },
      },
    });

    const microvmArtifactsBucket = enableMicrovmPrereqs
      ? new sst.aws.Bucket("MicrovmArtifacts", {
          versioning: true,
          policy: [denyUnlessProjectPrincipal(stage, region)],
          transform: {
            bucket: {
              bucket: names.microvmArtifacts,
              bucketNamespace: "account-regional",
            },
            publicAccessBlock: {
              blockPublicAcls: true,
              ignorePublicAcls: true,
              blockPublicPolicy: true,
              restrictPublicBuckets: true,
            },
          },
        })
      : null;

    const microvmRoleTrustPolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
          Action: "sts:AssumeRole",
          Condition: {
            StringEquals: {
              "aws:SourceAccount": AWS_ACCOUNT_ID,
            },
            ArnLike: {
              "aws:SourceArn": [
                `arn:aws:lambda:${region}:${AWS_ACCOUNT_ID}:microvm-image:*`,
                `arn:aws:lambda:${region}:${AWS_ACCOUNT_ID}:microvm-image/*`,
              ],
            },
          },
        },
      ],
    });

    const microvmBuildRole = enableMicrovmPrereqs
      ? new aws.iam.Role("MicrovmBuildRole", {
          name: names.microvmBuildRole,
          assumeRolePolicy: microvmRoleTrustPolicy,
        })
      : null;

    if (microvmBuildRole) {
      new aws.iam.RolePolicy("MicrovmBuildRolePolicy", {
        role: microvmBuildRole.id,
        policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "ReadMicrovmArtifacts",
              Effect: "Allow",
              Action: ["s3:GetObject"],
              Resource: [`${microvmArtifactsBucketArn}/microvm-images/*`],
            },
            {
              Sid: "WriteMicrovmBuildLogs",
              Effect: "Allow",
              Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
              Resource: [`arn:aws:logs:${region}:${AWS_ACCOUNT_ID}:log-group:/aws/lambda-microvms/*`],
            },
            {
              Sid: "PullPrivateEcrBaseImages",
              Effect: "Allow",
              Action: ["ecr:GetAuthorizationToken"],
              Resource: ["*"],
            },
            {
              Sid: "PullPrivateEcrLayers",
              Effect: "Allow",
              Action: ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
              Resource: [`arn:aws:ecr:${region}:${AWS_ACCOUNT_ID}:repository/*`],
            },
          ],
        }),
      });
    }

    const microvmExecutionRole = enableMicrovmPrereqs
      ? new aws.iam.Role("MicrovmExecutionRole", {
          name: names.microvmExecutionRole,
          assumeRolePolicy: microvmRoleTrustPolicy,
        })
      : null;

    if (microvmExecutionRole) {
      new aws.iam.RolePolicy("MicrovmExecutionRolePolicy", {
        role: microvmExecutionRole.id,
        policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "WriteMicrovmRuntimeLogs",
              Effect: "Allow",
              Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
              Resource: [`arn:aws:logs:${region}:${AWS_ACCOUNT_ID}:log-group:/aws/lambda-microvms/*`],
            },
          ],
        }),
      });
    }

    // Sandbox VPC. Its former consumers (the S3 Files NFS mount targets and the 4-stage
    // sandbox Lambdas) were removed in the MicroVM cutover: MicroVMs mount S3 with mount-s3
    // over default internet egress, needing no VPC for the common path. It is retained for
    // the restricted/deny-all egress mode, which will attach a VPC egress network connector
    // (lambda-core create-network-connector). The fck-nat EC2 instance was removed in the
    // Phase 4 teardown, so the VPC has no NAT; the future egress connector handles
    // restricted/deny-all egress, and the common path mounts S3 over default internet egress.
    const sandboxNetwork = new sst.aws.Vpc.v1("SandboxNetwork", {
      az: 2, // 2 az same price of 1 az.
    });

    // Scoped credentials for provider sandboxes that mount S3 with mount-s3
    // (daytona, workdir, and the lambda MicroVM via its /run hook). The harness assumes
    // this role per sandbox create and hands the short-lived, prefix-scoped session
    // credentials to the sandbox instead of its own runtime credentials, so sandbox
    // code can only reach the workspace/skills buckets.
    const sandboxS3MountRole = new aws.iam.Role("SandboxS3MountRole", {
      name: resourceName("sandbox-s3mount", stage, region),
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowHarnessAssumeRole",
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${AWS_ACCOUNT_ID}:root` },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });

    new aws.iam.RolePolicy("SandboxS3MountRolePolicy", {
      role: sandboxS3MountRole.id,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"],
            Resource: [`${filesystemBucketArn}/*`],
          },
          {
            Effect: "Allow",
            Action: ["s3:ListBucket"],
            Resource: [filesystemBucketArn],
          },
          {
            Effect: "Allow",
            Action: ["s3:GetObject"],
            Resource: [`${skillsBucketArn}/*`],
          },
          {
            Effect: "Allow",
            Action: ["s3:ListBucket"],
            Resource: [skillsBucketArn],
          },
        ],
      }),
    });

    // This app owns the sandbox image ECR repo (moved out of the infra Terraform repo) so
    // the repo lifecycle stays in sync with the functions that consume it — no cross-repo
    // coordination. Lambda pulls only from PRIVATE ECR in its own region (public.ecr.aws is
    // rejected), so the repo is region-scoped: each deploy region gets its own. The arm64
    // image is pushed by the lambda-just-bash-rust CI; for a brand-new region that push must
    // land before the sandbox functions can be created (the first deploy creates the empty
    // repo, then re-deploy once the image exists). See docs/workspace/sandbox/lambda.md.
    const sandboxImageRepoName = `beeblast-lambda-sandbox-${AWS_ACCOUNT_ID}-${region}`;
    const sandboxImageRepoExists = ecrRepositoryExists(sandboxImageRepoName, region);
    const sandboxImageRepoShouldImport = SANDBOX_IMAGE_READY || sandboxImageRepoExists;
    const sandboxEcr = new aws.ecr.Repository(
      "SandboxImage",
      {
        name: sandboxImageRepoName,
        imageTagMutability: "MUTABLE",
        imageScanningConfiguration: { scanOnPush: true },
        forceDelete: !isProduction,
      },
      {
        retainOnDelete: isProduction,
        // The repo name is intentionally not PROJECT_NAME-scoped (the external lambda-sanbdox
        // CI pushes `latest-arm64` to this exact name). When SANDBOX_IMAGE_READY is true,
        // the deploy workflow has already ensured the regional repo exists, so import it
        // even if the local describe probe cannot run from inside SST config evaluation.
        ...(sandboxImageRepoShouldImport ? { import: sandboxImageRepoName } : {}),
      },
    );

    // Wide pull mirrors the prior infra policy. Same-account Lambda pulls work without it;
    // cross-account consumers (daytona sandbox provider) rely on it.
    new aws.ecr.RepositoryPolicy("SandboxImagePolicy", {
      repository: sandboxEcr.name,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowCrossAccountPull",
            Effect: "Allow",
            Principal: "*",
            Action: ["ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:BatchCheckLayerAvailability"],
          },
        ],
      }),
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
        ...storageEnv,
        CONVERSATIONS_TABLE_NAME: conversationsTable.name,
        CHAT_SDK_STATE_TABLE_NAME: chatSdkStateTable.name,
        PROCESSED_EVENTS_TABLE_NAME: processedEventsTable.name,
        ASYNC_AGENT_RESULT_TABLE_NAME: asyncAgentResultTable.name,
        ASYNC_TOOL_RESULT_TABLE_NAME: asyncToolResultTable.name,
        PERSISTENT_SANDBOX_INSTANCE_TABLE_NAME: persistentSandboxInstanceTable.name,
        ...(accountConfigsTable ? { ACCOUNT_CONFIGS_TABLE_NAME: accountConfigsTable.name } : {}),
        ...(agentConfigsTable ? { AGENT_CONFIGS_TABLE_NAME: agentConfigsTable.name } : {}),
        ...(sandboxConfigsTable ? { SANDBOX_CONFIGS_TABLE_NAME: sandboxConfigsTable.name } : {}),
        ...(workspaceConfigsTable ? { WORKSPACE_CONFIGS_TABLE_NAME: workspaceConfigsTable.name } : {}),
        ...(accountToolsTable ? { ACCOUNT_TOOLS_TABLE_NAME: accountToolsTable.name } : {}),
        ACCOUNT_SECRET_INDEX_NAME: "SecretHashIndex",
        ACCOUNT_CONFIG_ENCRYPTION_SECRET,
        SERVICE_AUTH_SECRET,
        FILESYSTEM_BUCKET_NAME: names.filesystem,
        SKILLS_BUCKET_NAME: names.skills,
        TOOL_BUNDLES_BUCKET_NAME: names.toolBundles,
        ...(microvmBuildRole && microvmExecutionRole
          ? {
              MICROVM_ARTIFACTS_BUCKET_NAME: names.microvmArtifacts,
              MICROVM_BUILD_ROLE_ARN: microvmBuildRole.arn,
              MICROVM_EXECUTION_ROLE_ARN: microvmExecutionRole.arn,
              // The "lambda" sandbox provider (MicrovmSandboxExecutor) runs MicroVMs from
              // this image. The ARN is name-based and deterministic, so it is valid before
              // the image exists; the lambda-sanbdox microvm-image CI publishes the image
              // under this exact name (its MICROVM_IMAGE_NAME default). Omit
              // MICROVM_IMAGE_VERSION so RunMicrovm resolves the ACTIVE version. Restricted/
              // deny-all egress additionally needs a VPC egress connector ARN in
              // MICROVM_EGRESS_NETWORK_CONNECTOR_ARN (provisioned later).
              MICROVM_IMAGE_IDENTIFIER: `arn:aws:lambda:${region}:${AWS_ACCOUNT_ID}:microvm-image:lambda-microvm-agent-sandbox`,
            }
          : {}),
        ENABLE_DIRECT_API: ENABLE_DIRECT_API ? "true" : "false",
        ENABLE_WEBSOCKET: ENABLE_WEBSOCKET ? "true" : "false",
        ...(cronsTable ? { CRONS_TABLE_NAME: cronsTable.name } : {}),
        ...(NATS_URL ? { NATS_URL } : {}),
        ...(NATS_TOKEN ? { NATS_TOKEN } : {}),
        ...(OTEL_EXPORTER_OTLP_ENDPOINT ? { OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
        ...(OTEL_EXPORTER_OTLP_HEADERS ? { OTEL_EXPORTER_OTLP_HEADERS } : {}),
        ...(usageTable ? { USAGE_TABLE_NAME: usageTable.name } : {}),
        DAYTONA_API_KEY,
        SANDBOX_MOUNT_ROLE_ARN: sandboxS3MountRole.arn,
        ...(DAYTONA_ORGANIZATION_ID ? { DAYTONA_ORGANIZATION_ID } : {}),
        ...(DAYTONA_API_URL ? { DAYTONA_API_URL } : {}),
        ...(DAYTONA_TARGET ? { DAYTONA_TARGET } : {}),
      },
      permissions: [
        {
          actions: ["sts:AssumeRole"],
          resources: [sandboxS3MountRole.arn],
        },
        {
          actions: ["kms:Decrypt"],
          resources: ["*"],
        },
        ...(accountConfigsTable
          ? [
              {
                actions: ["dynamodb:GetItem", "dynamodb:Query"],
                resources: [accountConfigsTable.arn, $interpolate`${accountConfigsTable.arn}/index/SecretHashIndex`],
              },
            ]
          : []),
        ...(agentConfigsTable
          ? [
              {
                actions: ["dynamodb:GetItem", "dynamodb:Query"],
                resources: [agentConfigsTable.arn],
              },
            ]
          : []),
        ...(sandboxConfigsTable
          ? [
              {
                actions: ["dynamodb:GetItem", "dynamodb:Query"],
                resources: [sandboxConfigsTable.arn],
              },
            ]
          : []),
        ...(workspaceConfigsTable
          ? [
              {
                actions: ["dynamodb:GetItem", "dynamodb:Query"],
                resources: [workspaceConfigsTable.arn],
              },
            ]
          : []),
        ...(accountToolsTable
          ? [
              {
                actions: ["dynamodb:GetItem", "dynamodb:Query"],
                resources: [accountToolsTable.arn],
              },
            ]
          : []),
        {
          actions: [
            "dynamodb:BatchWriteItem",
            "dynamodb:GetItem",
            "dynamodb:Query",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
          ],
          resources: [conversationsTable.arn, processedEventsTable.arn, chatSdkStateTable.arn],
        },
        {
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
          resources: [asyncAgentResultTable.arn],
        },
        {
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"],
          resources: [asyncToolResultTable.arn],
        },
        {
          actions: ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"],
          resources: [persistentSandboxInstanceTable.arn],
        },
        ...(cronsTable
          ? [
              {
                actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
                resources: [cronsTable.arn],
              },
            ]
          : []),
        ...(usageTable
          ? [
              {
                actions: ["dynamodb:PutItem", "dynamodb:UpdateItem"],
                resources: [usageTable.arn],
              },
            ]
          : []),
        {
          // Self-invoke (async worker) + read its own Function URL so background
          // jobs know where to POST their completion callback.
          actions: ["lambda:InvokeFunction", "lambda:GetFunctionUrlConfig"],
          resources: [`arn:aws:lambda:${region}:${AWS_ACCOUNT_ID}:function:${names.harnessProcessing}`],
        },
        ...(microvmBuildRole && microvmExecutionRole
          ? [
              {
                actions: [
                  "lambda:CreateMicrovmImage",
                  "lambda:UpdateMicrovmImage",
                  "lambda:DeleteMicrovmImage",
                  "lambda:DeleteMicrovmImageVersion",
                  "lambda:GetMicrovmImage",
                  "lambda:ListMicrovmImages",
                  "lambda:ListMicrovmImageVersions",
                  "lambda:ListMicrovmImageBuilds",
                  "lambda:RunMicrovm",
                  "lambda:GetMicrovm",
                  "lambda:ListMicrovms",
                  "lambda:SuspendMicrovm",
                  "lambda:ResumeMicrovm",
                  "lambda:TerminateMicrovm",
                  "lambda:CreateMicrovmAuthToken",
                  "lambda:CreateMicrovmShellAuthToken",
                ],
                resources: [
                  `arn:aws:lambda:${region}:${AWS_ACCOUNT_ID}:microvm-image:*`,
                  `arn:aws:lambda:${region}:${AWS_ACCOUNT_ID}:microvm:*`,
                ],
              },
              {
                actions: ["lambda:PassNetworkConnector"],
                resources: [
                  `arn:aws:lambda:${region}:aws:network-connector:aws-network-connector:*`,
                  `arn:aws:lambda:${region}:${AWS_ACCOUNT_ID}:network-connector:*`,
                ],
              },
              {
                actions: ["iam:PassRole"],
                resources: [microvmBuildRole.arn, microvmExecutionRole.arn],
              },
            ]
          : []),
        {
          actions: ["s3:GetObject", "s3:HeadObject", "s3:PutObject", "s3:DeleteObject"],
          resources: [`${filesystemBucketArn}/*`],
        },
        {
          actions: ["s3:ListBucket"],
          resources: [filesystemBucketArn],
        },
        {
          actions: ["s3:GetObject", "s3:HeadObject", "s3:PutObject", "s3:DeleteObject"],
          resources: [`${skillsBucketArn}/*`],
        },
        {
          actions: ["s3:ListBucket"],
          resources: [skillsBucketArn],
        },
        {
          actions: ["s3:GetObject", "s3:HeadObject"],
          resources: [`${toolBundlesBucketArn}/*`],
        },
        {
          actions: ["s3:ListBucket"],
          resources: [toolBundlesBucketArn],
        },
        ...(microvmArtifactsBucket
          ? [
              {
                actions: ["s3:GetObject", "s3:HeadObject", "s3:PutObject", "s3:DeleteObject"],
                resources: [`${microvmArtifactsBucketArn}/microvm-images/*`],
              },
              {
                actions: ["s3:ListBucket"],
                resources: [microvmArtifactsBucketArn],
              },
            ]
          : []),
      ],
    });

    const cronScheduleGroup = new aws.scheduler.ScheduleGroup("CronScheduleGroup", {
      name: names.cronSchedules,
    });

    const cronSchedulerRole = new aws.iam.Role("CronSchedulerRole", {
      name: resourceName("cron-scheduler", stage, region),
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "scheduler.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });

    new aws.iam.RolePolicy("CronSchedulerRolePolicy", {
      role: cronSchedulerRole.id,
      policy: harnessProcessing.arn.apply((arn) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["lambda:InvokeFunction"],
              Resource: [arn],
            },
          ],
        }),
      ),
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
        ...storageEnv,
        ...(accountConfigsTable ? { ACCOUNT_CONFIGS_TABLE_NAME: accountConfigsTable.name } : {}),
        ...(agentConfigsTable ? { AGENT_CONFIGS_TABLE_NAME: agentConfigsTable.name } : {}),
        ...(sandboxConfigsTable ? { SANDBOX_CONFIGS_TABLE_NAME: sandboxConfigsTable.name } : {}),
        ...(workspaceConfigsTable ? { WORKSPACE_CONFIGS_TABLE_NAME: workspaceConfigsTable.name } : {}),
        ...(accountToolsTable ? { ACCOUNT_TOOLS_TABLE_NAME: accountToolsTable.name } : {}),
        ACCOUNT_SECRET_INDEX_NAME: "SecretHashIndex",
        CONVERSATIONS_TABLE_NAME: conversationsTable.name,
        CHAT_SDK_STATE_TABLE_NAME: chatSdkStateTable.name,
        PROCESSED_EVENTS_TABLE_NAME: processedEventsTable.name,
        ASYNC_AGENT_RESULT_TABLE_NAME: asyncAgentResultTable.name,
        ASYNC_TOOL_RESULT_TABLE_NAME: asyncToolResultTable.name,
        PERSISTENT_SANDBOX_INSTANCE_TABLE_NAME: persistentSandboxInstanceTable.name,
        FILESYSTEM_BUCKET_NAME: names.filesystem,
        SKILLS_BUCKET_NAME: names.skills,
        TOOL_BUNDLES_BUCKET_NAME: names.toolBundles,
        ...(microvmArtifactsBucket ? { MICROVM_ARTIFACTS_BUCKET_NAME: names.microvmArtifacts } : {}),
        ACCOUNT_SIGNUP_RATE_LIMIT_TABLE_NAME: accountSignupRateLimitTable.name,
        ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR: "5",
        ADMIN_ACCOUNT_SECRET,
        ACCOUNT_CONFIG_ENCRYPTION_SECRET,
        SERVICE_AUTH_SECRET,
        ...(NATS_URL ? { NATS_URL } : {}),
        ...(NATS_TOKEN ? { NATS_TOKEN } : {}),
        ...(OTEL_EXPORTER_OTLP_ENDPOINT ? { OTEL_EXPORTER_OTLP_ENDPOINT } : {}),
        ...(OTEL_EXPORTER_OTLP_HEADERS ? { OTEL_EXPORTER_OTLP_HEADERS } : {}),
        ...(cronsTable ? { CRONS_TABLE_NAME: cronsTable.name } : {}),
        CRON_SCHEDULER_TARGET_FUNCTION_ARN: harnessProcessing.arn,
        CRON_SCHEDULER_ROLE_ARN: cronSchedulerRole.arn,
        CRON_SCHEDULER_GROUP_NAME: cronScheduleGroup.name,
      },
      permissions: [
        ...(accountConfigsTable
          ? [
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
            ]
          : []),
        ...(agentConfigsTable
          ? [
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
            ]
          : []),
        ...(sandboxConfigsTable
          ? [
              {
                actions: [
                  "dynamodb:DeleteItem",
                  "dynamodb:GetItem",
                  "dynamodb:PutItem",
                  "dynamodb:Query",
                  "dynamodb:UpdateItem",
                ],
                resources: [sandboxConfigsTable.arn],
              },
            ]
          : []),
        ...(workspaceConfigsTable
          ? [
              {
                actions: [
                  "dynamodb:DeleteItem",
                  "dynamodb:GetItem",
                  "dynamodb:PutItem",
                  "dynamodb:Query",
                  "dynamodb:UpdateItem",
                ],
                resources: [workspaceConfigsTable.arn],
              },
            ]
          : []),
        ...(accountToolsTable
          ? [
              {
                actions: [
                  "dynamodb:DeleteItem",
                  "dynamodb:GetItem",
                  "dynamodb:PutItem",
                  "dynamodb:Query",
                  "dynamodb:UpdateItem",
                ],
                resources: [accountToolsTable.arn],
              },
            ]
          : []),
        ...(cronsTable
          ? [
              {
                actions: [
                  "dynamodb:DeleteItem",
                  "dynamodb:GetItem",
                  "dynamodb:PutItem",
                  "dynamodb:Query",
                  "dynamodb:UpdateItem",
                ],
                resources: [cronsTable.arn],
              },
            ]
          : []),
        {
          // Read + drop reserved-sandbox instance rows when releasing on delete.
          actions: ["dynamodb:GetItem", "dynamodb:DeleteItem"],
          resources: [persistentSandboxInstanceTable.arn],
        },
        {
          actions: ["scheduler:CreateSchedule", "scheduler:DeleteSchedule", "scheduler:UpdateSchedule"],
          resources: [$interpolate`arn:aws:scheduler:${region}:${AWS_ACCOUNT_ID}:schedule/${cronScheduleGroup.name}/*`],
        },
        {
          actions: ["iam:PassRole"],
          resources: [cronSchedulerRole.arn],
        },
        {
          actions: ["dynamodb:BatchWriteItem", "dynamodb:DeleteItem", "dynamodb:Scan"],
          resources: [
            conversationsTable.arn,
            chatSdkStateTable.arn,
            processedEventsTable.arn,
            asyncAgentResultTable.arn,
            asyncToolResultTable.arn,
          ],
        },
        {
          actions: ["dynamodb:UpdateItem"],
          resources: [accountSignupRateLimitTable.arn],
        },
        {
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          resources: [`${filesystemBucketArn}/*`],
        },
        {
          actions: ["s3:ListBucket"],
          resources: [filesystemBucketArn],
        },
        {
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          resources: [`${skillsBucketArn}/*`],
        },
        {
          actions: ["s3:ListBucket"],
          resources: [skillsBucketArn],
        },
        {
          actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          resources: [`${toolBundlesBucketArn}/*`],
        },
        {
          actions: ["s3:ListBucket"],
          resources: [toolBundlesBucketArn],
        },
        ...(microvmArtifactsBucket
          ? [
              {
                actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
                resources: [`${microvmArtifactsBucketArn}/microvm-images/*`],
              },
              {
                actions: ["s3:ListBucket"],
                resources: [microvmArtifactsBucketArn],
              },
            ]
          : []),
      ],
    });

    return {
      agentServiceUrl: harnessProcessing.url,
      accountServiceUrl: accountManage.url,
      accountConfigsTableName: accountConfigsTable?.name,
      agentConfigsTableName: agentConfigsTable?.name,
      sandboxConfigsTableName: sandboxConfigsTable?.name,
      workspaceConfigsTableName: workspaceConfigsTable?.name,
      accountToolsTableName: accountToolsTable?.name,
      cronsTableName: cronsTable?.name,
      accountSignupRateLimitTableName: accountSignupRateLimitTable.name,
      conversationsTableName: conversationsTable.name,
      processedEventsTableName: processedEventsTable.name,
      asyncAgentResultTableName: asyncAgentResultTable.name,
      asyncToolResultTableName: asyncToolResultTable.name,
      cronScheduleGroupName: cronScheduleGroup.name,
      filesystemBucketName: filesystemBucket.name,
      skillsBucketName: skillsBucket.name,
      toolBundlesBucketName: toolBundlesBucket.name,
      microvmArtifactsBucketName: microvmArtifactsBucket?.name,
      microvmBuildRoleArn: microvmBuildRole?.arn,
      microvmExecutionRoleArn: microvmExecutionRole?.arn,
    };
  },
});
