import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

globalThis.fetch = ((): never => {
  throw new Error("agent replay: unstubbed fetch");
}) as typeof fetch;

const { createRuntimeToolApproval } =
  await import("../../apps/core/src/harness/policy.ts");
const { shouldAutoCompact } =
  await import("../../apps/core/src/harness/compaction.ts");
const { createDeadlinePolicy } =
  await import("../../apps/core/src/harness/deadline-policy.ts");
const { createTaskTotals } =
  await import("../../apps/core/src/harness/usage-metering.ts");
const { harnessEntryBatches, takeHarnessEntryBatch } =
  await import("../../packages/convex/model/harnessSessionEntries.ts");
const { budgetLevel } =
  await import("../../packages/convex/model/planLimits.ts");
const {
  parseHandbackDedupeKey,
  subagentResultDedupeKey,
  asyncToolResultDedupeKey,
} = await import("../../packages/convex/model/subagentResults.ts");
const { sanitizeHookResult } =
  await import("../../apps/core/src/harness/hook-runner.ts");
const { estimateModelTokenCost } =
  await import("../../packages/convex/model/modelPricing.ts");

interface Vector {
  kind: string;
  input: number[];
  output: number[];
  key?: string;
  decoded?: [boolean, [string, string]] | null;
}
const generated = spawnSync(
  `${import.meta.dir}/../.lake/build/bin/spec-replay`,
  ["agent"],
  {
    cwd: `${import.meta.dir}/..`,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  },
);
if (generated.status !== 0)
  throw new Error(generated.stdout + generated.stderr);
const vectors = generated.stdout
  .trim()
  .split("\n")
  .map((line): Vector => JSON.parse(line) as Vector);

