import { createHash } from "node:crypto";
import type { AsyncStatus } from "../../../packages/broods/src/types.ts";
import {
  MODEL_KEY_HINT,
  assertStep,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

const VERCEL_ENV = ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"];

/**
 * The vercel provider through the config plane: an idle window past Vercel's
 * 24 hour session cap is refused. With VERCEL_TOKEN, VERCEL_TEAM_ID and
 * VERCEL_PROJECT_ID on core and a model key, an agent writes a file in one turn
 * and hashes it in the next on the same reserved Vercel sandbox. A hash is
 * something the model cannot make up from the conversation, and the Vercel
 * images ship `sha256sum` but not `rev`.
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
  const agentId = await commandAgent(context, key, sandbox.sandboxId);
  const marker = `vercel-${context.runId}`;
  const wrote = await turn(
    context,
    agentId,
    key,
    "vercel write",
    `Run: echo ${marker} > /tmp/marker`,
  );
  const read = await turn(
    context,
    agentId,
    key,
    "vercel read",
    "Run: sha256sum /tmp/marker",
  );
  assertStep(
    "a persistent vercel sandbox keeps a file between turns",
    wrote.status === "completed" &&
      read.status === "completed" &&
      JSON.stringify(read.response ?? "").includes(sha256(`${marker}\n`)),
    `${JSON.stringify(wrote)}\n${JSON.stringify(read)}`,
  );
}

// An agent that runs exactly the command it is given on one sandbox.
async function commandAgent(
  context: VerifyContext,
  name: string,
  sandboxId: string,
  workspaceId?: string,
): Promise<string> {
  const { agentId } = await context.account.createAgent({
    name: name,
    config: {
      ...context.model,
      agent: {
        system:
          "Use the bash tool to run exactly the command the user gives, then reply with exactly its output and nothing else.",
      },
      sandboxes: [sandboxId],
      ...(workspaceId
        ? { workspaces: [{ name: "notes", workspaceId: workspaceId }] }
        : {}),
    },
  });

  return agentId;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function turn(
  context: VerifyContext,
  agentId: string,
  conversationKey: string,
  step: string,
  text: string,
): Promise<AsyncStatus> {
  return await context.measure(step, (): Promise<AsyncStatus> =>
    runToTerminal(context, {
      agentId: agentId,
      conversationKey: conversationKey,
      eventId: `${conversationKey}-${step}`,
      text: text,
    }),
  );
}
