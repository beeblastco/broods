import type { SandboxConfig } from "../../../packages/convex/model/sandboxRules.ts";
import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  persistentSandboxKeepsFile,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

const VERCEL_ENV = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"];

/**
 * The vercel provider through the config plane: an idle window past Vercel's
 * 24 hour session cap is refused. With VERCEL_TOKEN, VERCEL_TEAM_ID and
 * VERCEL_PROJECT_ID on core and a model key, an agent writes a file in one turn
 * and reads it back in the next on the same reserved Vercel sandbox. With
 * FILESYSTEM_BUCKET_NAME and SANDBOX_MOUNT_ROLE_ARN too, an agent on a reserved
 * sandbox writes a workspace file that another agent reads from a fresh one,
 * which only the S3 mount can carry across.
 */
export async function vercelSandbox(context: VerifyContext): Promise<void> {
  const key = `vercel-${context.runId}`;
  const refused = await context.account
    .createSandbox({
      name: `${key}-idle`,
      config: {
        provider: "vercel",
        persistent: true,
        lifecycle: { idleTimeoutSeconds: 24 * 60 * 60 + 1 },
      },
    })
    .then(
      (): string => "created",
      (error: unknown): string => String(error),
    );
  assertStep(
    "a vercel idle window past 24 hours is refused",
    refused.includes("must be at most 86400 on the vercel provider"),
    refused,
  );
  const secure = await context.account.createSandbox({
    name: `${key}-secure`,
    config: { provider: "vercel", options: { networkId: "net_verify" } },
  });
  assertStep(
    "a vercel sandbox keeps its Secure Compute networkId",
    secure.config.options?.networkId === "net_verify",
    JSON.stringify(secure.config),
  );

  const missing = VERCEL_ENV.filter((name): boolean => !process.env[name]);
  if (missing.length > 0 || !context.hasModelKey) {
    console.log(
      `  skip agents on vercel sandboxes (set ${VERCEL_ENV.join(", ")} and ${MODEL_KEY_HINT})`,
    );
    return;
  }
  const sandbox = await context.account.createSandbox({
    name: key,
    config: {
      provider: "vercel",
      persistent: true,
      permissionMode: "bypass",
      network: { mode: "deny-all" },
      lifecycle: { idleTimeoutSeconds: 600 },
    },
  });
  await persistentSandboxKeepsFile(context, {
    key: key,
    label: "vercel",
    path: "/tmp/marker",
    sandboxId: sandbox.sandboxId,
  });

  if (
    !process.env.FILESYSTEM_BUCKET_NAME ||
    !process.env.SANDBOX_MOUNT_ROLE_ARN
  ) {
    console.log(
      "  skip the vercel workspace mount (set FILESYSTEM_BUCKET_NAME and SANDBOX_MOUNT_ROLE_ARN)",
    );
    return;
  }
  await workspaceCrossesSandboxes(context, `${key}-ws`);
}

// A file one agent writes in the workspace on a reserved sandbox, read by
// another agent from an ephemeral sandbox that boots fresh for that call.
async function workspaceCrossesSandboxes(
  context: VerifyContext,
  key: string,
): Promise<void> {
  const workspace = await context.account.createWorkspace({
    name: key,
    config: { storage: { provider: "s3" } },
  });
  const sandboxConfig = (persistent: boolean): SandboxConfig => ({
    provider: "vercel",
    persistent: persistent,
    permissionMode: "bypass",
    network: { mode: "allow-all" },
    options: { mountAwsS3Buckets: true },
  });
  const writer = await context.account.createSandbox({
    name: `${key}-writer`,
    config: sandboxConfig(true),
  });
  const reader = await context.account.createSandbox({
    name: `${key}-reader`,
    config: sandboxConfig(false),
  });
  const agentOn = async (sandboxId: string, name: string): Promise<string> => {
    const { agentId } = await context.account.createAgent({
      name: name,
      config: {
        ...context.model,
        agent: {
          system:
            "Use the bash tool to run exactly the command the user gives in the workspace, then reply with exactly its output and nothing else.",
        },
        sandboxes: [sandboxId],
        workspaces: [{ name: "notes", workspaceId: workspace.workspaceId }],
      },
    });

    return agentId;
  };
  const turn = async (
    agentId: string,
    step: string,
    text: string,
  ): Promise<AsyncStatus> =>
    await context.measure(step, (): Promise<AsyncStatus> =>
      runToTerminal(context, {
        agentId: agentId,
        conversationKey: `${key}-${step}`,
        eventId: `${key}-${step}`,
        text: text,
      }),
    );
  const marker = `vercel-s3-${context.runId}`;
  const reversed = marker.split("").reverse().join("");
  const wrote = await turn(
    await agentOn(writer.sandboxId, `${key}-writer`),
    "vercel workspace write",
    `Run: echo ${marker} > notes.txt && sync && echo written`,
  );
  const read = await turn(
    await agentOn(reader.sandboxId, `${key}-reader`),
    "vercel workspace read",
    "Run: rev notes.txt",
  );
  assertStep(
    "a vercel workspace file written on one sandbox is read from a fresh one",
    wrote.status === "completed" &&
      read.status === "completed" &&
      JSON.stringify(read.response ?? "").includes(reversed),
    `${JSON.stringify(wrote)}\n${JSON.stringify(read)}`,
  );
}
