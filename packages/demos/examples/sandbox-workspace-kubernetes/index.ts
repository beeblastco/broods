/**
 * Example: workspace sandbox execution on the Beeblast k3s cluster via the
 * `kubernetes` provider (agent-sandbox runtime pods).
 */

import {
  createAccount,
  createAgent,
  createSandbox,
  createWorkspace,
  deleteAccount,
  streamSSE,
  requireEnv,
} from "filthy-panty";

const minimaxApiKey = requireEnv("ACCOUNT_MINIMAX_API_KEY");
const username = `sandbox-k8s-${Date.now()}`;

const account = await createAccount(username);

const sandbox = await createSandbox(account.secret, "k8s-sandbox", {
  provider: "kubernetes",
  network: { mode: "allow-all" },
  permissionMode: "bypass",
  timeout: 60,
  outputLimitBytes: 65536,
  envVars: {
    API_BASE_URL: "https://jsonplaceholder.typicode.com",
    SANDBOX_SMOKE_VAR: "sandbox-env-ok",
  },
  options: {
    // namespace/image/serviceAccountName/imagePullSecrets default from harness env.
    // mountAwsS3Buckets mounts the shared workspace S3 bucket so files persist across
    // ephemeral per-run pods (parity with lambda/daytona). Bucket comes from harness
    // env; S3 credentials come from the pod's Kubernetes service account / IRSA.
    mountAwsS3Buckets: true,
    workspaceRoot: "/mnt/workspaces",
  },
});

const workspace = await createWorkspace(account.secret, "notes", {
  storage: { provider: "s3" },
  harness: { enabled: true },
});

const analysisAgent = await createAgent(account.secret, "Kubernetes sandbox analysis assistant", {
  provider: {
    minimax: { apiKey: minimaxApiKey },
  },
  model: {
    provider: "minimax",
    modelId: "MiniMax-M3",
  },
  agent: {
    system: [
      "You are the first independent agent in a Kubernetes S3-backed workspace sandbox test.",
      "Create API analysis artifacts in the shared workspace.",
      "Follow the user's numbered steps closely.",
      "When a numbered step asks for a bash call, use bash only for that step.",
    ].join(" "),
  },
  sandbox: sandbox.sandboxId,
  workspaces: [{ name: "notes", workspaceId: workspace.workspaceId }],
}, "Fetches API data and writes analysis artifacts");

const visualizationAgent = await createAgent(account.secret, "Kubernetes workspace visualization assistant", {
  provider: {
    minimax: { apiKey: minimaxApiKey },
  },
  model: {
    provider: "minimax",
    modelId: "MiniMax-M3",
  },
  agent: {
    system: [
      "You are the second independent agent in a Kubernetes S3-backed workspace sandbox test.",
      "Read analysis artifacts created by another agent from the shared workspace as part of the first numbered bash call.",
      "Build small dependency-free scripts with Python standard library only.",
      "Do not install packages. Do not use matplotlib. Generate SVG/HTML/JSON outputs directly.",
      "The analysis schema is top_5_users entries with name, completed, total, and rate fields; rate is a 0..1 ratio.",
      "Follow the user's numbered steps closely.",
      "Do not run preflight commands outside the numbered steps.",
      "When a numbered step asks for a bash call, use bash only for that step.",
    ].join(" "),
  },
  sandbox: sandbox.sandboxId,
  workspaces: [{ name: "notes", workspaceId: workspace.workspaceId }],
}, "Reads analysis artifacts and writes visualization artifacts");

console.log("Created test account:", JSON.stringify(account));
console.log("Created sandbox:", JSON.stringify(sandbox));
console.log("Created workspace:", JSON.stringify(workspace));
console.log("Created analysis agent:", JSON.stringify(analysisAgent));
console.log("Created visualization agent:", JSON.stringify(visualizationAgent));

