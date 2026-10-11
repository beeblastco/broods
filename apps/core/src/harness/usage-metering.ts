/**
 * Per-task metering helpers. Flattens the AI SDK v7 `LanguageModelUsage`
 * shape (nested input/output token details) for span attributes and usage rows,
 * meters cache-write tokens with a providerMetadata fallback for providers
 * that only surface cache creation there, and keeps one run's sandbox CPU
 * ledger for its usage row, its root span and each tool.call span.
 */

import {
  canonicalModelProvider,
  PROVIDER_CACHE_WRITE_FIELDS,
} from "@broods/convex/model/modelPricing";
import type { LanguageModelUsage } from "ai";
import { isPlainObject } from "../shared/object.ts";
import type { SandboxCpuSample } from "./sandbox/types.ts";

export interface UsageTokenTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
}

// Absent counts read as 0 so span attributes and usage rows stay numeric.
export function usageTokenTotals(
  usage: LanguageModelUsage | undefined,
): UsageTokenTotals {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens ?? 0,
    cachedInputTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
  };
}

// Cache-write tokens for one step; 0 when the provider doesn't break them out,
// the field is absent, or metadata is missing. Never throws.
export function extractCacheWriteTokens(
  providerName: string | undefined,
  providerMetadata: Record<string, unknown> | undefined,
): number {
  if (!providerMetadata || !providerName) return 0;

  const provider = canonicalModelProvider(providerName);
  const field = PROVIDER_CACHE_WRITE_FIELDS[provider];
  if (!field) return 0;

  // providerMetadata shape: { [providerKey]: { [fieldName]: value, ... } }
  // The top-level key matches the canonical provider name (e.g. "anthropic").
  const providerBlock = providerMetadata[provider];
  if (isPlainObject(providerBlock)) {
    const val = providerBlock[field];
    if (typeof val === "number" && val > 0) return val;
  }

  // Bedrock wraps the Anthropic block under "anthropic" inside the bedrock block.
  if (provider === "bedrock") {
    const bedrockBlock = providerMetadata["bedrock"];
    if (isPlainObject(bedrockBlock)) {
      const anthropicBlock = bedrockBlock["anthropic"];
      if (isPlainObject(anthropicBlock)) {
        const val = anthropicBlock[field];
        if (typeof val === "number" && val > 0) return val;
      }
      // Also try the field directly on the bedrock block (provider SDK variation).
      const direct = bedrockBlock[field];
      if (typeof direct === "number" && direct > 0) return direct;
    }
  }

  // Google: usageMetadata lives under the "google" key.
  if (provider === "google") {
    const googleBlock = providerMetadata["google"];
    if (isPlainObject(googleBlock)) {
      const usageMeta = googleBlock["usageMetadata"];
      if (isPlainObject(usageMeta)) {
        const val = usageMeta[field];
        if (typeof val === "number" && val > 0) return val;
      }
      const direct = googleBlock[field];
      if (typeof direct === "number" && direct > 0) return direct;
    }
  }

  return 0;
}

/** One run's sandbox CPU: the tool registry writes it, spans and the usage row read it. */
export interface SandboxCpuLedger {
  /** Passed to the tool registry as `onSandboxCpu`; folds each CPU sample into the usage buckets. */
  record: (sample: SandboxCpuSample) => void;
  /** That call's compute, handed out once when its tool.call span closes. */
  takeToolCompute: (
    toolCallId: string,
  ) => Pick<SandboxCpuSample, "type" | "cpuUsec"> | undefined;
  /**
   * Sandbox CPU so far split by role (agent's own sandbox vs hosted MCP), for
   * the live root span re-published after each step. Empty until CPU arrives.
   */
  roleAttributes: () => Record<string, number>;
  /** Sandbox CPU split per provider, for the finished root span. */
  typeAttributes: () => Record<string, number>;
  /** One sandboxUsage row per (type, role, tool) bucket. */
  usage: () => SandboxCpuSample[];
}

export function createSandboxCpuLedger(): SandboxCpuLedger {
  // Accumulate sandbox CPU per (type, role, tool); each bucket becomes one
  // sandboxUsage row at finalize. CPU only arrives from sandbox execs and
  // hosted MCP calls.
  const sandboxUsageByKey = new Map<string, SandboxCpuSample>();
  // Per-call compute, so the tool.call span can report what that one call cost.
  // Keyed by call id and consumed once the span closes; usage rows stay aggregated.
  const toolComputeByCallId = new Map<
    string,
    Pick<SandboxCpuSample, "type" | "cpuUsec">
  >();

  return {
    record: (sample) => {
      if (!(sample.cpuUsec > 0)) return;
      if (sample.role === "tool" && sample.toolCallId !== undefined) {
        const call = toolComputeByCallId.get(sample.toolCallId);
        if (call) call.cpuUsec += sample.cpuUsec;
        else
          toolComputeByCallId.set(sample.toolCallId, {
            type: sample.type,
            cpuUsec: sample.cpuUsec,
          });
      }
      const key = `${sample.type}|${sample.role}|${sample.toolName ?? ""}`;
      const existing = sandboxUsageByKey.get(key);
      if (existing) {
        existing.cpuUsec += sample.cpuUsec;
      } else {
        sandboxUsageByKey.set(key, {
          type: sample.type,
          role: sample.role,
          ...(sample.toolName ? { toolName: sample.toolName } : {}),
          cpuUsec: sample.cpuUsec,
        });
      }
    },
    takeToolCompute: (toolCallId) => {
      const compute = toolComputeByCallId.get(toolCallId);
      toolComputeByCallId.delete(toolCallId);
      return compute;
    },
    roleAttributes: () => {
      let agent = 0;
      let tool = 0;
      for (const sample of sandboxUsageByKey.values()) {
        if (sample.role === "agent") agent += sample.cpuUsec;
        else if (sample.role === "tool") tool += sample.cpuUsec;
      }

      return {
        ...(agent > 0 ? { "sandbox.cpu_usec.role.agent": agent } : {}),
        ...(tool > 0 ? { "sandbox.cpu_usec.role.tool": tool } : {}),
      };
    },
    typeAttributes: () => {
      const cpuUsecByType = new Map<string, number>();
      for (const sample of sandboxUsageByKey.values()) {
        cpuUsecByType.set(
          sample.type,
          (cpuUsecByType.get(sample.type) ?? 0) + sample.cpuUsec,
        );
      }

      return Object.fromEntries(
        [...cpuUsecByType.entries()].map(([type, cpuUsec]) => [
          `sandbox.cpu_usec.${type}`,
          cpuUsec,
        ]),
      );
    },
    usage: () => [...sandboxUsageByKey.values()],
  };
}
