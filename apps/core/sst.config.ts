/// <reference path="./.sst/platform/config.d.ts" />

// SST provisions the AWS data plane, container runtime IAM user, and cron API destination.
// The runtime itself is the Bun container deployed from the infra repo.
// AWS account + project identity for resource names, IAM role ARNs, and tags.
// No in-source defaults — provided via repo vars / local env (see .env.example).
// CI injects them into the validate + deploy jobs; forks must set them to run
// `sst install` / deploy.
const AWS_ACCOUNT_ID = requiredEnv("AWS_ACCOUNT_ID");
const PROJECT_NAME = requiredEnv("PROJECT_NAME");
const PROJECT_OWNER_EMAIL = requiredEnv("PROJECT_OWNER_EMAIL");
const AWS_PROFILE = process.env.CI ? undefined : (process.env.AWS_PROFILE ?? "default");
// Whether to import (vs first-create) the region-scoped sandbox ECR repo. The 4 image-based
// sandbox Lambdas this used to gate are gone — the "lambda" provider is now an AWS Lambda
// MicroVM (MicrovmSandboxExecutor) whose image is built from an S3 zip, not pulled from ECR.
// The ECR repo is retained transitionally (the lambda-sanbdox container image still publishes
// there); its teardown belongs to the Phase 4 infra cleanup. See docs/workspace/sandbox/lambda.md.
const SANDBOX_IMAGE_READY = parseBooleanEnv("SANDBOX_IMAGE_READY", false);
// Convex storage provider credentials. Always set for production; also set for
// any other stage (e.g. dev) that opts into Convex storage. When present the
// stage skips the per-account DynamoDB config tables (see `useConvexStorage`).
// Runtime credentials live on the container (infra repo), not here.
const CONVEX_URL = process.env.CONVEX_URL?.trim();
const CONVEX_DEPLOY_KEY = process.env.CONVEX_DEPLOY_KEY?.trim();
// Service token shared with the core container; the EventBridge cron connection
// sends it as the Authorization bearer so core accepts the cron POSTs.
const SERVICE_AUTH_SECRET = requiredEnv("SERVICE_AUTH_SECRET");
// Public base URL of the gateway (e.g. https://gateway.broods.app). EventBridge
// cron API destination POSTs to `${PUBLIC_BASE_URL}/v1/cron-runs`, and the
// container reads the same value at runtime for callbacks/status URLs.
const PUBLIC_BASE_URL = requiredEnv("PUBLIC_BASE_URL");

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

