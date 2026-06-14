/// <reference path="./.sst/platform/config.d.ts" />

// SST infrastructure for the account-managed harness: one streaming runtime Lambda and one account-management Lambda.
// AWS account + project identity for resource names, IAM role ARNs, and tags.
// No in-source defaults — provided via repo vars / local env (see .env.example).
// CI injects them into the validate + deploy jobs; forks must set them to run
// `sst install` / deploy.
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID!;
const PROJECT_NAME = process.env.PROJECT_NAME!;
const PROJECT_OWNER_EMAIL = process.env.PROJECT_OWNER_EMAIL!;
const AWS_PROFILE = process.env.CI ? undefined : (process.env.AWS_PROFILE ?? "default");
const ENABLE_DIRECT_API = parseBooleanEnv("ENABLE_DIRECT_API", false);
const ENABLE_WEBSOCKET = parseBooleanEnv("ENABLE_WEBSOCKET", false);
// Gate the 4 image-based sandbox Lambdas. They pull `:latest-arm64` from a region-scoped
// ECR repo that this app creates, but the lambda-sanbdox CI only mirrors the image into a
// repo that already exists — a bootstrap deadlock. Keep this off for a region's first
// deploy (creates the repo, skips the functions), let the lambda-sanbdox CI push the image,
// then re-deploy with SANDBOX_IMAGE_READY=true. See docs/workspace/sandbox/lambda.md.
const SANDBOX_IMAGE_READY = parseBooleanEnv("SANDBOX_IMAGE_READY", false);
const SANDBOX_WORKSPACE_MOUNT_PATH = "/mnt/workspaces";
const NATS_URL = process.env.NATS_URL?.trim();
// Token-auth credential for the NATS server; omit for an unauthenticated server.
const NATS_TOKEN = process.env.NATS_TOKEN?.trim();
// Production runs the Convex storage provider. Other stages stay on
// DynamoDB. CONVEX_URL + CONVEX_DEPLOY_KEY are set by the deploy workflow only
// for the main branch.
const CONVEX_URL = process.env.CONVEX_URL?.trim();
const CONVEX_DEPLOY_KEY = process.env.CONVEX_DEPLOY_KEY?.trim();
const DAYTONA_ORGANIZATION_ID = process.env.DAYTONA_ORGANIZATION_ID?.trim();
const DAYTONA_API_URL = process.env.DAYTONA_API_URL?.trim();
const DAYTONA_TARGET = process.env.DAYTONA_TARGET?.trim();
// kubernetes sandbox provider (agent-sandbox on the Beeblast k3s cluster). Non-secret
// knobs; the kubeconfig is an sst.Secret. See docs/workspace/sandbox/kubernetes.md.
const KUBERNETES_SANDBOX_NAMESPACE = process.env.KUBERNETES_SANDBOX_NAMESPACE?.trim();
const KUBERNETES_SANDBOX_IMAGE = process.env.KUBERNETES_SANDBOX_IMAGE?.trim();
const KUBERNETES_SANDBOX_SERVICE_ACCOUNT = process.env.KUBERNETES_SANDBOX_SERVICE_ACCOUNT?.trim();
const KUBERNETES_SANDBOX_IMAGE_PULL_SECRETS = process.env.KUBERNETES_SANDBOX_IMAGE_PULL_SECRETS?.trim();

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
): {
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

const LAMBDA_ASSUME_ROLE = JSON.stringify({
  Version: "2012-10-17",
  Statement: [{
    Effect: "Allow",
    Principal: { Service: "lambda.amazonaws.com" },
    Action: "sts:AssumeRole",
  }],
});

// SST's `permissions` shorthand -> a raw IAM policy doc. Used by the sandbox
// functions, which run from a pre-built ECR image and so can't use sst.aws.Function
// (it has no `image` arg and always builds a zip). $jsonStringify resolves Outputs.
function permissionsPolicy(
  perms: { actions: string[]; resources: $util.Input<string>[] }[],
) {
  return $jsonStringify({
    Version: "2012-10-17",
    Statement: perms.map((p) => ({ Effect: "Allow", Action: p.actions, Resource: p.resources })),
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
          // Only the workspace-mounted sandbox functions touch the bucket directly.
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/${PROJECT_NAME}-${stage}-SandboxMountNetRole-*`,
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/${PROJECT_NAME}-${stage}-SandboxMountNoNetRole-*`,
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/beeblast_k3s_role`,
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/${resourceName("sandbox-s3files", stage, region)}`,
          // Scoped role assumed by the harness for provider-sandbox mount-s3 credentials.
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/${resourceName("sandbox-s3mount", stage, region)}`,
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/github-actions-aws-infra-deploy`,
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/github-actions-aws-sst-infra-deploy`,
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
    // Production = SaaS = Convex storage. Other stages = DynamoDB (default).
    // Async tools, dedupe, conversations still rely on DDB until those modules
    // are lifted into the StorageProvider abstraction in a follow-up.
    const isProduction = stage === "production";
    if (isProduction && (!CONVEX_URL || !CONVEX_DEPLOY_KEY)) {
      throw new Error(
        "Production stage requires CONVEX_URL and CONVEX_DEPLOY_KEY env vars",
      );
    }
    const storageEnv: Record<string, string> = isProduction
      ? {
        STORAGE_PROVIDER: "convex",
        CONVEX_URL: CONVEX_URL!,
        CONVEX_DEPLOY_KEY: CONVEX_DEPLOY_KEY!,
      }
      : { STORAGE_PROVIDER: "dynamodb" };
    const names = {
      conversations: resourceName("conversations", stage, region),
      processedEvents: resourceName("processed-events", stage, region),
      asyncAgentResult: resourceName("async-agent-result", stage, region),
      asyncToolResult: resourceName("async-tool-result", stage, region),
      persistentSandboxInstance: resourceName("persistent-sandbox-instance", stage, region),
      webhookSubscribeMock: resourceName("webhook-sub-mock", stage, region),
      // Uniform sandbox image deployed across two axes (workspace mount, internet).
      sandboxMountNet: resourceName("sandbox-mount-net", stage, region),
      sandboxMountNonet: resourceName("sandbox-mount-nonet", stage, region),
      sandboxNomountNet: resourceName("sandbox-nomount-net", stage, region),
      sandboxNomountNonet: resourceName("sandbox-nomount-nonet", stage, region),
      accountConfigs: resourceName("account-configs", stage, region),
      agentConfigs: resourceName("agent-configs", stage, region),
      sandboxConfigs: resourceName("sandbox-configs", stage, region),
      workspaceConfigs: resourceName("workspace-configs", stage, region),
      accountTools: resourceName("account-tools", stage, region),
      accountSignupRateLimits: resourceName("account-signup-rate-limits", stage, region),
      cronJobs: resourceName("cron-jobs", stage, region),
      cronSchedules: resourceName("cron-schedules", stage, region),
      harnessProcessing: resourceName("harness-processing", stage, region),
      accountManage: resourceName("account-manage", stage, region),
      memory: resourceName("memory", stage, region),
      skills: resourceName("skills", stage, region),
      toolBundles: resourceName("tool-bundles", stage, region),
    };

    const adminAccountSecret = new sst.Secret("AdminAccountSecret");
    const accountConfigEncryptionSecret = new sst.Secret("AccountConfigEncryptionSecret");
    // Shared token for trusted server-side callers (the dashboard's Convex run/sync
    // proxy) that act on behalf of an account via the X-Account-Id header. Optional:
    // the empty default keeps deploys working for stages that only use the public
    // account-secret API; set a real value per stage to enable the service-token path.
    const serviceAuthSecret = new sst.Secret("ServiceAuthSecret", "");
    const daytonaApiKey = new sst.Secret("DaytonaApiKey");
    // Base64 kubeconfig (SA bearer token) for the kubernetes sandbox provider. Optional:
    // the placeholder keeps deploys working for stages that don't use this provider.
    const kubernetesSandboxKubeconfig = new sst.Secret("KubernetesSandboxKubeconfig", "");
    // The kubeconfig (CA + token) is ~2.7KB — too big for a Lambda env var alongside
    // everything else (4KB hard limit). Store it in SSM and let the harness fetch it at
    // runtime; only the parameter name goes in the env. SecureString can't be empty, so
    // unset stages get a "unset" placeholder.
    const kubernetesSandboxKubeconfigParam = new aws.ssm.Parameter("KubernetesSandboxKubeconfigParam", {
      name: `/filthy-panty/${stage}/kubernetes-sandbox-kubeconfig`,
      type: "SecureString",
      value: kubernetesSandboxKubeconfig.value.apply((v) => (v && v.length > 0 ? v : "unset")),
    });

    // accounts / agents / cron-jobs DDB tables are skipped on production —
    // those domains live in Convex on SaaS. Tables stay for dev / community
    // stages so the DynamoDB provider has somewhere to read/write.
    const accountConfigsTable = isProduction
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
      deletionProtection: stage === "production",
      transform: {
        table: {
          name: names.accountSignupRateLimits,
        },
      },
    });

    const agentConfigsTable = isProduction
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
    const sandboxConfigsTable = isProduction
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

    const workspaceConfigsTable = isProduction
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

    const accountToolsTable = isProduction
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

    const cronJobsTable = isProduction
      ? null
      : new sst.aws.Dynamo("CronJob", {
        fields: {
          accountId: "string",
          cronJobId: "string",
        },
        primaryIndex: { hashKey: "accountId", rangeKey: "cronJobId" },
        deletionProtection: false,
        transform: {
          table: {
            name: names.cronJobs,
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
    // Maps a workspace namespace -> the long-lived (reserved) provider sandbox
    // reserved for it, so a later request reconnects instead of recreating.
    const persistentSandboxInstanceTable = new sst.aws.Dynamo("PersistentSandboxInstance", {
      fields: {
        instanceKey: "string",
      },
      primaryIndex: { hashKey: "instanceKey" },
      ttl: "expiresAt",
      deletionProtection: stage === "production",
      transform: {
        table: {
          name: names.persistentSandboxInstance,
        },
      },
    });
    const filesystemBucketArn = `arn:aws:s3:::${names.memory}`;
    const skillsBucketArn = `arn:aws:s3:::${names.skills}`;
    const toolBundlesBucketArn = `arn:aws:s3:::${names.toolBundles}`;
    const filesystemBucket = new sst.aws.Bucket("Memory", {
      versioning: true,
      policy: [denyUnlessProjectPrincipal(stage, region)],
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
      policy: [denyUnlessProjectPrincipal(stage, region)],
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

    const toolBundlesBucket = new sst.aws.Bucket("ToolBundles", {
      versioning: true,
      policy: [denyUnlessProjectPrincipal(stage, region)],
      transform: {
        bucket: {
          bucket: names.toolBundles,
        },
        publicAccessBlock: {
          blockPublicAcls: true,
          ignorePublicAcls: true,
          blockPublicPolicy: true,
          restrictPublicBuckets: true,
        },
      },
    });

    // Setup the VPC for the sandbox connection. Uses fck-nat (nat: "ec2") on
    // non-production stages — a t4g.nano-based NAT solution ~10x cheaper than
    // a managed NAT Gateway. Production omits NAT entirely to avoid cost.
    const sandboxNetwork = new sst.aws.Vpc("SandboxNetwork", {
      az: 2, // 2 az same price of 1 az.
      ...(isProduction ? {} : { nat: "ec2" }),
    });

    const s3FilesRole = new aws.iam.Role("SandboxS3FilesRole", {
      name: resourceName("sandbox-s3files", stage, region),
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Sid: "AllowS3FilesAssumeRole",
          Effect: "Allow",
          Principal: { Service: "elasticfilesystem.amazonaws.com" },
          Action: "sts:AssumeRole",
          Condition: {
            StringEquals: {
              "aws:SourceAccount": AWS_ACCOUNT_ID,
            },
            ArnLike: {
              "aws:SourceArn": `arn:aws:s3files:${region}:${AWS_ACCOUNT_ID}:file-system/*`,
            },
          },
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
              "s3:AbortMultipartUpload",
              "s3:DeleteObject*",
              "s3:GetObject*",
              "s3:HeadObject",
              "s3:List*",
              "s3:PutObject*",
            ],
            Resource: [`${filesystemBucketArn}/*`],
            Condition: {
              StringEquals: {
                "aws:ResourceAccount": AWS_ACCOUNT_ID,
              },
            },
          },
          {
            Effect: "Allow",
            Action: [
              "s3:HeadBucket",
              "s3:ListBucket",
              "s3:ListBucketVersions",
              "s3:ListBucketMultipartUploads",
            ],
            Resource: [filesystemBucketArn],
            Condition: {
              StringEquals: {
                "aws:ResourceAccount": AWS_ACCOUNT_ID,
              },
            },
          },
          {
            Effect: "Allow",
            Action: [
              "events:DeleteRule",
              "events:DisableRule",
              "events:EnableRule",
              "events:PutRule",
              "events:PutTargets",
              "events:RemoveTargets",
            ],
            Resource: ["arn:aws:events:*:*:rule/DO-NOT-DELETE-S3-Files*"],
            Condition: {
              StringEquals: {
                "events:ManagedBy": "elasticfilesystem.amazonaws.com",
              },
            },
          },
          {
            Effect: "Allow",
            Action: [
              "events:DescribeRule",
              "events:ListRuleNamesByTarget",
              "events:ListRules",
              "events:ListTargetsByRule",
            ],
            Resource: ["arn:aws:events:*:*:rule/*"],
          },
        ],
      }),
    });

    // Scoped credentials for provider sandboxes that mount S3 with mount-s3
    // (daytona). The harness assumes this role per sandbox create and hands the
    // short-lived session credentials to the sandbox instead of its own runtime
    // credentials, so sandbox code can only reach the workspace/skills buckets.
    const sandboxS3MountRole = new aws.iam.Role("SandboxS3MountRole", {
      name: resourceName("sandbox-s3mount", stage, region),
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Sid: "AllowHarnessAssumeRole",
          Effect: "Allow",
          Principal: { AWS: `arn:aws:iam::${AWS_ACCOUNT_ID}:root` },
          Action: "sts:AssumeRole",
        }],
      }),
    });

    new aws.iam.RolePolicy("SandboxS3MountRolePolicy", {
      role: sandboxS3MountRole.id,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: [
              "s3:GetObject",
              "s3:PutObject",
              "s3:DeleteObject",
              "s3:AbortMultipartUpload",
            ],
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
      // WARNING — this root path is load-bearing and must stay in sync with
      // WORKSPACE_MOUNT_PREFIX in functions/_shared/sandbox.ts.
      //
      // It MUST be a non-root sub-path. The bucket root ("/") already exists, so the
      // access point's creationPermissions are NOT applied to it and the mount root is
      // not writable by the squashed uid (see git commit 2bdb34f "Use writable sandbox
      // workspace root"). A non-existent sub-path like "/sandbox" gets created with the
      // 777 creationPermissions below, which is what makes the mount writable.
      //
      // Because the access point is rooted here, the mount stores every file under the
      // "sandbox/" key prefix. All harness-side S3 reads/writes of workspace files apply
      // the same prefix via workspaceNamespacePrefix(). If you change this path, change
      // WORKSPACE_MOUNT_PREFIX to match or the harness and sandbox stop seeing each
      // other's files (publish loses bash-written files; loads show an empty mount).
      rootDirectories: [{
        path: "/sandbox",
        creationPermissions: [{
          ownerUid: 1000,
          ownerGid: 1000,
          permissions: "777",
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

    // This app owns the sandbox image ECR repo (moved out of the infra Terraform repo) so
    // the repo lifecycle stays in sync with the functions that consume it — no cross-repo
    // coordination. Lambda pulls only from PRIVATE ECR in its own region (public.ecr.aws is
    // rejected), so the repo is region-scoped: each deploy region gets its own. The arm64
    // image is pushed by the lambda-just-bash-rust CI; for a brand-new region that push must
    // land before the sandbox functions can be created (the first deploy creates the empty
    // repo, then re-deploy once the image exists). See docs/workspace/sandbox/lambda.md.
    const sandboxImageRepoName = `beeblast-lambda-sandbox-${AWS_ACCOUNT_ID}-${region}`;
    const sandboxEcr = new aws.ecr.Repository("SandboxImage", {
      name: sandboxImageRepoName,
      imageTagMutability: "MUTABLE",
      imageScanningConfiguration: { scanOnPush: true },
      forceDelete: !isProduction,
    }, {
      retainOnDelete: isProduction,
    });

    // Wide pull mirrors the prior infra policy. Same-account Lambda pulls work without it;
    // cross-account consumers (kubernetes / daytona sandbox providers) rely on it.
    new aws.ecr.RepositoryPolicy("SandboxImagePolicy", {
      repository: sandboxEcr.name,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Sid: "AllowCrossAccountPull",
          Effect: "Allow",
          Principal: "*",
          Action: [
            "ecr:GetDownloadUrlForLayer",
            "ecr:BatchGetImage",
            "ecr:BatchCheckLayerAvailability",
          ],
        }],
      }),
    });

    // ARM64-only image; there is no multi-arch `latest` manifest, so pin the arch tag.
    const sandboxImageUri = $interpolate`${sandboxEcr.repositoryUrl}:latest-arm64`;

    // The uniform sandbox image is deployed across two axes — workspace mount (VPC +
    // S3 Files mount) vs none, and internet on vs off. The harness auto-selects the
    // function per run from (namespace present?) and the sandbox `internet` flag.
    //
    // Cost (R2): no managed NAT Gateway. Mounted functions need the VPC for the S3
    // Files mount; on non-prod the VPC uses fck-nat (~10x cheaper than NAT Gateway).
    // The no-mount + internet-on function runs WITHOUT a VPC for free managed egress
    // and the fastest cold start. Internet-off functions use a restricted security group
    // that drops all egress except NFS (port 2049) to the S3 Files mount targets —
    // blocking outbound internet even though the subnets route through NAT.
    const sandboxMountPermissions = sandboxRuntimePermissions(filesystemBucketArn, sandboxS3Files.arn, sandboxS3FilesAccessPoint.arn);

    // Security group for internet-off sandbox functions. Removes the default allow-all
    // egress so Lambda cannot reach the public internet. NFS egress to the VPC security
    // group is allowed so the workspace-mount variant can still reach S3 Files.
    const sandboxNoNetSecurityGroup = new aws.ec2.SecurityGroup("SandboxNoNetSecurityGroup", {
      vpcId: sandboxNetwork.nodes.vpc.id,
      description: "No-internet sandbox: blocks outbound internet, allows NFS to S3 Files only",
      egress: [{
        protocol: "tcp",
        fromPort: 2049,
        toPort: 2049,
        securityGroups: sandboxNetwork.securityGroups.apply((ids) => ids.slice(0, 1)),
        description: "Allow NFS egress to S3 Files mount targets",
      }],
      tags: { Name: resourceName("sandbox-nonet-sg", stage, region) },
    });
    // Allow NFS ingress to the S3 Files mount targets from the no-internet security group.
    new aws.vpc.SecurityGroupIngressRule("SandboxS3FilesNfsIngressNoNet", {
      securityGroupId: sandboxNetwork.securityGroups.apply((ids) => ids[0]!),
      referencedSecurityGroupId: sandboxNoNetSecurityGroup.id,
      ipProtocol: "tcp",
      fromPort: 2049,
      toPort: 2049,
    });

    // sst.aws.Function can't consume a pre-built ECR image (no `image` arg; it always
    // builds a zip), so the sandbox functions drop to the raw Lambda resource with
    // packageType "Image". This helper recreates the role / VPC / EFS mount / log-group
    // wiring SST would otherwise manage. Axes: workspace mount (VPC + S3 Files) and VPC.
    const sandboxImageFunction = (
      logical: string,
      cfg: { name: string; description: string; mount: boolean; vpc: boolean; securityGroupIds?: $util.Input<string[]> },
    ) => {
      const role = new aws.iam.Role(`${logical}Role`, { assumeRolePolicy: LAMBDA_ASSUME_ROLE });

      new aws.iam.RolePolicyAttachment(`${logical}LogsPolicy`, {
        role: role.name,
        policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      });
      if (cfg.vpc) {
        new aws.iam.RolePolicyAttachment(`${logical}VpcPolicy`, {
          role: role.name,
          policyArn: "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole",
        });
      }
      if (cfg.mount) {
        new aws.iam.RolePolicy(`${logical}MountPolicy`, {
          role: role.id,
          policy: permissionsPolicy(sandboxMountPermissions),
        });
      }

      // Explicit log group preserves the "1 month" retention sst.aws.Function gave us.
      const logGroup = new aws.cloudwatch.LogGroup(`${logical}LogGroup`, {
        name: `/aws/lambda/${cfg.name}`,
        retentionInDays: 30,
      });

      return new aws.lambda.Function(logical, {
        name: cfg.name,
        packageType: "Image",
        imageUri: sandboxImageUri,
        architectures: ["arm64"],
        role: role.arn,
        description: cfg.description,
        timeout: 300,
        memorySize: 512, // Minimum AWS requires for the S3 mount + sandbox execution.
        environment: { variables: { SANDBOX_WORKSPACE_MOUNT_PATH } },
        loggingConfig: { logFormat: "JSON", logGroup: logGroup.name },
        ...(cfg.vpc
          ? {
            vpcConfig: {
              subnetIds: sandboxNetwork.privateSubnets,
              securityGroupIds: cfg.securityGroupIds ?? sandboxNetwork.securityGroups,
            },
          }
          : {}),
        ...(cfg.mount
          ? {
            fileSystemConfig: {
              arn: sandboxS3FilesAccessPoint.arn,
              localMountPath: SANDBOX_WORKSPACE_MOUNT_PATH,
            },
          }
          : {}),
      }, { dependsOn: [logGroup] });
    };

    // Harness wiring (env, IAM, outputs) always uses the deterministic function names/ARNs,
    // so it is correct whether or not the functions exist yet. The function *resources* are
    // created only once the arm64 image is in ECR (SANDBOX_IMAGE_READY=true) — see the flag.
    const sandboxFunctionArn = (name: string) =>
      `arn:aws:lambda:${region}:${AWS_ACCOUNT_ID}:function:${name}`;

    if (SANDBOX_IMAGE_READY) {
      sandboxImageFunction("SandboxMountNet", {
        name: names.sandboxMountNet,
        description: "Uniform sandbox — workspace mount + internet.",
        mount: true,
        vpc: true,
      });

      sandboxImageFunction("SandboxMountNoNet", {
        name: names.sandboxMountNonet,
        description: "Uniform sandbox — workspace mount, no internet.",
        mount: true,
        vpc: true,
        securityGroupIds: sandboxNoNetSecurityGroup.id.apply((id) => [id]),
      });

      sandboxImageFunction("SandboxNoMountNet", {
        name: names.sandboxNomountNet,
        description: "Uniform sandbox — stateless + internet (no VPC, fastest cold start).",
        mount: false,
        vpc: false,
      });

      sandboxImageFunction("SandboxNoMountNoNet", {
        name: names.sandboxNomountNonet,
        description: "Uniform sandbox — stateless, no internet.",
        mount: false,
        vpc: true,
        securityGroupIds: sandboxNoNetSecurityGroup.id.apply((id) => [id]),
      });
    }

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
        PROCESSED_EVENTS_TABLE_NAME: processedEventsTable.name,
        ASYNC_AGENT_RESULT_TABLE_NAME: asyncAgentResultTable.name,
        ASYNC_TOOL_RESULT_TABLE_NAME: asyncToolResultTable.name,
        PERSISTENT_SANDBOX_INSTANCE_TABLE_NAME: persistentSandboxInstanceTable.name,
        ...(accountConfigsTable
          ? { ACCOUNT_CONFIGS_TABLE_NAME: accountConfigsTable.name }
          : {}),
        ...(agentConfigsTable
          ? { AGENT_CONFIGS_TABLE_NAME: agentConfigsTable.name }
          : {}),
        ...(sandboxConfigsTable
          ? { SANDBOX_CONFIGS_TABLE_NAME: sandboxConfigsTable.name }
          : {}),
        ...(workspaceConfigsTable
          ? { WORKSPACE_CONFIGS_TABLE_NAME: workspaceConfigsTable.name }
          : {}),
        ...(accountToolsTable
          ? { ACCOUNT_TOOLS_TABLE_NAME: accountToolsTable.name }
          : {}),
        ACCOUNT_SECRET_INDEX_NAME: "SecretHashIndex",
        ACCOUNT_CONFIG_ENCRYPTION_SECRET: accountConfigEncryptionSecret.value,
        SERVICE_AUTH_SECRET: serviceAuthSecret.value,
        FILESYSTEM_BUCKET_NAME: names.memory,
        SKILLS_BUCKET_NAME: names.skills,
        TOOL_BUNDLES_BUCKET_NAME: names.toolBundles,
        ENABLE_DIRECT_API: ENABLE_DIRECT_API ? "true" : "false",
        ENABLE_WEBSOCKET: ENABLE_WEBSOCKET ? "true" : "false",
        SANDBOX_FN_MOUNT_NET: names.sandboxMountNet,
        SANDBOX_FN_MOUNT_NONET: names.sandboxMountNonet,
        SANDBOX_FN_NOMOUNT_NET: names.sandboxNomountNet,
        SANDBOX_FN_NOMOUNT_NONET: names.sandboxNomountNonet,
        ...(cronJobsTable
          ? { CRON_JOBS_TABLE_NAME: cronJobsTable.name }
          : {}),
        ...(NATS_URL ? { NATS_URL } : {}),
        ...(NATS_TOKEN ? { NATS_TOKEN } : {}),
        DAYTONA_API_KEY: daytonaApiKey.value,
        SANDBOX_MOUNT_ROLE_ARN: sandboxS3MountRole.arn,
        ...(DAYTONA_ORGANIZATION_ID ? { DAYTONA_ORGANIZATION_ID } : {}),
        ...(DAYTONA_API_URL ? { DAYTONA_API_URL } : {}),
        ...(DAYTONA_TARGET ? { DAYTONA_TARGET } : {}),
        KUBERNETES_SANDBOX_KUBECONFIG_SSM: kubernetesSandboxKubeconfigParam.name,
        // k3s serves a self-signed API cert, and the bun-compiled Lambda runtime's fetch
        // ignores the kubeconfig CA / insecure-skip-tls-verify (only this env is honored).
        // Scope the TLS-verification opt-out to non-production stages, where the kubernetes
        // sandbox provider is exercised. Production must front the API with a trusted cert
        // (or bundle the CA via NODE_EXTRA_CA_CERTS) before enabling this provider — we do
        // NOT weaken TLS on the production harness, which handles account secrets.
        ...(isProduction ? {} : { NODE_TLS_REJECT_UNAUTHORIZED: "0" }),
        ...(KUBERNETES_SANDBOX_NAMESPACE ? { KUBERNETES_SANDBOX_NAMESPACE } : {}),
        ...(KUBERNETES_SANDBOX_IMAGE ? { KUBERNETES_SANDBOX_IMAGE } : {}),
        ...(KUBERNETES_SANDBOX_SERVICE_ACCOUNT ? { KUBERNETES_SANDBOX_SERVICE_ACCOUNT } : {}),
        ...(KUBERNETES_SANDBOX_IMAGE_PULL_SECRETS ? { KUBERNETES_SANDBOX_IMAGE_PULL_SECRETS } : {}),
      },
      permissions: [
        // Read the kubernetes sandbox kubeconfig from SSM (SecureString → needs KMS decrypt).
        {
          actions: ["ssm:GetParameter"],
          resources: [kubernetesSandboxKubeconfigParam.arn],
        },
        {
          actions: ["sts:AssumeRole"],
          resources: [sandboxS3MountRole.arn],
        },
        {
          actions: ["kms:Decrypt"],
          resources: ["*"],
        },
        ...(accountConfigsTable
          ? [{
            actions: [
              "dynamodb:GetItem",
              "dynamodb:Query",
            ],
            resources: [accountConfigsTable.arn, $interpolate`${accountConfigsTable.arn}/index/SecretHashIndex`],
          }]
          : []),
        ...(agentConfigsTable
          ? [{
            actions: [
              "dynamodb:GetItem",
              "dynamodb:Query",
            ],
            resources: [agentConfigsTable.arn],
          }]
          : []),
        ...(sandboxConfigsTable
          ? [{
            actions: [
              "dynamodb:GetItem",
              "dynamodb:Query",
            ],
            resources: [sandboxConfigsTable.arn],
          }]
          : []),
        ...(workspaceConfigsTable
          ? [{
            actions: [
              "dynamodb:GetItem",
              "dynamodb:Query",
            ],
            resources: [workspaceConfigsTable.arn],
          }]
          : []),
        ...(accountToolsTable
          ? [{
            actions: [
              "dynamodb:GetItem",
              "dynamodb:Query",
            ],
            resources: [accountToolsTable.arn],
          }]
          : []),
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
          actions: [
            "dynamodb:GetItem",
            "dynamodb:PutItem",
            "dynamodb:UpdateItem",
            "dynamodb:DeleteItem",
          ],
          resources: [persistentSandboxInstanceTable.arn],
        },
        ...(cronJobsTable
          ? [{
            actions: [
              "dynamodb:GetItem",
              "dynamodb:UpdateItem",
            ],
            resources: [cronJobsTable.arn],
          }]
          : []),
        {
          // Self-invoke (async worker) + read its own Function URL so background
          // jobs know where to POST their completion callback.
          actions: ["lambda:InvokeFunction", "lambda:GetFunctionUrlConfig"],
          resources: [`arn:aws:lambda:${region}:${AWS_ACCOUNT_ID}:function:${names.harnessProcessing}`],
        },
        {
          actions: ["lambda:InvokeFunction"],
          resources: [
            sandboxFunctionArn(names.sandboxMountNet),
            sandboxFunctionArn(names.sandboxMountNonet),
            sandboxFunctionArn(names.sandboxNomountNet),
            sandboxFunctionArn(names.sandboxNomountNonet),
          ],
        },
        {
          actions: [
            "s3:GetObject",
            "s3:HeadObject",
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
            "s3:HeadObject",
            "s3:PutObject",
            "s3:DeleteObject",
          ],
          resources: [`${skillsBucketArn}/*`],
        },
        {
          actions: ["s3:ListBucket"],
          resources: [skillsBucketArn],
        },
        {
          actions: [
            "s3:GetObject",
            "s3:HeadObject",
          ],
          resources: [`${toolBundlesBucketArn}/*`],
        },
        {
          actions: ["s3:ListBucket"],
          resources: [toolBundlesBucketArn],
        },
      ],
    });

    const cronScheduleGroup = new aws.scheduler.ScheduleGroup("CronScheduleGroup", {
      name: names.cronSchedules,
    });

    const cronSchedulerRole = new aws.iam.Role("CronSchedulerRole", {
      name: resourceName("cron-scheduler", stage, region),
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: "scheduler.amazonaws.com" },
          Action: "sts:AssumeRole",
        }],
      }),
    });

    new aws.iam.RolePolicy("CronSchedulerRolePolicy", {
      role: cronSchedulerRole.id,
      policy: harnessProcessing.arn.apply((arn) => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Action: ["lambda:InvokeFunction"],
          Resource: [arn],
        }],
      })),
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
        ...(accountConfigsTable
          ? { ACCOUNT_CONFIGS_TABLE_NAME: accountConfigsTable.name }
          : {}),
        ...(agentConfigsTable
          ? { AGENT_CONFIGS_TABLE_NAME: agentConfigsTable.name }
          : {}),
        ...(sandboxConfigsTable
          ? { SANDBOX_CONFIGS_TABLE_NAME: sandboxConfigsTable.name }
          : {}),
        ...(workspaceConfigsTable
          ? { WORKSPACE_CONFIGS_TABLE_NAME: workspaceConfigsTable.name }
          : {}),
        ...(accountToolsTable
          ? { ACCOUNT_TOOLS_TABLE_NAME: accountToolsTable.name }
          : {}),
        ACCOUNT_SECRET_INDEX_NAME: "SecretHashIndex",
        CONVERSATIONS_TABLE_NAME: conversationsTable.name,
        PROCESSED_EVENTS_TABLE_NAME: processedEventsTable.name,
        ASYNC_AGENT_RESULT_TABLE_NAME: asyncAgentResultTable.name,
        ASYNC_TOOL_RESULT_TABLE_NAME: asyncToolResultTable.name,
        PERSISTENT_SANDBOX_INSTANCE_TABLE_NAME: persistentSandboxInstanceTable.name,
        FILESYSTEM_BUCKET_NAME: names.memory,
        SKILLS_BUCKET_NAME: names.skills,
        TOOL_BUNDLES_BUCKET_NAME: names.toolBundles,
        ACCOUNT_SIGNUP_RATE_LIMIT_TABLE_NAME: accountSignupRateLimitTable.name,
        ACCOUNT_SIGNUP_RATE_LIMIT_PER_HOUR: "5",
        ADMIN_ACCOUNT_SECRET: adminAccountSecret.value,
        ACCOUNT_CONFIG_ENCRYPTION_SECRET: accountConfigEncryptionSecret.value,
        SERVICE_AUTH_SECRET: serviceAuthSecret.value,
        ...(cronJobsTable
          ? { CRON_JOBS_TABLE_NAME: cronJobsTable.name }
          : {}),
        CRON_SCHEDULER_TARGET_FUNCTION_ARN: harnessProcessing.arn,
        CRON_SCHEDULER_ROLE_ARN: cronSchedulerRole.arn,
        CRON_SCHEDULER_GROUP_NAME: cronScheduleGroup.name,
      },
      permissions: [
        ...(accountConfigsTable
          ? [{
            actions: [
              "dynamodb:DeleteItem",
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:Query",
              "dynamodb:Scan",
              "dynamodb:UpdateItem",
            ],
            resources: [accountConfigsTable.arn, $interpolate`${accountConfigsTable.arn}/index/SecretHashIndex`],
          }]
          : []),
        ...(agentConfigsTable
          ? [{
            actions: [
              "dynamodb:DeleteItem",
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:Query",
              "dynamodb:UpdateItem",
            ],
            resources: [agentConfigsTable.arn],
          }]
          : []),
        ...(sandboxConfigsTable
          ? [{
            actions: [
              "dynamodb:DeleteItem",
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:Query",
              "dynamodb:UpdateItem",
            ],
            resources: [sandboxConfigsTable.arn],
          }]
          : []),
        ...(workspaceConfigsTable
          ? [{
            actions: [
              "dynamodb:DeleteItem",
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:Query",
              "dynamodb:UpdateItem",
            ],
            resources: [workspaceConfigsTable.arn],
          }]
          : []),
        ...(accountToolsTable
          ? [{
            actions: [
              "dynamodb:DeleteItem",
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:Query",
              "dynamodb:UpdateItem",
            ],
            resources: [accountToolsTable.arn],
          }]
          : []),
        ...(cronJobsTable
          ? [{
            actions: [
              "dynamodb:DeleteItem",
              "dynamodb:GetItem",
              "dynamodb:PutItem",
              "dynamodb:Query",
              "dynamodb:UpdateItem",
            ],
            resources: [cronJobsTable.arn],
          }]
          : []),
        {
          // Read + drop reserved-sandbox instance rows when releasing on delete.
          actions: ["dynamodb:GetItem", "dynamodb:DeleteItem"],
          resources: [persistentSandboxInstanceTable.arn],
        },
        {
          actions: [
            "scheduler:CreateSchedule",
            "scheduler:DeleteSchedule",
            "scheduler:UpdateSchedule",
          ],
          resources: [$interpolate`arn:aws:scheduler:${region}:${AWS_ACCOUNT_ID}:schedule/${cronScheduleGroup.name}/*`],
        },
        {
          actions: ["iam:PassRole"],
          resources: [cronSchedulerRole.arn],
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
        {
          actions: [
            "s3:GetObject",
            "s3:PutObject",
            "s3:DeleteObject",
          ],
          resources: [`${toolBundlesBucketArn}/*`],
        },
        {
          actions: ["s3:ListBucket"],
          resources: [toolBundlesBucketArn],
        },
      ],
    });

    return {
      agentServiceUrl: harnessProcessing.url,
      accountServiceUrl: accountManage.url,
      mockWebhookSubscribeUrl: mockWebhookSubscribe.url,
      sandboxMountNetFunctionName: names.sandboxMountNet,
      sandboxMountNoNetFunctionName: names.sandboxMountNonet,
      sandboxNoMountNetFunctionName: names.sandboxNomountNet,
      sandboxNoMountNoNetFunctionName: names.sandboxNomountNonet,
      accountConfigsTableName: accountConfigsTable?.name,
      agentConfigsTableName: agentConfigsTable?.name,
      sandboxConfigsTableName: sandboxConfigsTable?.name,
      workspaceConfigsTableName: workspaceConfigsTable?.name,
      accountToolsTableName: accountToolsTable?.name,
      cronJobsTableName: cronJobsTable?.name,
      accountSignupRateLimitTableName: accountSignupRateLimitTable.name,
      conversationsTableName: conversationsTable.name,
      processedEventsTableName: processedEventsTable.name,
      asyncAgentResultTableName: asyncAgentResultTable.name,
      asyncToolResultTableName: asyncToolResultTable.name,
      cronScheduleGroupName: cronScheduleGroup.name,
      filesystemBucketName: filesystemBucket.name,
      skillsBucketName: skillsBucket.name,
      toolBundlesBucketName: toolBundlesBucket.name,
    };
  },
});
