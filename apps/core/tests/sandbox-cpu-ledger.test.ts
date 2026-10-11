/**
 * The run's sandbox CPU ledger: the per (type, role, tool) buckets that become
 * the usage row's sandboxUsage, the per-call compute a tool.call span reads
 * once, and the role and provider totals the root span carries.
 */

import { describe, expect, it } from "bun:test";
import type { SandboxCpuSample } from "../src/harness/sandbox/types.ts";
import { createSandboxCpuLedger } from "../src/harness/usage-metering.ts";

describe("createSandboxCpuLedger", () => {
  it("sums samples per (type, role, tool) into one usage row each", () => {
    const ledger = createSandboxCpuLedger();
    ledger.record({ type: "lambda", role: "agent", cpuUsec: 100 });
    ledger.record({ type: "lambda", role: "agent", cpuUsec: 50 });
    ledger.record({
      type: "mcp-sandbox",
      role: "tool",
      toolName: "search",
      toolCallId: "call-1",
      cpuUsec: 30,
    });
    ledger.record({
      type: "mcp-sandbox",
      role: "tool",
      toolName: "fetch",
      toolCallId: "call-2",
      cpuUsec: 7,
    });
    ledger.record({
      type: "mcp-sandbox",
      role: "tool",
      toolName: "search",
      toolCallId: "call-3",
      cpuUsec: 20,
    });

    // Rows stay aggregated: no toolCallId, and no toolName key when none ran.
    expect(ledger.usage()).toEqual([
      { type: "lambda", role: "agent", cpuUsec: 150 },
      { type: "mcp-sandbox", role: "tool", toolName: "search", cpuUsec: 50 },
      { type: "mcp-sandbox", role: "tool", toolName: "fetch", cpuUsec: 7 },
    ]);
    expect(Object.keys(ledger.usage()[0] ?? {})).toEqual([
      "type",
      "role",
      "cpuUsec",
    ]);
  });

  it("ignores samples with no positive CPU", () => {
    const ledger = createSandboxCpuLedger();
    for (const cpuUsec of [0, -5, Number.NaN]) {
      ledger.record({
        type: "mcp-sandbox",
        role: "tool",
        toolName: "search",
        toolCallId: "call-1",
        cpuUsec: cpuUsec,
      });
    }

    expect(ledger.usage()).toEqual([]);
    expect(ledger.takeToolCompute("call-1")).toBeUndefined();
    expect(ledger.roleAttributes()).toEqual({});
    expect(ledger.typeAttributes()).toEqual({});
  });

  it("adds every sample of a retried tool call to that call's compute, handed out once", () => {
    const ledger = createSandboxCpuLedger();
    const attempt: SandboxCpuSample = {
      type: "mcp-sandbox",
      role: "tool",
      toolName: "search",
      toolCallId: "call-1",
      cpuUsec: 40,
    };
    ledger.record(attempt);
    ledger.record({ ...attempt, cpuUsec: 60 });

    expect(ledger.takeToolCompute("call-1")).toEqual({
      type: "mcp-sandbox",
      cpuUsec: 100,
    });
    expect(ledger.takeToolCompute("call-1")).toBeUndefined();
    // Taking a call's compute leaves the aggregated row the usage write reads.
    expect(ledger.usage()).toEqual([
      { type: "mcp-sandbox", role: "tool", toolName: "search", cpuUsec: 100 },
    ]);
  });

  it("keeps per-call compute only for tool-role samples that name their call", () => {
    const ledger = createSandboxCpuLedger();
    ledger.record({
      type: "lambda",
      role: "agent",
      toolCallId: "call-1",
      cpuUsec: 10,
    });
    ledger.record({
      type: "mcp-sandbox",
      role: "tool",
      toolName: "search",
      cpuUsec: 10,
    });

    expect(ledger.takeToolCompute("call-1")).toBeUndefined();
    expect(ledger.usage()).toHaveLength(2);
  });

  it("copies each sample, so a caller reusing its object cannot change a row", () => {
    const ledger = createSandboxCpuLedger();
    const sample: SandboxCpuSample = {
      type: "mcp-sandbox",
      role: "tool",
      toolName: "search",
      toolCallId: "call-1",
      cpuUsec: 5,
    };
    ledger.record(sample);
    sample.cpuUsec = 999;

    expect(ledger.usage()).toEqual([
      { type: "mcp-sandbox", role: "tool", toolName: "search", cpuUsec: 5 },
    ]);
    expect(ledger.takeToolCompute("call-1")).toEqual({
      type: "mcp-sandbox",
      cpuUsec: 5,
    });
  });

  it("splits the running total by role for the live root span", () => {
    const ledger = createSandboxCpuLedger();
    ledger.record({ type: "lambda", role: "agent", cpuUsec: 100 });
    expect(ledger.roleAttributes()).toEqual({
      "sandbox.cpu_usec.role.agent": 100,
    });

    ledger.record({
      type: "mcp-sandbox",
      role: "tool",
      toolName: "search",
      cpuUsec: 30,
    });
    ledger.record({
      type: "lambda",
      role: "tool",
      toolName: "bash",
      cpuUsec: 12,
    });
    expect(ledger.roleAttributes()).toEqual({
      "sandbox.cpu_usec.role.agent": 100,
      "sandbox.cpu_usec.role.tool": 42,
    });
  });

  it("totals CPU per provider across roles and tools for the finished root span", () => {
    const ledger = createSandboxCpuLedger();
    ledger.record({ type: "lambda", role: "agent", cpuUsec: 100 });
    ledger.record({
      type: "lambda",
      role: "tool",
      toolName: "bash",
      cpuUsec: 12,
    });
    ledger.record({
      type: "mcp-sandbox",
      role: "tool",
      toolName: "search",
      cpuUsec: 30,
    });
    ledger.record({
      type: "mcp-sandbox",
      role: "tool",
      toolName: "fetch",
      cpuUsec: 8,
    });

    expect(ledger.typeAttributes()).toEqual({
      "sandbox.cpu_usec.lambda": 112,
      "sandbox.cpu_usec.mcp-sandbox": 38,
    });
  });
});