describe("agent decisions match Lean", (): void => {
  test.each(vectors)("$kind $input", async (vector): Promise<void> => {
    const [a = 0, b = 0, c = 0] = vector.input;
    let actual: number[];
    switch (vector.kind) {
      case "take-batch": {
        const result = await takeHarnessEntryBatch(entries(a), {
          rows: b,
          bytes: c,
        });
        actual = [result.batch.length, Number(result.full)];
        break;
      }
      case "withdraw": {
        const policy = createDeadlinePolicy({
          deadlineMs: 1,
          now: (): number => 1,
          windDownMs: 0,
          canYield: a >= 2,
          maxTurn: 0,
        });
        if (a !== 0) policy.shouldStop(0, 0);
        policy.withdrawYield();
        actual = [Number(policy.isWindingDown()), Number(policy.hasYielded())];
        break;
      }
      case "batches":
        actual = harnessEntryBatches(
          Array.from({ length: a }, (): { entry: string } => ({
            entry: "a",
          })),
        ).map((batch): number => batch.length);
        break;
      case "level":
        actual = [["ok", "warning", "exhausted"].indexOf(budgetLevel(a))];
        break;
      case "handback": {
        const parsed = parseHandbackDedupeKey(vector.key ?? "");
        const decoded = parsed
          ? [
              parsed.kind === "async-tool",
              [
                parsed.kind === "async-tool" ? parsed.resultId : parsed.eventId,
                parsed.status,
              ],
            ]
          : null;
        expect(decoded).toEqual(vector.decoded);
        if (parsed) {
          const encoded =
            parsed.kind === "async-tool"
              ? asyncToolResultDedupeKey(parsed.resultId, parsed.status)
              : subagentResultDedupeKey(parsed.eventId, parsed.status);
          expect(encoded).toBe(vector.key);
        }
        actual = [Number(parsed !== undefined)];
        break;
      }
      case "batch-sizes":
        actual = harnessEntryBatches(
          vector.input.map((length): { entry: string } => ({
            entry: "a".repeat(length),
          })),
        ).map((batch): number => batch.length);
        break;
      case "hook": {
        const fields = [
          "system",
          "messages",
          "output",
          "approve",
          "decision",
          "args",
          "denyReason",
          "visibleResult",
          "drop",
          "text",
          "metadata",
          "injected",
        ];
        const event = vector.key as Parameters<typeof sanitizeHookResult>[0];
        const result = sanitizeHookResult(
          event,
          Object.fromEntries(
            fields.map((field): [string, number] => [field, 1]),
          ),
        );
        actual = fields.map((field): number => Number(result?.[field] === 1));
        break;
      }
      case "gate": {
        const statuses = [undefined, "user-approval", "denied"] as const;
        const configured = new Map<string, true>();
        if (b === 2) configured.set("target", true);
        if (c % 2 === 1) configured.set("original", true);
        let policy = statuses[a];
        const computer = Math.floor(c / 2) % 2 === 1;
        const target = computer ? "computer" : "target";
        const runtime = createRuntimeToolApproval({
          configuredApprovals: configured,
          workspaces: [],
          policyApproval: async (): Promise<typeof policy> => policy,
          sandboxStandIns: new Map([
            [
              "original",
              {
                toSandboxCall: (): {
                  toolName: string;
                  input: { action: string };
                } => ({
                  toolName: target,
                  input: { action: b === 2 ? "click" : "screenshot" },
                }),
              },
            ],
          ]),
        });
        const call = {
          toolCall: { toolName: "original", toolCallId: "1", input: {} },
        };
        if (c >= 4) {
          policy = "user-approval";
          await runtime.approval?.({
            toolCall: {
              toolName: "computer",
              toolCallId: "prior",
              input: { action: "click" },
            },
          } as Parameters<NonNullable<typeof runtime.approval>>[0]);
          policy = statuses[a];
        }
        // compatibility has no explicit allow status; c=1 is its absent/allow equivalent.
        const status = await runtime.approval?.(
          call as Parameters<NonNullable<typeof runtime.approval>>[0],
        );
        const decision = typeof status === "object" ? status.type : status;
        const code =
          decision === "denied" ? 2 : decision === "user-approval" ? 1 : 0;
        actual = [code, c >= 4 || (computer && code === 1) ? 1 : 0];
        break;
      }
      case "compact":
        actual = [
          Number(
            shouldAutoCompact(
              { session: { autoCompaction: { enabled: a === 1 } } },
              c,
              b === 1,
            ),
          ),
        ];
        break;
      case "deadline": {
        const policy = createDeadlinePolicy({
          deadlineMs: c % 2 ? 100 : undefined,
          now: (): number => 100,
          windDownMs: 0,
          canYield: Math.floor(c / 2) % 2 === 1,
          maxTurn: a,
        });
        actual = [
          Number(policy.shouldStop(b, Math.floor(c / 4))),
          Number(policy.isWindingDown()),
          Number(policy.hasYielded()),
        ];
        break;
      }
      case "cost": {
        const cost = estimateModelTokenCost(
          { input: 3, output: 4, cacheRead: 1, cacheWrite: 5 },
          {
            inputTokens: a,
            outputTokens: 8,
            cachedInputTokens: b,
            cacheWriteTokens: 2,
          },
        );
        actual = [Math.round((cost?.total ?? 0) * 1_000_000)];
        break;
      }
      case "usage-zero":
      case "usage": {
        const initial = vector.kind === "usage-zero" ? 5 : a;
        const totals = createTaskTotals();
        totals.addStep(
          0,
          {
            inputTokens: initial,
            outputTokens: 0,
            reasoningTokens: 0,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: initial,
          },
          3,
        );
        totals.finish(
          {
            inputTokens: a * 2,
            outputTokens: 0,
            totalTokens: a * 2,
            inputTokenDetails: {
              noCacheTokens: undefined,
              cacheReadTokens: undefined,
              cacheWriteTokens: undefined,
            },
            outputTokenDetails: {
              textTokens: undefined,
              reasoningTokens: undefined,
            },
          },
          1,
        );
        actual = [
          totals.usage()?.inputTokens ?? 0,
          totals.usage()?.totalTokens ?? 0,
          totals.cacheWriteTokens(),
          totals.steps(),
        ];
        break;
      }
      default:
        throw new Error(vector.kind);
    }
    expect(actual).toEqual(vector.output);
  });
});

async function* entries(
  count: number,
): AsyncGenerator<{ entry: string }, void, void> {
  for (let index = 0; index < count; index += 1) yield { entry: "a" };
}
