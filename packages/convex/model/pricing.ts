/**
 * What BeeBlast pays per unit of usage, in EUR, and the one function that
 * prices a monthly usage meter. Every rate names its list price, source and
 * date. Rates round the published price up a little: a slightly high estimate
 * is the safe side for a subsidised free tier.
 *
 * Not priced here, on purpose:
 * - Model tokens. Every agent brings its own provider key
 *   (`config.provider.<name>.apiKey` is required), so the platform pays nothing.
 * - Core, gateway and self-hosted Convex on Hetzner. A fixed monthly cost, and
 *   runs share one process, so there is no fair per-run CPU figure yet.
 * - MicroVM guest egress through the NAT/network connector and CloudWatch log
 *   ingestion. No per-account byte counter exists for either.
 *
 * FX: ECB reference rate 2026-09-23, 1 EUR = 1.1411 USD.
 */

import type { Infer } from "convex/values";
import type { usageQuantitiesValidator } from "../schema";

/** A month of usage, in the units the rates below price. */
export type UsageQuantities = Infer<typeof usageQuantitiesValidator>;

/** EUR per unit for each metered quantity. */
export const UNIT_RATES_EUR: UsageQuantities = {
  // AWS Lambda MicroVMs eu-west-1, x86 $0.0000340538/vCPU-s (Arm is
  // $0.0000291572). x86, the dearer one, also covers Daytona and E2B
  // ($0.000014/vCPU-s). AWSLambda eu-west-1 price list, published 2026-09-19.
  sandboxVcpuSeconds: 0.00003,
  // Same source, x86 $0.0000045086/GB-s (Arm $0.0000038603).
  sandboxGbSeconds: 0.000004,
  // Same source, snapshot write $0.0040636422/GB + read $0.0016403088/GB:
  // one suspend and one resume.
  sandboxSnapshotGb: 0.005,
  // AWS Lambda eu-west-1, Arm $0.0000133334/GB-s, published 2026-09-19. The
  // free tier is shared across the AWS organization, so it is ignored.
  hostedMcpGbSeconds: 0.000012,
  // Same source, $0.20 per 1M requests.
  hostedMcpRequests: 0.0000002,
  // S3 Standard eu-west-1, $0.023/GB-month, published 2026-09-18.
  storageGbMonths: 0.021,
  // AWS data transfer out eu-west-1, first 10 TB $0.09/GB, published
  // 2026-09-16. The 100 GB/month free allowance is org-wide, so ignored.
  egressGb: 0.08,
  // AWS data transfer in is free.
  ingressGb: 0,
};

/** A day's storage snapshot bills 1/30 of a GB-month; 31-day months come out 3% high, the safe side. */
export const DAYS_PER_MONTH = 30;

/**
 * Memory the hosted-MCP runner Lambda is deployed with (`apps/core/sst.config.ts`,
 * "1769 MB", arm64). An invoke is billed on this, not on what the bundle uses.
 */
export const HOSTED_MCP_MEMORY_GB = 1.769;

/**
 * What a MicroVM (`lambda` provider) is billed on. Its size is baked into the
 * image, so the config's size is display-only; AWS's baseline is 1 vCPU and
 * 2 GB.
 */
export const MICROVM_BASELINE = { vcpu: 1, memoryGb: 2 };

/** The zero meter a month starts from. */
export const EMPTY_USAGE: UsageQuantities = {
  sandboxVcpuSeconds: 0,
  sandboxGbSeconds: 0,
  sandboxSnapshotGb: 0,
  hostedMcpGbSeconds: 0,
  hostedMcpRequests: 0,
  storageGbMonths: 0,
  egressGb: 0,
  ingressGb: 0,
};

/** The groups the dashboard splits a month's usage into. */
export type UsageCategory = "sandboxes" | "hostedMcp" | "storage" | "network";

/** The dashboard group each metered quantity counts toward. */
export const USAGE_CATEGORY: Record<keyof UsageQuantities, UsageCategory> = {
  sandboxVcpuSeconds: "sandboxes",
  sandboxGbSeconds: "sandboxes",
  sandboxSnapshotGb: "sandboxes",
  hostedMcpGbSeconds: "hostedMcp",
  hostedMcpRequests: "hostedMcp",
  storageGbMonths: "storage",
  egressGb: "network",
  ingressGb: "network",
};

/** Price a usage meter in EUR, split by dashboard group. */
export function meterCostByCategoryEur(
  usage: UsageQuantities,
): Record<UsageCategory, number> {
  const costs = { sandboxes: 0, hostedMcp: 0, storage: 0, network: 0 };
  for (const key of Object.keys(UNIT_RATES_EUR) as (keyof UsageQuantities)[]) {
    costs[USAGE_CATEGORY[key]] += usage[key] * UNIT_RATES_EUR[key];
  }

  return costs;
}

/** Price a usage meter in EUR. */
export function meterCostEur(usage: UsageQuantities): number {
  const costs = meterCostByCategoryEur(usage);

  return costs.sandboxes + costs.hostedMcp + costs.storage + costs.network;
}
