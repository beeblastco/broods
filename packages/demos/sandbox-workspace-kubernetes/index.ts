/**
 * Example: workspace sandbox execution on the Beeblast k3s cluster via the
 * `kubernetes` provider (agent-sandbox runtime pods) using declarative filthy-panty resources.
 */

import { FilthyPantyClient } from "filthy-panty";
import { api } from "./filthypanty/_generated/api";

// Create a client to connect to the Filthy Panty API.
const client = new FilthyPantyClient();

for await (const chunk of client.stream(api.agents.analysisAgent, {
  input: [
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
})) {
  switch (chunk.type) {
    case "reasoning-delta":
      process.stdout.write(`\x1b[90m${chunk.text}\x1b[0m`);
      break;
    case "reasoning-end":
      process.stdout.write(`\n\n`);
      break;
    case "text-delta":
      process.stdout.write(`\x1b[32m${chunk.text}\x1b[0m`);
      break;
    case "text-end":
      process.stdout.write(`\n\n`);
      break;
    case "tool-input-delta":
      process.stdout.write(`\x1b[36m${chunk.delta}\x1b[0m`);
      break;
    case "tool-call":
      process.stdout.write(`\n\x1b[36m[Tool Call: ${chunk.toolName}]\x1b[0m\n`);
      break;
    case "tool-result":
      process.stdout.write(`\n\x1b[35m[Tool Result: ${JSON.stringify(chunk.output)}]\x1b[0m\n`);
      break;
    case "finish":
      process.stdout.write(`\n\x1b[37m[Finished: ${chunk.finishReason}]\x1b[0m\n`);
      break;
  }
}

for await (const chunk of client.stream(api.agents.visualizationAgent, {
  input: [
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
    "   the input files, chart type, and top performers. Compute bar widths from",
    "   the drawable chart area, not the full SVG width. Do not include a self-referential",
    "   visualization-report.md file-size assertion.",
    "2. In a second bash call, run `python3 build_visualization.py`, then verify todo-completion.svg",
    "   and visualization-report.md exist, print their file sizes, and print the first 20 lines of",
    "   visualization-report.md.",
    "3. Summarize stdout and status for every visualization step, confirm that the second independent",
    "   agent read artifacts created by the first independent agent, and confirm that the visualization",
    "   files were generated.",
  ].join("\n"),
})) {
  switch (chunk.type) {
    case "reasoning-delta":
      process.stdout.write(`\x1b[90m${chunk.text}\x1b[0m`);
      break;
    case "reasoning-end":
      process.stdout.write(`\n\n`);
      break;
    case "text-delta":
      process.stdout.write(`\x1b[32m${chunk.text}\x1b[0m`);
      break;
    case "text-end":
      process.stdout.write(`\n\n`);
      break;
    case "tool-input-delta":
      process.stdout.write(`\x1b[36m${chunk.delta}\x1b[0m`);
      break;
    case "tool-call":
      process.stdout.write(`\n\x1b[36m[Tool Call: ${chunk.toolName}]\x1b[0m\n`);
      break;
    case "tool-result":
      process.stdout.write(`\n\x1b[35m[Tool Result: ${JSON.stringify(chunk.output)}]\x1b[0m\n`);
      break;
    case "finish":
      process.stdout.write(`\n\x1b[37m[Finished: ${chunk.finishReason}]\x1b[0m\n`);
      break;
  }
}
