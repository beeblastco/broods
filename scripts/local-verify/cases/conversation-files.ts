import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import { signUserToken } from "../../../packages/broods/src/user-token.ts";
import { USER_TOKEN_HEADER } from "../../../packages/convex/model/userToken.ts";
import { OK_AGENT, assertStep, type VerifyContext } from "../harness.ts";

// CLOUDFLARE_WORKER_URL on core: `bun run dev` in apps/cloudflare-worker, or a deployed Worker.
export async function conversationFiles(context: VerifyContext): Promise<void> {
  const project = `files-${context.runId}`;
  const sync = new BroodsSyncClient({
    baseUrl: context.edgeUrl,
    token: context.accountSecret,
  });
  const deployed = await sync.putManifest(
    {
      version: 1,
      project: project,
      stage: "development",
      resources: [
        {
          kind: "sandbox",
          name: "disk",
          config: {
            provider: "worker",
            persistent: true,
            permissionMode: "bypass",
            network: { mode: "deny-all" },
          },
        },
        {
          kind: "workspace",
          name: "project",
          config: { storage: { provider: "disk" } },
        },
        {
          kind: "agent",
          name: "coder",
          config: {
            ...context.model,
            agent: OK_AGENT,
            publicAccess: true,
            sandboxes: ["disk"],
            workspaces: [{ name: "project", workspaceId: "project" }],
          },
        },
      ],
    },
    true,
  );
  const agentId = deployed.ids.agents.coder;
  const { deployment } = deployed;
  if (!process.env.CLOUDFLARE_WORKER_URL || !deployment || !agentId) {
    console.log("  skip conversation files (set CLOUDFLARE_WORKER_URL)");
    return;
  }
  const rotated = await sync.rotateUserTokenSecret(project, "development");
  const tokenFor = (userId: string): Promise<string> =>
    signUserToken({ userId: userId, secret: rotated?.secret ?? "" });
  const url = `${context.edgeUrl}/v1/projects/${deployment.projectSlug}/stages/${deployment.stageSlug}/agents/${deployment.endpointId}/files?agentId=${agentId}&conversationKey=chat`;
  const call = async (
    method: string,
    userId: string | null,
    body?: unknown,
  ): Promise<{ status: number; body: { files?: unknown } }> => {
    const response = await fetch(url, {
      method: method,
      headers: {
        Authorization: `Bearer ${deployment.apiKey}`,
        "Content-Type": "application/json",
        ...(userId ? { [USER_TOKEN_HEADER]: await tokenFor(userId) } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    return { status: response.status, body: await response.json() };
  };
  const seed = {
    files: [
      { path: "broods/index.ts", contentBase64: btoa("export {};\n") },
      { path: "package.json", contentBase64: btoa("{}\n") },
    ],
  };

  const put = await context.measure("seed a conversation folder", () =>
    call("PUT", "alice", seed),
  );
  const read = await context.measure("read it back", () =>
    call("GET", "alice"),
  );
  const other = await call("GET", "bob");
  const anonymous = await call("GET", null);
  assertStep(
    "a user seeds and reads back only their own conversation's folder",
    put.status === 200 &&
      JSON.stringify(read.body.files) === JSON.stringify(seed.files) &&
      JSON.stringify(other.body.files) === "[]" &&
      anonymous.status === 403,
    JSON.stringify({
      put: put,
      read: read,
      other: other,
      anonymous: anonymous,
    }),
  );
}
