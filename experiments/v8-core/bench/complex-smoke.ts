/**
 * Functional check before any timing: the complex agent (MCP, bash with files,
 * a delegated subagent) on Bun core + machine sandbox, core on workerd + V8
 * worker sandbox, and Bun core + V8 worker sandbox. Prints every tool call
 * and the final text so a human can read what each runtime actually did.
 */

import { runMachineDaemon } from "../../../packages/broods/src/cli/machine.ts";
import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import {
  complexTask,
  accountClient,
  complexConfig,
  createOrgAccount,
  edgeUrl,
  runtimeClient,
  stackState,
  type Runtime,
} from "./lib.ts";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error("set ANTHROPIC_API_KEY");
const state = stackState();
const runId = Date.now().toString(36);
const secret = createOrgAccount(`cx-${runId}`);
const account = accountClient(state, secret);

const deployed = await new BroodsSyncClient({
  baseUrl: edgeUrl(state),
  token: secret,
}).putManifest(
  {
    version: 1,
    project: `bench-${runId}`,
    stage: "development",
    resources: [
      {
        kind: "mcp",
        name: "cfdocs",
        config: {
          transport: "http",
          url: "https://docs.mcp.cloudflare.com/mcp",
        },
      },
    ],
  },
  true,
);
const mcp = { serverId: deployed.ids.mcp.cfdocs! };
console.log("mcp server", mcp.serverId);
const v8Sandbox = await account.createSandbox({
  name: `v8-${runId}`,
  config: {
    provider: "worker",
    persistent: true,
    permissionMode: "bypass",
    network: { mode: "deny-all" },
  },
});
const machineName = `vm-${runId}`;
const machineSandbox = await account.createSandbox({
  name: machineName,
  config: {
    provider: "machine",
    permissionMode: "bypass",
    network: { mode: "allow-all" },
  },
});
let daemonLog = "";
const controller = new AbortController();
const daemon = runMachineDaemon({
  baseUrl: edgeUrl(state),
  computer: false,
  credential: async () => secret,
  cwd: "/tmp",
  log: (line: string) => {
    daemonLog += `${line}\n`;
  },
  sandbox: machineName,
  signal: controller.signal,
}).catch((error: unknown) => {
  daemonLog += `daemon exited: ${String(error)}\n`;
});
for (
  let i = 0;
  i < 50 && !daemonLog.includes(`connected as ${machineName}`);
  i++
) {
  await Bun.sleep(200);
}
console.log(
  "machine daemon:",
  daemonLog.includes("connected") ? "connected" : daemonLog,
);

const agents = {
  machine: await account.createAgent({
    name: `cx-machine-${runId}`,
    config: complexConfig(apiKey, machineSandbox.sandboxId, mcp.serverId),
  }),
  v8: await account.createAgent({
    name: `cx-v8-${runId}`,
    config: complexConfig(apiKey, v8Sandbox.sandboxId, mcp.serverId),
  }),
};

const arms: { name: string; runtime: Runtime; agent: keyof typeof agents }[] = [
  {
    name: "current: Bun core + machine sandbox",
    runtime: "bun",
    agent: "machine",
  },
  { name: "V8: core on workerd + V8 sandbox", runtime: "workerd", agent: "v8" },
  { name: "control: Bun core + V8 sandbox", runtime: "bun", agent: "v8" },
];
for (const arm of arms) {
  const started = performance.now();
  const tools: string[] = [];
  let text = "";
  for await (const part of runtimeClient(arm.runtime, secret)
    .agent("cx", agents[arm.agent].agentId)
    .stream({
      conversationKey: `cx-${arm.runtime}-${arm.agent}-${runId}`,
      input: complexTask(`task-${arm.runtime}-${arm.agent}-${runId}`),
    })) {
    if (part.type === "tool-call")
      tools.push(
        `${part.toolName}(${JSON.stringify(part.input).slice(0, 120)})`,
      );
    if (part.type === "tool-result")
      tools.push(`  -> ${JSON.stringify(part.output).slice(0, 200)}`);
    if (part.type === "tool-error")
      tools.push(`  !! ${JSON.stringify(part.error).slice(0, 200)}`);
    if (part.type === "text-delta") text += part.text;
    if (part.type === "error")
      tools.push(`ERROR ${JSON.stringify(part).slice(0, 300)}`);
  }
  console.log(
    `\n=== ${arm.name}: ${(performance.now() - started).toFixed(0)} ms`,
  );
  console.log(tools.join("\n"));
  console.log("final:", text);
}
console.log(JSON.stringify({ runId: runId, secretFile: "not written" }));
await Bun.sleep(30_000);
const audit = await account.audit.list({ limit: 500 });
for (const event of audit.events.filter((e) => e.action.startsWith("run."))) {
  console.log(event.action, event.summary, event.detailsJson?.slice(0, 200));
}
controller.abort();
await daemon;
