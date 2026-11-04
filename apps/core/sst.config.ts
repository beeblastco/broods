/// <reference path="./.sst/platform/config.d.ts" />

const AWS_ACCOUNT_ID = requiredEnv("AWS_ACCOUNT_ID");
const PROJECT_NAME = requiredEnv("PROJECT_NAME");
const PROJECT_OWNER_EMAIL = requiredEnv("PROJECT_OWNER_EMAIL");
const AWS_PROFILE = process.env.CI
  ? undefined
  : (process.env.AWS_PROFILE ?? "default");
const SANDBOX_IMAGE_READY = parseBooleanEnv("SANDBOX_IMAGE_READY", false);
const CONVEX_URL = process.env.CONVEX_URL?.trim();
const CONVEX_DEPLOY_KEY = process.env.CONVEX_DEPLOY_KEY?.trim();
const OTEL_EXPORTER_OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || "https://otel.beeblast.co";
const OTEL_EXPORTER_OTLP_HEADERS =
  process.env.OTEL_EXPORTER_OTLP_HEADERS?.trim();
// The cluster's public IPs: change it before the cluster's address does, or prod AWS calls fail.
const RUNTIME_EGRESS_IPS_RAW = process.env.RUNTIME_EGRESS_IPS?.trim() ?? "";
const RUNTIME_EGRESS_IPS = RUNTIME_EGRESS_IPS_RAW.split(",")
  .map((ip) => ip.trim())
  .filter((ip) => ip.length > 0);
if (RUNTIME_EGRESS_IPS_RAW && RUNTIME_EGRESS_IPS.length === 0) {
  throw new Error("RUNTIME_EGRESS_IPS is set but lists no IP address");
}

// A new role's trust policy is not assumable at once: the connector create failed 8s after it.
const IAM_PROPAGATION_SECONDS = 45;

interface NetworkConnectorProperties {
  Arn: string;
}