try {
  const analysisTimestamp = Date.now();
  const analysisBody = {
    agentId: analysisAgent.agentId,
    eventId: `sandbox-analysis-${analysisTimestamp}`,
    conversationKey: `sandbox-analysis-${analysisTimestamp}`,
    events: [
      {
        role: "user",
        content: [{
          type: "text",
          text: [
            "Run the analysis half of this kubernetes sandbox data-workflow test.",
            "You are agent 1 of 2. Do not invoke another agent and do not use subagents.",
            "Use exactly one bash tool call for each numbered step. Do not use write, read, edit, glob,",
            "or grep for these steps.",
            "1. In one bash call, print `shell:$SANDBOX_SMOKE_VAR` and `api:$API_BASE_URL`, then write",
            "   fetch_and_analyze.py using a bash heredoc in that same command. The script must read",
            "   API_BASE_URL from the environment, fetch",
            "   `${API_BASE_URL}/todos` and `${API_BASE_URL}/users` using Python standard library only,",
            "   analyze todo completion by user, identify the top 5 users by completion rate, and write:",
            "   raw-todos.json, raw-users.json, analysis.json, and analysis-summary.md.",
            "   analysis.json must contain total_users, total_todos, user_completion, and top_5_users.",
            "   Each top_5_users entry must contain userId, name, completed, total, and rate.",
            "   rate must be a 0..1 ratio, for example 0.6 means 60%.",
            "2. In a second bash call, run `python3 fetch_and_analyze.py`, then print the first 30 lines",
            "   of analysis-summary.md and list the workspace files.",
            "3. In a third bash call, run a validation command that loads analysis.json and prints:",
            "   `users:<count>`, `todos:<count>`, `top_user:<name>`, and `completion_rate:<rate>`.",
            "4. Summarize stdout and status for the analysis steps, then stop. A separate agent will be",
            "   invoked by the example script after your response finishes to read these files and build",
            "   the visualization.",
          ].join("\n"),
        }],
      },
    ],
  };

  console.log("\n\n=== Analysis agent stream ===");
  for await (const chunk of streamSSE(analysisBody, account.secret)) {
    process.stdout.write(`${chunk}\n\n`);
  }

  const visualizationTimestamp = Date.now();
  const visualizationBody = {
    agentId: visualizationAgent.agentId,
    eventId: `sandbox-visualization-${visualizationTimestamp}`,
    conversationKey: `sandbox-visualization-${visualizationTimestamp}`,
    events: [
      {
        role: "user",
        content: [{
          type: "text",
          text: [
            "Run the visualization half of this kubernetes sandbox data-workflow test.",
            "You are agent 2 of 2, invoked separately after the analysis agent finished.",
            "Do not use subagents and do not invoke another agent. Read the analysis artifacts from",
            "the shared S3-backed workspace.",
            "Use exactly one bash tool call for each numbered step. Do not use write, read, edit, glob,",
            "or grep for these steps.",
            "Do not run an extra inspection or preflight command before step 1; step 1 is the first bash call.",
            "Use relative paths from the workspace root.",
            "analysis.json uses this schema: top_5_users is an array of objects with userId, name,",
            "completed, total, and rate. rate is a 0..1 ratio, so multiply by 100 for labels,",
            "percent widths, and thresholds. Use those keys when generating the visualization script.",
            "1. In one bash call, verify analysis.json and analysis-summary.md exist, print their file sizes,",
            "   then write build_visualization.py using a bash heredoc in that same command. The script must",
            "   use Python standard library only, read analysis.json, generate todo-completion.svg by writing",
            "   SVG XML text manually from the top_5_users data, and write visualization-report.md summarizing",
            "   the input files, chart type, output file sizes, and top performers. Compute bar widths from",
            "   the drawable chart area, not the full SVG width. Because visualization-report.md must include",
            "   its own final file size, use two distinct placeholders such as __SVG_SIZE__ and __REPORT_SIZE__.",
            "   Write the report once with placeholders, measure the SVG and report files, replace each",
            "   placeholder independently, rewrite the report, then measure again and rewrite once more if the",
            "   report size changed. Exit nonzero if the report content does not contain the actual final sizes.",
            "2. In a second bash call, run `python3 build_visualization.py`, then verify todo-completion.svg",
            "   and visualization-report.md exist, print their file sizes, and print the first 20 lines of",
            "   visualization-report.md. The printed report must not say visualization-report.md is 0 bytes,",
            "   and the size printed inside visualization-report.md must match `wc -c visualization-report.md`.",
            "3. Summarize stdout and status for every visualization step, confirm that the second independent",
            "   agent read artifacts created by the first independent agent, and confirm that the visualization",
            "   files were generated.",
          ].join("\n"),
        }],
      },
    ],
  };

  console.log("\n\n=== Visualization agent stream ===");
  for await (const chunk of streamSSE(visualizationBody, account.secret)) {
    process.stdout.write(`${chunk}\n\n`);
  }
} finally {
  await deleteAccount(account.secret);
  console.log("\n\nDeleted test account");
}