// SST's `permissions` shorthand -> a raw IAM policy doc, for the container
// runtime user and the Convex config-plane role. $jsonStringify resolves Outputs.
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
          // Scoped role assumed by the harness for provider-sandbox mount-s3 credentials.
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/${resourceName("sandbox-s3mount", stage, region)}`,
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/${resourceName("microvm-build", stage, region)}`,
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/${resourceName("microvm-execution", stage, region)}`,
          // Self-hosted container runtime user (epic #85 phase 9a) — without
          // this entry every pod S3 call gets an explicit deny.
          `arn:aws:iam::${AWS_ACCOUNT_ID}:user/${resourceName("core-runtime", stage, region)}`,
          // Convex config-plane role (epic #85 phase 9) — Convex node actions own
          // the skills/tool-bundle/workspace S3 objects directly after assuming it.
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/${resourceName("convex-aws", stage, region)}`,
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/github-actions-ecr-push`,
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
      agentPolicies: resourceName("agent-policies", stage, region),
      accountTools: resourceName("account-tools", stage, region),
      crons: resourceName("crons", stage, region),
      cronSchedules: resourceName("cron-schedules", stage, region),
      filesystem: accountRegionalBucketName("filesystem", stage, region),
      skills: accountRegionalBucketName("skills", stage, region),
      toolBundles: accountRegionalBucketName("tool-bundles", stage, region),
      microvmArtifacts: accountRegionalBucketName("microvm-artifacts", stage, region),
      microvmBuildRole: resourceName("microvm-build", stage, region),
      microvmExecutionRole: resourceName("microvm-execution", stage, region),
    };

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

    const agentPoliciesTable = useConvexStorage
      ? null
      : new sst.aws.Dynamo("AgentPolicy", {
          fields: {
            accountId: "string",
            policyId: "string",
          },
          primaryIndex: { hashKey: "accountId", rangeKey: "policyId" },
          deletionProtection: false,
          transform: {
            table: {
              name: names.agentPolicies,
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
    const microvmLogGroupName = `/broods/${stage}/microvms`;
    if (enableMicrovmPrereqs) {
      new aws.cloudwatch.LogGroup("MicrovmRuntimeLogGroup", {
        name: microvmLogGroupName,
        retentionInDays: 30,
      });
    }

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
              Resource: [
                `arn:aws:logs:${region}:${AWS_ACCOUNT_ID}:log-group:${microvmLogGroupName}`,
                `arn:aws:logs:${region}:${AWS_ACCOUNT_ID}:log-group:${microvmLogGroupName}:*`,
              ],
            },
          ],
        }),
      });
    }

    // No sandbox VPC. The MicroVM `lambda` provider runs on default INTERNET_EGRESS and
    // mounts S3 with mount-s3 (Mountpoint-for-S3 + scoped STS creds) over that egress, so
    // the common path needs no VPC. The old S3 Files NFS mount targets and the 4-stage
    // sandbox Lambdas (the only former consumers) were removed in the MicroVM cutover.
    //
    // The previous `sst.aws.Vpc.v1("SandboxNetwork")` was dead-but-billable: it had no
    // consumers, yet Vpc.v1 always provisions a managed NAT gateway + EIP per AZ (~$65/mo
    // each, ~$130/mo per stage) with no way to opt out. Removing it deletes those NATs.
    //
    // When restricted/deny-all egress is actually implemented (lambda-core
    // create-network-connector), reintroduce a purpose-built VPC then: `sst.aws.Vpc` (v2,
    // NAT-less by default) plus a *free* S3 Gateway VPC Endpoint for the mount-s3 path —
    // deny-all needs no egress at all, and restricted-to-S3 does not need a NAT.

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

    // Harness-side permissions for the container runtime user (CoreRuntimeUser
    // below); the account-manage set follows further down.
    const harnessPermissions = [
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
      ...(agentPoliciesTable
        ? [
            {
              actions: ["dynamodb:GetItem", "dynamodb:Query"],
              resources: [agentPoliciesTable.arn],
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
    ];

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

    // Cron schedules invoke core over HTTPS. EventBridge Scheduler cannot
    // target an API destination directly (CreateSchedule rejects the ARN), so
    // schedules publish onto a dedicated bus (templated PutEvents target) and
    // a rule forwards the event detail — the CronInvocation JSON — to the API
    // destination, which POSTs it to the gateway /v1/cron-runs with the
    // service token. Source/DetailType constants match awsCrons.ts.
    const cronRunBus = new aws.cloudwatch.EventBus("CronRunBus", {
      name: resourceName("cron-runs", stage, region),
    });
    const cronRunConnection = new aws.cloudwatch.EventConnection("CronRunConnection", {
      name: resourceName("cron-run", stage, region),
      authorizationType: "API_KEY",
      authParameters: {
        apiKey: {
          key: "Authorization",
          value: `Bearer ${SERVICE_AUTH_SECRET}`,
        },
      },
    });
    const cronRunApiDestination = new aws.cloudwatch.EventApiDestination("CronRunApiDestination", {
      name: resourceName("cron-run", stage, region),
      connectionArn: cronRunConnection.arn,
      invocationEndpoint: `${PUBLIC_BASE_URL}/v1/cron-runs`,
      httpMethod: "POST",
    });
    const cronRunInvokeRole = new aws.iam.Role("CronRunInvokeRole", {
      name: resourceName("cron-run-invoke", stage, region),
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "events.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });
    new aws.iam.RolePolicy("CronRunInvokeRolePolicy", {
      role: cronRunInvokeRole.id,
      policy: cronRunApiDestination.arn.apply((arn) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["events:InvokeApiDestination"],
              Resource: [arn],
            },
          ],
        }),
      ),
    });
    const cronRunRule = new aws.cloudwatch.EventRule("CronRunRule", {
      name: resourceName("cron-run", stage, region),
      eventBusName: cronRunBus.name,
      eventPattern: JSON.stringify({ source: ["broods.crons"], "detail-type": ["cron-run"] }),
    });
    new aws.cloudwatch.EventTarget("CronRunRuleTarget", {
      rule: cronRunRule.name,
      eventBusName: cronRunBus.name,
      arn: cronRunApiDestination.arn,
      roleArn: cronRunInvokeRole.arn,
      // Deliver only the event detail so the core leaf receives the exact
      // {kind, accountId, cronId} payload.
      inputPath: "$.detail",
    });

    new aws.iam.RolePolicy("CronSchedulerRolePolicy", {
      role: cronSchedulerRole.id,
      policy: cronRunBus.arn.apply((arn) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["events:PutEvents"],
              Resource: [arn],
            },
          ],
        }),
      ),
    });

    // Also granted to CoreRuntimeUser below, same as harnessPermissions.
    const accountManagePermissions = [
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
      ...(agentPoliciesTable
        ? [
            {
              actions: [
                "dynamodb:DeleteItem",
                "dynamodb:GetItem",
                "dynamodb:PutItem",
                "dynamodb:Query",
                "dynamodb:UpdateItem",
              ],
              resources: [agentPoliciesTable.arn],
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
    ];

    // IAM principal for the self-hosted container runtime (epic #85 phase 9a):
    // one pod runs both handlers, so the user gets the union of the harness and
    // account permission sets, generated from the same arrays so it cannot drift.
    // The access key is minted out of band (`aws iam create-access-key`) and
    // delivered to the cluster as a k8s Secret — never in Pulumi state or git.
    // Two managed policies instead of one inline: IAM caps inline user policies
    // at 2048 chars total, which these documents exceed.
    const coreRuntimeUser = new aws.iam.User("CoreRuntimeUser", {
      name: resourceName("core-runtime", stage, region),
    });
    const coreRuntimeHarnessPolicy = new aws.iam.Policy("CoreRuntimeHarnessPolicy", {
      name: resourceName("core-runtime-harness", stage, region),
      policy: permissionsPolicy(harnessPermissions),
    });
    const coreRuntimeAccountPolicy = new aws.iam.Policy("CoreRuntimeAccountPolicy", {
      name: resourceName("core-runtime-account", stage, region),
      policy: permissionsPolicy(accountManagePermissions),
    });
    new aws.iam.UserPolicyAttachment("CoreRuntimeHarnessPolicyAttachment", {
      user: coreRuntimeUser.name,
      policyArn: coreRuntimeHarnessPolicy.arn,
    });
    new aws.iam.UserPolicyAttachment("CoreRuntimeAccountPolicyAttachment", {
      user: coreRuntimeUser.name,
      policyArn: coreRuntimeAccountPolicy.arn,
    });

    // AWS access for the Convex config plane (epic #85 phase 9 — state plane owns
    // AWS directly, no core proxy). Convex node actions assume ConvexAwsRole with a
    // minimal bootstrap user's static key (minted out of band, stored in the Convex
    // deployment env as AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY + CONVEX_AWS_ROLE_ARN)
    // and get short-lived credentials scoped to: the skills/tool-bundle/workspace S3
    // buckets, and EventBridge Scheduler for account cron jobs (targeting core's
    // cron-run endpoint). The role ARN is also allow-listed in
    // denyUnlessProjectPrincipal so its S3 calls are not denied.
    const convexAwsPermissions = [
      {
        actions: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:HeadObject"],
        resources: [`${skillsBucketArn}/*`, `${toolBundlesBucketArn}/*`, `${filesystemBucketArn}/*`],
      },
      {
        actions: ["s3:ListBucket"],
        resources: [skillsBucketArn, toolBundlesBucketArn, filesystemBucketArn],
      },
      {
        actions: [
          "scheduler:CreateSchedule",
          "scheduler:UpdateSchedule",
          "scheduler:DeleteSchedule",
          "scheduler:GetSchedule",
        ],
        resources: [$interpolate`arn:aws:scheduler:${region}:${AWS_ACCOUNT_ID}:schedule/${cronScheduleGroup.name}/*`],
      },
      {
        // Convex creates schedules that run as the cron scheduler role.
        actions: ["iam:PassRole"],
        resources: [cronSchedulerRole.arn],
      },
    ];
    const convexAwsRole = new aws.iam.Role("ConvexAwsRole", {
      name: resourceName("convex-aws", stage, region),
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { AWS: `arn:aws:iam::${AWS_ACCOUNT_ID}:user/${resourceName("convex-bootstrap", stage, region)}` },
            Action: "sts:AssumeRole",
            Condition: { StringEquals: { "sts:ExternalId": "broods-convex" } },
          },
        ],
      }),
    });
    const convexAwsPolicy = new aws.iam.Policy("ConvexAwsPolicy", {
      name: resourceName("convex-aws", stage, region),
      policy: permissionsPolicy(convexAwsPermissions),
    });
    new aws.iam.RolePolicyAttachment("ConvexAwsPolicyAttachment", {
      role: convexAwsRole.name,
      policyArn: convexAwsPolicy.arn,
    });
    // Bootstrap identity Convex uses to assume the role above. It can do nothing
    // except assume that role; the access key is created out of band and never
    // stored in Pulumi state or git.
    const convexBootstrapUser = new aws.iam.User("ConvexBootstrapUser", {
      name: resourceName("convex-bootstrap", stage, region),
    });
    new aws.iam.UserPolicy("ConvexBootstrapAssumePolicy", {
      user: convexBootstrapUser.name,
      policy: convexAwsRole.arn.apply((arn) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [{ Effect: "Allow", Action: "sts:AssumeRole", Resource: arn }],
        }),
      ),
    });

    return {
      accountConfigsTableName: accountConfigsTable?.name,
      agentConfigsTableName: agentConfigsTable?.name,
      sandboxConfigsTableName: sandboxConfigsTable?.name,
      workspaceConfigsTableName: workspaceConfigsTable?.name,
      accountToolsTableName: accountToolsTable?.name,
      agentPoliciesTableName: agentPoliciesTable?.name,
      cronsTableName: cronsTable?.name,
      conversationsTableName: conversationsTable.name,
      processedEventsTableName: processedEventsTable.name,
      asyncAgentResultTableName: asyncAgentResultTable.name,
      asyncToolResultTableName: asyncToolResultTable.name,
      cronScheduleGroupName: cronScheduleGroup.name,
      // Convex awsCrons.ts uses this verbatim as the schedule Target Arn (the
      // cron-runs event bus; the bus rule forwards to the API destination).
      cronSchedulerTargetArn: cronRunBus.arn,
      cronSchedulerRoleArn: cronSchedulerRole.arn,
      filesystemBucketName: filesystemBucket.name,
      skillsBucketName: skillsBucket.name,
      toolBundlesBucketName: toolBundlesBucket.name,
      microvmArtifactsBucketName: microvmArtifactsBucket?.name,
      microvmBuildRoleArn: microvmBuildRole?.arn,
      microvmExecutionRoleArn: microvmExecutionRole?.arn,
      coreRuntimeUserName: coreRuntimeUser.name,
      convexAwsRoleArn: convexAwsRole.arn,
      convexBootstrapUserName: convexBootstrapUser.name,
    };
  },
});
