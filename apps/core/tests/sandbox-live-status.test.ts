import { describe, expect, test } from "bun:test";
import {
  formatSandboxStatus,
  occupySandbox,
  parseSandboxUsage,
  sandboxNeighbours,
} from "../src/harness/sandbox/live-status.ts";

describe("parseSandboxUsage", () => {
  test("reads cpu, load, memory and disk from the probe lines", () => {
    expect(
      parseSandboxUsage(
        "cpus 2\nload 0.42\nmem 2048000 1536000\ndisk 8388608 2202009\n",
      ),
    ).toEqual({
      cpus: 2,
      load1: 0.42,
      memoryTotalMb: 2000,
      memoryUsedMb: 500,
      diskTotalGb: 8,
      diskUsedGb: 2.1,
    });
  });

  test("leaves out whatever the guest could not report", () => {
    expect(parseSandboxUsage("cpus\nload 0.1\nmem\n")).toEqual({ load1: 0.1 });
  });
});

describe("sandbox occupancy", () => {
  test("counts the other runs on a machine until they release", () => {
    const releaseA = occupySandbox("machine-1", "event-a", {
      agentId: "coder",
      conversationKey: "c-a",
    });
    const releaseB = occupySandbox("machine-1", "event-b", {
      agentId: "coder",
      conversationKey: "c-b",
    });

    expect(
      sandboxNeighbours("machine-1", "event-a").map(
        (one) => one.conversationKey,
      ),
    ).toEqual(["c-b"]);
    releaseB();
    expect(sandboxNeighbours("machine-1", "event-a")).toEqual([]);
    releaseA();
  });
});

describe("formatSandboxStatus", () => {
  test("names the machine, its live usage and its neighbours", () => {
    expect(
      formatSandboxStatus({
        name: "coder-sandbox",
        provider: "sandbox",
        specs: { vcpu: 0.5, memoryMb: 1024, storageGb: 8 },
        state: "running",
        shared: true,
        usage: {
          cpus: 1,
          load1: 0.3,
          memoryTotalMb: 1000,
          memoryUsedMb: 300,
          diskTotalGb: 8,
          diskUsedGb: 2.1,
        },
        neighbours: [{ agentId: "coder", conversationKey: "c-b", since: 1 }],
      }),
    ).toEqual([
      "your machine: coder-sandbox (sandbox, 0.5 vCPU, 1 GB RAM, 8 GB disk), shared: other conversations of this agent run on it too, each in its own folder",
      "machine now: running, load 0.3 on 1 CPU, RAM 300 of 1000 MB used, disk 2.1 of 8 GB used",
      "other runs on it now: 1 (coder)",
      "stay in your own folder, leave processes and ports you did not start alone, and expect CPU and memory to be shared",
    ]);
  });

  test("says a machine that is not reserved yet boots on first use", () => {
    expect(
      formatSandboxStatus({
        name: "box",
        provider: "lambda",
        state: null,
        shared: true,
        neighbours: [],
      }),
    ).toEqual([
      "your machine: box (lambda), shared: other conversations of this agent run on it too, each in its own folder",
      "machine now: not created yet, the first bash call boots it",
      "other runs on it now: none",
    ]);
  });
});