interface BucketDenyStatement {
  effect: "deny";
  principals: "*";
  actions: string[];
  conditions: { test: string; variable: string; values: string[] }[];
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

function accountRegionalBucketName(
  service: string,
  stage: string,
  region: string,
): string {
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

// wrangler, since the Cloudflare provider declares no Worker Loader binding or Container image.
// No delete: a removed stage's Worker (and the bridge's Container app) is deleted by hand.
async function deployCloudflareWorker(
  command: typeof import("@pulumi/command"),
  stage: string,
  region: string,
  service: string,
  sources: string[] = [],
  vars: Record<string, $util.Input<string>> = {},
): Promise<string> {
  const name = resourceName(service, stage, region);
  const app = `apps/cloudflare-${service}`;
  new command.local.Command(`CloudflareWorker-${service}`, {
    dir: `${$cli.paths.root}/../cloudflare-${service}`,
    create: "bun run deploy",
    environment: {
      WORKER_NAME: name,
      // Read by nothing: a new value is what reruns the deploy.
      SOURCES_HASH: await sourceFilesHash([app, ...sources]),
      ...vars,
    },
  });

  return name;
}

// SST runs this file in Node and allows no top-level imports, hence the lazy ones.
async function sourceFilesHash(paths: string[]): Promise<string> {
  const { execFileSync } = await import("node:child_process");
  const { createHash } = await import("node:crypto");
  const git = (args: string[]): string =>
    execFileSync("git", ["-C", `${$cli.paths.root}/../..`, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  const list = (flags: string[]): string[] =>
    git(["ls-files", "-z", ...flags, "--", ...paths])
      .split("\0")
      .filter(Boolean);
  const deleted = new Set(list(["--deleted"]));
  const files = list([
    "--cached",
    "--others",
    "--exclude-standard",
    "--deduplicate",
  ]).filter((file) => !deleted.has(file));

  return createHash("sha256")
    .update(files.join("\0"))
    .update(git(["hash-object", "--", ...files]))
    .digest("hex");
}

interface PermissionStatement {
  effect?: "Allow" | "Deny";
  actions: string[];
  resources: $util.Input<string>[];
  conditions?: Record<string, Record<string, string | string[]>>;
}

function permissionsPolicy(perms: PermissionStatement[]): $util.Output<string> {
  return $jsonStringify({
    Version: "2012-10-17",
    Statement: perms.map((p) => ({
      Effect: p.effect ?? "Allow",
      Action: p.actions,
      Resource: p.resources,
      ...(p.conditions ? { Condition: p.conditions } : {}),
    })),
  });
}

// Bring-your-own buckets: any customer role, but only with the per-account sts:ExternalId
// (packages/convex/model/storageTrust.ts), and never a role in this account.
const CUSTOMER_STORAGE_ROLE_PERMISSIONS: PermissionStatement[] = [
  {
    actions: ["sts:AssumeRole"],
    resources: ["arn:aws:iam::*:role/*"],
    conditions: { Null: { "sts:ExternalId": "false" } },
  },
  {
    effect: "Deny",
    actions: ["sts:AssumeRole"],
    resources: [`arn:aws:iam::${AWS_ACCOUNT_ID}:role/*`],
    conditions: { Null: { "sts:ExternalId": "false" } },
  },
];

function denyUnlessProjectPrincipal(
  stage: string,
  region: string,
): BucketDenyStatement {
  return {
    effect: "deny" as const,
    principals: "*" as const,
    actions: ["s3:*"],
    conditions: [
      {
        test: "StringNotLikeIfExists",
        variable: "aws:PrincipalArn",
        values: [
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/${resourceName("sandbox-s3mount", stage, region)}`,
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/${resourceName("microvm-build", stage, region)}`,
          `arn:aws:iam::${AWS_ACCOUNT_ID}:role/${resourceName("microvm-execution", stage, region)}`,
          `arn:aws:iam::${AWS_ACCOUNT_ID}:user/${resourceName("core-runtime", stage, region)}`,
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
  app: function (input) {
    const stage = input?.stage ?? "dev";
    const region = awsRegion();

    return {
      name: PROJECT_NAME,
      removal: isProductionStage(stage) ? "retain" : "remove",
      protect: isProductionStage(stage),
      home: "aws",
      providers: {
        command: "1.0.1",
        aws: {
          region: region,
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

  run: async function () {
    const aws = await import("@pulumi/aws");
    const command = await import("@pulumi/command");
    const stage = $app.stage;
    const region = awsRegion();
    const isProduction = isProductionStage(stage);
    const enableMicrovmPrereqs = microvmPrereqsEnabled(region);
    const useConvexStorage = Boolean(CONVEX_URL && CONVEX_DEPLOY_KEY);
    if (!useConvexStorage) {
      throw new Error(
        "All stages require CONVEX_URL and CONVEX_DEPLOY_KEY env vars",
      );
    }
    const names = {
      filesystem: accountRegionalBucketName("filesystem", stage, region),
      skills: accountRegionalBucketName("skills", stage, region),
      toolBundles: accountRegionalBucketName("tool-bundles", stage, region),
      microvmArtifacts: accountRegionalBucketName(
        "microvm-artifacts",
        stage,
        region,
      ),
      microvmBuildRole: resourceName("microvm-build", stage, region),
      microvmExecutionRole: resourceName("microvm-execution", stage, region),
      microvmEgressConnector: resourceName("microvm-egress", stage, region),
    };

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
              Action: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
              ],
              Resource: [
                `arn:aws:logs:${region}:${AWS_ACCOUNT_ID}:log-group:/aws/lambda-microvms/*`,
              ],
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
              Action: [
                "ecr:BatchCheckLayerAvailability",
                "ecr:BatchGetImage",
                "ecr:GetDownloadUrlForLayer",
              ],
              Resource: [
                `arn:aws:ecr:${region}:${AWS_ACCOUNT_ID}:repository/*`,
              ],
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
    const microvmLogGroup = enableMicrovmPrereqs
      ? new aws.cloudwatch.LogGroup("MicrovmRuntimeLogGroup", {
          name: microvmLogGroupName,
          retentionInDays: 30,
        })
      : null;

    if (microvmLogGroup && OTEL_EXPORTER_OTLP_HEADERS) {
      const sandboxLogForwarder = new sst.aws.Function("SandboxLogForwarder", {
        handler: "../lambda/sandbox-log-forwarder.handler",
        runtime: "nodejs22.x",
        architecture: "arm64",
        timeout: "30 seconds",
        memory: "256 MB",
        environment: {
          OTEL_EXPORTER_OTLP_ENDPOINT: OTEL_EXPORTER_OTLP_ENDPOINT,
          OTEL_EXPORTER_OTLP_HEADERS: $util.secret(OTEL_EXPORTER_OTLP_HEADERS),
        },
        transform: {
          function: {
            name: resourceName("sandbox-log-forwarder", stage, region),
          },
        },
      });
      const sandboxLogForwarderInvoke = new aws.lambda.Permission(
        "SandboxLogForwarderInvoke",
        {
          action: "lambda:InvokeFunction",
          function: sandboxLogForwarder.name,
          principal: "logs.amazonaws.com",
          sourceArn: $interpolate`${microvmLogGroup.arn}:*`,
        },
      );
      new aws.cloudwatch.LogSubscriptionFilter(
        "MicrovmRuntimeLogsToLoki",
        {
          logGroup: microvmLogGroup.name,
          filterPattern: "",
          destinationArn: sandboxLogForwarder.arn,
        },
        { dependsOn: [sandboxLogForwarderInvoke] },
      );
    } else if (microvmLogGroup) {
      console.warn(
        "OTEL_EXPORTER_OTLP_HEADERS is not set: skipping the sandbox log forwarder, MicroVM guest logs stay in CloudWatch only.",
      );
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
              Action: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
              ],
              Resource: [
                `arn:aws:logs:${region}:${AWS_ACCOUNT_ID}:log-group:${microvmLogGroupName}`,
                `arn:aws:logs:${region}:${AWS_ACCOUNT_ID}:log-group:${microvmLogGroupName}:*`,
              ],
            },
          ],
        }),
      });
    }

    // Deliberately NAT-less: deny-all / restricted sandboxes keep only the workspace S3 mount,
    // over the free gateway endpoint. A NAT costs per AZ and gives back the internet they remove.
    const sandboxNetwork = enableMicrovmPrereqs
      ? new sst.aws.Vpc("SandboxNetwork", { az: 2 })
      : null;

    // Managed bucket only: a deny-all sandbox on a bring-your-own bucket cannot reach its mount.
    if (sandboxNetwork) {
      new aws.ec2.VpcEndpoint("SandboxS3Endpoint", {
        vpcId: sandboxNetwork.id,
        serviceName: `com.amazonaws.${region}.s3`,
        vpcEndpointType: "Gateway",
        policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: "*",
              Action: "s3:*",
              Resource: [filesystemBucketArn, `${filesystemBucketArn}/*`],
            },
          ],
        }),
        routeTableIds: sandboxNetwork.nodes.privateRouteTables.apply(
          (routeTables) => routeTables.map((routeTable) => routeTable.id),
        ),
      });
    }

    const sandboxEgressSecurityGroup = sandboxNetwork
      ? new aws.ec2.SecurityGroup("SandboxEgressSecurityGroup", {
          name: resourceName("microvm-egress-sg", stage, region),
          description: "MicroVM sandbox egress: workspace S3 only",
          vpcId: sandboxNetwork.id,
          egress: [
            {
              description: "Workspace S3 over the gateway endpoint",
              protocol: "tcp",
              fromPort: 443,
              toPort: 443,
              prefixListIds: [
                aws.ec2.getManagedPrefixListOutput({
                  name: `com.amazonaws.${region}.s3`,
                }).id,
              ],
            },
          ],
        })
      : null;

    // No confused-deputy conditions: connector assume-role calls carry no SourceArn/SourceAccount.
    // The policy below bounds it instead: ENIs only in these subnets, with this security group.
    const sandboxConnectorRole = sandboxNetwork
      ? new aws.iam.Role("SandboxConnectorOperatorRole", {
          name: resourceName("microvm-connector", stage, region),
          assumeRolePolicy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "lambda.amazonaws.com" },
                Action: "sts:AssumeRole",
              },
            ],
          }),
        })
      : null;

    const sandboxConnectorRolePolicy =
      sandboxNetwork && sandboxEgressSecurityGroup && sandboxConnectorRole
        ? new aws.iam.RolePolicy("SandboxConnectorOperatorRolePolicy", {
            role: sandboxConnectorRole.id,
            policy: $jsonStringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "CreateConnectorNetworkInterfaceInSubnets",
                  Effect: "Allow",
                  Action: "ec2:CreateNetworkInterface",
                  Resource: $resolve({
                    subnetIds: sandboxNetwork.privateSubnets,
                  }).apply(({ subnetIds }) =>
                    subnetIds.map(
                      (subnetId) =>
                        `arn:aws:ec2:${region}:${AWS_ACCOUNT_ID}:subnet/${subnetId}`,
                    ),
                  ),
                },
                {
                  Sid: "CreateConnectorNetworkInterfaceWithSecurityGroup",
                  Effect: "Allow",
                  Action: "ec2:CreateNetworkInterface",
                  Resource: [
                    $interpolate`arn:aws:ec2:${region}:${AWS_ACCOUNT_ID}:security-group/${sandboxEgressSecurityGroup.id}`,
                  ],
                },
                {
                  Sid: "CreateTaggedConnectorNetworkInterface",
                  Effect: "Allow",
                  Action: "ec2:CreateNetworkInterface",
                  Resource: [
                    `arn:aws:ec2:${region}:${AWS_ACCOUNT_ID}:network-interface/*`,
                  ],
                  Condition: {
                    "ForAllValues:StringEquals": {
                      "aws:TagKeys": [
                        "aws:lambda:networkConnectorName",
                        "aws:lambda:networkConnectorId",
                      ],
                    },
                  },
                },
                {
                  Sid: "TagConnectorNetworkInterfaces",
                  Effect: "Allow",
                  Action: ["ec2:CreateTags"],
                  Resource: [
                    `arn:aws:ec2:${region}:${AWS_ACCOUNT_ID}:network-interface/*`,
                  ],
                  Condition: {
                    StringEquals: {
                      "ec2:CreateAction": "CreateNetworkInterface",
                      "ec2:ManagedResourceOperator":
                        "network-connectors.lambda.amazonaws.com",
                    },
                  },
                },
              ],
            }),
          })
        : null;

    const sandboxConnectorRoleReady =
      sandboxConnectorRole && sandboxConnectorRolePolicy
        ? new command.local.Command(
            "SandboxConnectorRoleReady",
            {
              create: `sleep ${IAM_PROPAGATION_SECONDS}`,
              triggers: [
                sandboxConnectorRole.arn,
                sandboxConnectorRolePolicy.id,
              ],
            },
            { dependsOn: [sandboxConnectorRole, sandboxConnectorRolePolicy] },
          )
        : null;

    const sandboxEgressConnector =
      sandboxNetwork &&
      sandboxEgressSecurityGroup &&
      sandboxConnectorRole &&
      sandboxConnectorRolePolicy &&
      sandboxConnectorRoleReady
        ? new aws.cloudcontrol.Resource(
            "SandboxEgressConnector",
            {
              typeName: "AWS::Lambda::NetworkConnector",
              desiredState: $jsonStringify({
                Name: names.microvmEgressConnector,
                OperatorRole: sandboxConnectorRole.arn,
                Configuration: {
                  VpcEgressConfiguration: {
                    SubnetIds: sandboxNetwork.privateSubnets,
                    SecurityGroupIds: [sandboxEgressSecurityGroup.id],
                    NetworkProtocol: "IPv4",
                    AssociatedComputeResourceTypes: ["MicroVm"],
                  },
                },
              }),
            },
            // desiredState never references the ENI policy, so without this the two race.
            {
              dependsOn: [
                sandboxConnectorRolePolicy,
                sandboxConnectorRoleReady,
              ],
            },
          )
        : null;

    const microvmEgressConnectorArn = sandboxEgressConnector
      ? sandboxEgressConnector.properties.apply((properties) => {
          const arn = (JSON.parse(properties) as NetworkConnectorProperties)
            .Arn;
          if (typeof arn !== "string" || arn.trim() === "") {
            throw new Error(
              "AWS::Lambda::NetworkConnector returned no connector ARN",
            );
          }

          return arn;
        })
      : undefined;

    const coreRuntimeUser = new aws.iam.User("CoreRuntimeUser", {
      name: resourceName("core-runtime", stage, region),
    });

    // Sandboxes get short-lived, prefix-scoped sessions of this role, never core's own keys.
    const sandboxS3MountRole = new aws.iam.Role("SandboxS3MountRole", {
      name: resourceName("sandbox-s3mount", stage, region),
      assumeRolePolicy: $jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowCoreRuntimeAssumeRole",
            Effect: "Allow",
            Principal: { AWS: coreRuntimeUser.arn },
            Action: [
              "sts:AssumeRole",
              "sts:SetSourceIdentity",
              "sts:TagSession",
            ],
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

    const sandboxImageRepoName = `beeblast-lambda-sandbox-${AWS_ACCOUNT_ID}-${region}`;
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
        // Not PROJECT_NAME-scoped: lambda-sanbdox CI pushes to this exact name.
        ...(SANDBOX_IMAGE_READY ? { import: sandboxImageRepoName } : {}),
      },
    );

    // Principal "*": the daytona sandbox provider pulls cross-account.
    new aws.ecr.RepositoryPolicy("SandboxImagePolicy", {
      repository: sandboxEcr.name,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowCrossAccountPull",
            Effect: "Allow",
            Principal: "*",
            Action: [
              "ecr:GetDownloadUrlForLayer",
              "ecr:BatchGetImage",
              "ecr:BatchCheckLayerAvailability",
            ],
          },
        ],
      }),
    });

    // Tenancy mode is immutable, so each mode owns its id and name. Off until AWS allows it (#654).
    const mcpTenantIsolation = parseBooleanEnv("MCP_TENANT_ISOLATION", false);
    const mcpRunnerFn = new sst.aws.Function(
      mcpTenantIsolation ? "McpRunner" : "ToolRunner",
      {
        handler: "../lambda/handler.handler",
        runtime: "nodejs22.x",
        architecture: "arm64",
        timeout: "35 seconds",
        // One full vCPU: this is CPU-bound, so a smaller size bills the same GB-ms, only slower.
        memory: "1769 MB",
        copyFiles: [
          {
            from: "../lambda/child-runner.mjs",
            to: "child-runner.mjs",
          },
        ],
        transform: {
          function: {
            name: resourceName(
              mcpTenantIsolation ? "mcp-runner" : "tool-runner",
              stage,
              region,
            ),
            ...(mcpTenantIsolation
              ? { tenancyConfig: { tenantIsolationMode: "PER_TENANT" } }
              : {}),
          },
        },
      },
    );

    const harnessPermissions = [
      {
        actions: ["lambda:InvokeFunction"],
        resources: [mcpRunnerFn.arn],
      },
      {
        actions: ["sts:AssumeRole", "sts:SetSourceIdentity", "sts:TagSession"],
        resources: [sandboxS3MountRole.arn],
      },
      ...CUSTOMER_STORAGE_ROLE_PERMISSIONS,
      {
        actions: ["kms:Decrypt"],
        resources: ["*"],
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
                "lambda:GetMicrovmImageVersion",
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
                // A snapshot builds on the Lambda-managed base image of its source image.
                `arn:aws:lambda:${region}:aws:microvm-image:*`,
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
              actions: [
                "s3:GetObject",
                "s3:HeadObject",
                "s3:PutObject",
                "s3:DeleteObject",
              ],
              resources: [`${microvmArtifactsBucketArn}/microvm-images/*`],
            },
            {
              actions: ["s3:ListBucket"],
              resources: [microvmArtifactsBucketArn],
            },
          ]
        : []),
    ];

    const accountManagePermissions = [
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

    // Managed, not inline: IAM caps a user's inline policies at 2048 chars in total.
    const coreRuntimeHarnessPolicy = new aws.iam.Policy(
      "CoreRuntimeHarnessPolicy",
      {
        name: resourceName("core-runtime-harness", stage, region),
        policy: permissionsPolicy(harnessPermissions),
      },
    );
    const coreRuntimeAccountPolicy = new aws.iam.Policy(
      "CoreRuntimeAccountPolicy",
      {
        name: resourceName("core-runtime-account", stage, region),
        policy: permissionsPolicy(accountManagePermissions),
      },
    );
    new aws.iam.UserPolicyAttachment("CoreRuntimeHarnessPolicyAttachment", {
      user: coreRuntimeUser.name,
      policyArn: coreRuntimeHarnessPolicy.arn,
    });
    new aws.iam.UserPolicyAttachment("CoreRuntimeAccountPolicyAttachment", {
      user: coreRuntimeUser.name,
      policyArn: coreRuntimeAccountPolicy.arn,
    });

    const convexAwsPermissions = [
      {
        actions: [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:HeadObject",
        ],
        resources: [
          `${skillsBucketArn}/*`,
          `${toolBundlesBucketArn}/*`,
          `${filesystemBucketArn}/*`,
        ],
      },
      {
        actions: ["s3:ListBucket"],
        resources: [skillsBucketArn, toolBundlesBucketArn, filesystemBucketArn],
      },
      ...CUSTOMER_STORAGE_ROLE_PERMISSIONS,
    ];
    const convexAwsRole = new aws.iam.Role("ConvexAwsRole", {
      name: resourceName("convex-aws", stage, region),
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              AWS: `arn:aws:iam::${AWS_ACCOUNT_ID}:user/${resourceName("convex-bootstrap", stage, region)}`,
            },
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
    const convexBootstrapUser = new aws.iam.User("ConvexBootstrapUser", {
      name: resourceName("convex-bootstrap", stage, region),
    });
    new aws.iam.UserPolicy("ConvexBootstrapAssumePolicy", {
      user: convexBootstrapUser.name,
      policy: convexAwsRole.arn.apply((arn) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            { Effect: "Allow", Action: "sts:AssumeRole", Resource: arn },
          ],
        }),
      ),
    });
    // Static keys live only on the cluster; sessions of the roles they assume are not affected.
    if (isProduction && RUNTIME_EGRESS_IPS.length > 0) {
      const sourceIpLock = permissionsPolicy([
        {
          effect: "Deny",
          actions: ["*"],
          resources: ["*"],
          conditions: {
            NotIpAddress: { "aws:SourceIp": RUNTIME_EGRESS_IPS },
            Bool: { "aws:ViaAWSService": "false" },
          },
        },
      ]);
      new aws.iam.UserPolicy("CoreRuntimeSourceIpLock", {
        user: coreRuntimeUser.name,
        policy: sourceIpLock,
      });
      new aws.iam.UserPolicy("ConvexBootstrapSourceIpLock", {
        user: convexBootstrapUser.name,
        policy: sourceIpLock,
      });
    }

    const cloudflareWorkers = process.env.CLOUDFLARE_API_TOKEN
      ? {
          mcp: await deployCloudflareWorker(
            command,
            stage,
            region,
            "mcp",
            ["apps/cloudflare-sandbox/src/bearer.ts", "bun.lock"],
            {
              BUNDLE_ORIGIN: $interpolate`https://${toolBundlesBucket.name}.s3.${region}.amazonaws.com`,
            },
          ),
          // No bun.lock: a lockfile-only bump must not redeploy live sandboxes.
          sandbox: await deployCloudflareWorker(
            command,
            stage,
            region,
            "sandbox",
          ),
          worker: await deployCloudflareWorker(
            command,
            stage,
            region,
            "worker",
            ["apps/cloudflare-sandbox/src/bearer.ts", "bun.lock"],
          ),
        }
      : undefined;

    return {
      filesystemBucketName: filesystemBucket.name,
      skillsBucketName: skillsBucket.name,
      toolBundlesBucketName: toolBundlesBucket.name,
      toolRunnerFunctionName: mcpRunnerFn.name,
      cloudflareWorkers: cloudflareWorkers,
      microvmArtifactsBucketName: microvmArtifactsBucket?.name,
      microvmBuildRoleArn: microvmBuildRole?.arn,
      microvmExecutionRoleArn: microvmExecutionRole?.arn,
      microvmEgressNetworkConnectorArn: microvmEgressConnectorArn,
      coreRuntimeUserName: coreRuntimeUser.name,
      convexAwsRoleArn: convexAwsRole.arn,
      convexBootstrapUserName: convexBootstrapUser.name,
    };
  },
});
