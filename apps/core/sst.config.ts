/// <reference path="./.sst/platform/config.d.ts" />

// SST provisions the AWS data plane and the container runtime IAM user.
// The runtime itself is the Bun container deployed from the infra repo.
// AWS account + project identity for resource names, IAM role ARNs, and tags.
// No in-source defaults — provided via repo vars / local env (see .env.example).
// CI injects them into the validate + deploy jobs; forks must set them to run
// `sst install` / deploy.
const AWS_ACCOUNT_ID = requiredEnv("AWS_ACCOUNT_ID");
const PROJECT_NAME = requiredEnv("PROJECT_NAME");
const PROJECT_OWNER_EMAIL = requiredEnv("PROJECT_OWNER_EMAIL");
const AWS_PROFILE = process.env.CI
  ? undefined
  : (process.env.AWS_PROFILE ?? "default");
// Whether to import (vs first-create) the region-scoped sandbox ECR repo. The 4 image-based
// sandbox Lambdas this used to gate are gone — the "lambda" provider is now an AWS Lambda
// MicroVM (MicrovmSandboxExecutor) whose image is built from an S3 zip, not pulled from ECR.
// The ECR repo is retained transitionally (the lambda-sanbdox container image still publishes
// there); its teardown belongs to the Phase 4 infra cleanup. See docs/workspace/sandbox/lambda.md.
const SANDBOX_IMAGE_READY = parseBooleanEnv("SANDBOX_IMAGE_READY", false);
// Convex credentials are required for every stage and back all persistence.
// Runtime credentials live on the container (infra repo), not here.
const CONVEX_URL = process.env.CONVEX_URL?.trim();
const CONVEX_DEPLOY_KEY = process.env.CONVEX_DEPLOY_KEY?.trim();
// Sandbox log bridge target: the cluster's OTLP/HTTP collector ingress and the
// base64 `user:password` behind its Basic-auth middleware (infra repo,
// `otlp-basic-auth`). Optional: without the auth pair the bridge is not deployed.
const OTLP_ENDPOINT =
  process.env.OTLP_ENDPOINT?.trim() || "https://otel.beeblast.co";
const OTLP_BASIC_AUTH = process.env.OTLP_BASIC_AUTH?.trim();

// How long to let a freshly created IAM role's trust policy propagate before another
// AWS service is asked to assume it. Measured: the connector create failed 8s after the
// role appeared and only succeeded ~4.5 min later on the provider's own retry.
const IAM_PROPAGATION_SECONDS = 45;

