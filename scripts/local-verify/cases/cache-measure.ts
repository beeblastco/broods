import { readFileSync } from "node:fs";

import {
  MODEL_KEY_HINT,
  connectMachine,
  runToTerminal,
  type VerifyContext,
} from "../harness.ts";

/**
 * MEASUREMENT ONLY, never merged. Tracy's prompt on the real model, two
 * workloads (bash calls per turn), each with the OpenAI cache marks off (the
 * code before #1102) and on, in parallel. Prints each conversation's hit rate
 * from the usage the core preload logged.
 */
const WORKLOADS = {
  tools: [3, 1, 0, 5, 1, 2, 0, 4],
  chat: [0, 1, 0, 0, 2, 0, 1, 0, 0, 0],
};
const LOG = "/tmp/openai-usage.jsonl";

export async function cacheMeasure(context: VerifyContext): Promise<void> {
  if (!context.hasModelKey) {
    console.log(`  skip cache measurement (${MODEL_KEY_HINT})`);
    return;
  }
  const instructions = readFileSync(
    "packages/demos/multi-channel/broods/instructions.md",
    "utf8",
  );
  const machine = await connectMachine(context, {
    computer: false,
    name: `cache-${context.runId}`,
  });
  const tags: string[] = [];
  try {
    await Promise.all(
      Object.entries(WORKLOADS).flatMap(([workload, turns]) =>
        ["off", "on"].map(async (marks) => {
          const tag = `${workload}-${marks}-${context.runId}`.toLowerCase();
          tags.push(tag);
          const { agentId } = await context.account.createAgent({
            name: tag,
            config: {
              ...context.model,
              agent: {
                system: `[measure:${tag}]${marks === "off" ? " [measure:marks-off]" : ""}\n\n${instructions}`,
              },
              subagent: { enabled: true },
              sandboxes: [machine.sandboxId],
            },
          });
          for (const [index, steps] of turns.entries()) {
            const text =
              steps === 0
                ? `Quick one (${index}): in one short sentence, what should I focus on today?`
                : `Turn ${index}: run these with the bash tool, one call per command, in order, then reply with one short sentence: ${Array.from({ length: steps }, (_, k) => `\`echo ${index}-${k}\``).join(", ")}.`;
            const status = await runToTerminal(context, {
              agentId: agentId,
              conversationKey: tag,
              eventId: `${tag}-${index}`,
              text: text,
            });
            console.log(
              `  ${tag} turn ${index} (${steps} bash) -> ${status.status}`,
            );
          }
        }),
      ),
    );
  } finally {
    await machine.stop();
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const rows = readFileSync(LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          tag: string;
          marks: number;
          status: number;
          input: number;
          cached: number;
        },
    );
  for (const tag of tags.sort()) {
    const mine = rows.filter((row) => row.tag === tag);
    const input = mine.reduce((sum, row) => sum + row.input, 0);
    const cached = mine.reduce((sum, row) => sum + row.cached, 0);
    console.log(
      `  RESULT ${tag}: ${mine.length} requests, input ${input}, cached ${cached}, hit ${((100 * cached) / Math.max(1, input)).toFixed(1)}%, marks sent ${mine.reduce((sum, row) => sum + row.marks, 0)}, non-200 ${mine.filter((row) => row.status !== 200).length}`,
    );
    console.log(
      `  per request ${tag}: ${mine.map((row) => `${Math.round((100 * row.cached) / Math.max(1, row.input))}%`).join(" ")}`,
    );
  }
  const other = rows.filter((row) => !tags.includes(row.tag));
  console.log(`  other requests (subagents etc.): ${other.length}`);
}
