import type { Infer } from "convex/values";
import type { usageQuantitiesValidator } from "../schema";

export type UsageQuantities = Infer<typeof usageQuantitiesValidator>;

// USD list prices (AWS eu-west-1 2026-09, Cloudflare Workers 2026-10) at 1 EUR = 1.1411 USD,
// rounded up and free tiers ignored: high is the safe side. Unpriced: model tokens (agents
// bring their own key), the fixed hosts, and MicroVM NAT egress (no per-account counter).
export const UNIT_RATES_EUR: UsageQuantities = {
  // MicroVM x86, the dearer arch; it also covers Daytona and E2B.
  sandboxVcpuSeconds: 0.00003,
  sandboxGbSeconds: 0.000004,
  // One snapshot write and one read: a suspend and a resume.
  sandboxSnapshotGb: 0.005,
  // us-east-1's $0.08/GB-month, the only published figure.
  sandboxSnapshotGbMonths: 0.075,
  hostedMcpGbSeconds: 0.000012,
  hostedMcpRequests: 0.0000002,
  // Cloudflare bills CPU time, which a Worker can not read, so this meters wall time.
  workerMs: 0.00000002,
  workerRequests: 0.0000003,
  storageGbMonths: 0.021,
  egressGb: 0.08,
  ingressGb: 0,
};

export const DAYS_PER_MONTH = 30;

// The runner Lambda's memory in apps/core/sst.config.ts: invokes bill on it, not on use.
export const HOSTED_MCP_MEMORY_GB = 1.769;

// The image fixes a MicroVM's size, so the config's size is display-only.
export const MICROVM_BASELINE = { vcpu: 1, memoryGb: 2 };

export const EMPTY_USAGE: UsageQuantities = {
  sandboxVcpuSeconds: 0,
  sandboxGbSeconds: 0,
  sandboxSnapshotGb: 0,
  sandboxSnapshotGbMonths: 0,
  hostedMcpGbSeconds: 0,
  hostedMcpRequests: 0,
  workerMs: 0,
  workerRequests: 0,
  storageGbMonths: 0,
  egressGb: 0,
  ingressGb: 0,
};

export type UsageCategory = "sandboxes" | "hostedMcp" | "storage" | "egress";

export const USAGE_CATEGORY: Record<keyof UsageQuantities, UsageCategory> = {
  sandboxVcpuSeconds: "sandboxes",
  sandboxGbSeconds: "sandboxes",
  sandboxSnapshotGb: "sandboxes",
  sandboxSnapshotGbMonths: "sandboxes",
  hostedMcpGbSeconds: "hostedMcp",
  hostedMcpRequests: "hostedMcp",
  workerMs: "sandboxes",
  workerRequests: "sandboxes",
  storageGbMonths: "storage",
  egressGb: "egress",
  ingressGb: "egress",
};

export function meterCostByCategoryEur(
  usage: UsageQuantities,
): Record<UsageCategory, number> {
  const costs = { sandboxes: 0, hostedMcp: 0, storage: 0, egress: 0 };
  for (const key of Object.keys(UNIT_RATES_EUR) as (keyof UsageQuantities)[]) {
    costs[USAGE_CATEGORY[key]] += usage[key] * UNIT_RATES_EUR[key];
  }

  return costs;
}

export function meterCostEur(usage: UsageQuantities): number {
  const costs = meterCostByCategoryEur(usage);

  return costs.sandboxes + costs.hostedMcp + costs.storage + costs.egress;
}