// Resolved `AWS::Lambda::NetworkConnector` Cloud Control properties. `Arn` is the type
// schema's primaryIdentifier, so it is always present once the resource exists.
interface NetworkConnectorProperties {
  Arn: string;
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
function permissionsPolicy(
  perms: { actions: string[]; resources: $util.Input<string>[] }[],
) {
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
  app: function (input) {
    const stage = input?.stage ?? "dev";
    const region = awsRegion();

    return {
      name: PROJECT_NAME,
      removal: isProductionStage(stage) ? "retain" : "remove",
      protect: isProductionStage(stage),
      home: "aws",
      providers: {
        // Only for the IAM-propagation wait in front of the MicroVM egress connector.
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
    // Convex credentials are mandatory because every persistence domain lives there.
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
      // The connector name is createOnly and capped at 64 chars by the type schema.
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

    // Sandbox log bridge: every guest line the MicroVMs write to that group is
    // forwarded to the cluster's OTLP collector, which is the only write path into
    // Loki. The forwarder is a plain .mjs next to the hosted-MCP runner. It needs
    // the collector's Basic auth pair (base64 `user:password`, a CI secret), so a
    // deploy without it skips the bridge rather than shipping a function that
    // fails every invocation. See docs/observability.md.
    if (microvmLogGroup && OTLP_BASIC_AUTH) {
      const sandboxLogForwarder = new sst.aws.Function("SandboxLogForwarder", {
        handler: "../lambda/sandbox-log-forwarder.handler",
        runtime: "nodejs22.x",
        architecture: "arm64",
        timeout: "30 seconds",
        memory: "256 MB",
        environment: {
          OTLP_ENDPOINT: OTLP_ENDPOINT,
          OTLP_BASIC_AUTH: OTLP_BASIC_AUTH,
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
        "OTLP_BASIC_AUTH is not set: skipping the sandbox log forwarder, MicroVM guest logs stay in CloudWatch only.",
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

    // Sandbox egress network, used only by the MicroVM `deny-all` / `restricted` modes.
    // `allow-all` never reaches it: that mode runs on the service default INTERNET_EGRESS
    // with no connector at all. Deliberately NAT-less — the only outbound a restricted
    // sandbox still needs is the workspace S3 mount, which the free S3 Gateway VPC Endpoint
    // below serves off the private route tables. A NAT would cost ~$35/mo per AZ (the old
    // Vpc.v1 billed ~$130/mo per stage for exactly this) and hand back the internet access
    // these modes exist to remove. The component's public subnets + IGW go unused but free.
    const sandboxNetwork = enableMicrovmPrereqs
      ? new sst.aws.Vpc("SandboxNetwork", { az: 2 })
      : null;

    // Scoped to the managed workspace bucket, so a `deny-all` sandbox on a
    // bring-your-own-bucket workspace cannot reach its mount. Widen this policy before
    // offering those two together (see the lambda provider docs).
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

    // The connector's only egress rule. `deny-all` therefore means "no internet, workspace
    // S3 only" — an empty rule set would break the mount-s3 workspace every sandbox needs.
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

    // Lambda assumes this to manage the connector's ENIs in the sandbox VPC. Network
    // Connector assume-role calls do not include SourceArn/SourceAccount context, so the
    // usual confused-deputy conditions would deny every call. What bounds it instead is
    // the policy below: ENIs only in these subnets, only with this security group.
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

    // IAM is eventually consistent, so a role is not assumable the instant it exists:
    // creating the connector straight after the role fails with "unable to assume the
    // provided NetworkConnectorOperatorRole" until the trust policy propagates. Gate the
    // connector behind a wait that only runs when the role or its policy actually changes.
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

    // No Pulumi/Terraform resource exists for lambda-core network connectors, but the
    // CloudFormation type does — Cloud Control gives real create/update/delete plus the
    // PENDING → ACTIVE wait (ENI provisioning takes up to ~10 min on the first deploy).
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
            // The ENI policy must exist before Lambda assumes the role, or the connector
            // creates with no permission to build its interfaces. Nothing in desiredState
            // references the policy, so without this the two race.
            {
              dependsOn: [
                sandboxConnectorRolePolicy,
                sandboxConnectorRoleReady,
              ],
            },
          )
        : null;

    // Core reads this as MICROVM_EGRESS_NETWORK_CONNECTOR_ARN; without it the executor
    // fails closed rather than launching deny-all on the default internet egress.
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

    // This app owns the sandbox image ECR repo (moved out of the infra Terraform repo) so
    // the repo lifecycle stays in sync with the functions that consume it — no cross-repo
    // coordination. Lambda pulls only from PRIVATE ECR in its own region (public.ecr.aws is
    // rejected), so the repo is region-scoped: each deploy region gets its own. The arm64
    // image is pushed by the lambda-just-bash-rust CI; for a brand-new region that push must
    // land before the sandbox functions can be created (the first deploy creates the empty
    // repo, then re-deploy once the image exists). See docs/workspace/sandbox/lambda.md.
    const sandboxImageRepoName = `beeblast-lambda-sandbox-${AWS_ACCOUNT_ID}-${region}`;
    const sandboxImageRepoExists = ecrRepositoryExists(
      sandboxImageRepoName,
      region,
    );
    const sandboxImageRepoShouldImport =
      SANDBOX_IMAGE_READY || sandboxImageRepoExists;
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
        ...(sandboxImageRepoShouldImport
          ? { import: sandboxImageRepoName }
          : {}),
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
            Action: [
              "ecr:GetDownloadUrlForLayer",
              "ecr:BatchGetImage",
              "ecr:BatchCheckLayerAvailability",
            ],
          },
        ],
      }),
    });

    // Hosted-MCP runner: runs uploaded MCP server bundles in a scrubbed child
    // process. No VPC gives internet egress; core invokes it via
    // TOOL_RUNNER_FUNCTION_NAME. The "ToolRunner" logical id and the
    // tool-runner physical name predate the MCP role — renaming either
    // replaces the deployed function, so they stay.
    const toolRunnerFn = new sst.aws.Function("ToolRunner", {
      handler: "../lambda/handler.handler",
      runtime: "nodejs22.x",
      architecture: "arm64",
      timeout: "35 seconds",
      // 1769 MB is the one-full-vCPU step. Below it Lambda hands out a fraction
      // of a core, and this function's cost is almost all CPU — Node startup in
      // the child plus parsing a bundle — so a smaller size bills roughly the
      // same GB-ms while taking several times longer.
      memory: "1769 MB",
      copyFiles: [
        {
          from: "../lambda/child-runner.mjs",
          to: "child-runner.mjs",
        },
      ],
      transform: {
        function: { name: resourceName("tool-runner", stage, region) },
      },
    });

    // Harness-side permissions for the container runtime user (CoreRuntimeUser
    // below); the account-manage set follows further down.
    const harnessPermissions = [
      {
        actions: ["lambda:InvokeFunction"],
        resources: [toolRunnerFn.arn],
      },
      {
        actions: ["sts:AssumeRole"],
        resources: [sandboxS3MountRole.arn],
      },
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

    // Also granted to CoreRuntimeUser below, same as harnessPermissions.
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

    // AWS access for the Convex config plane (epic #85 phase 9 — state plane owns
    // AWS directly, no core proxy). Convex node actions assume ConvexAwsRole with a
    // minimal bootstrap user's static key (minted out of band, stored in the Convex
    // deployment env as AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY + CONVEX_AWS_ROLE_ARN)
    // and get short-lived credentials scoped to the skills/tool-bundle/workspace
    // S3 buckets. The role ARN is also allow-listed in
    // denyUnlessProjectPrincipal so its S3 calls are not denied.
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
          Statement: [
            { Effect: "Allow", Action: "sts:AssumeRole", Resource: arn },
          ],
        }),
      ),
    });

    return {
      filesystemBucketName: filesystemBucket.name,
      skillsBucketName: skillsBucket.name,
      toolBundlesBucketName: toolBundlesBucket.name,
      toolRunnerFunctionName: toolRunnerFn.name,
      microvmArtifactsBucketName: microvmArtifactsBucket?.name,
      microvmBuildRoleArn: microvmBuildRole?.arn,
      microvmExecutionRoleArn: microvmExecutionRole?.arn,
      // Set on the core pods as MICROVM_EGRESS_NETWORK_CONNECTOR_ARN (infra repo Helm
      // values); deny-all / restricted sandboxes cannot launch without it.
      microvmEgressNetworkConnectorArn: microvmEgressConnectorArn,
      coreRuntimeUserName: coreRuntimeUser.name,
      convexAwsRoleArn: convexAwsRole.arn,
      convexBootstrapUserName: convexBootstrapUser.name,
    };
  },
});
