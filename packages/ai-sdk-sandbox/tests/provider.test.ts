import { describe, expect, test } from "bun:test";
import { HarnessCapabilityUnsupportedError, type HarnessV1NetworkPolicy } from "@ai-sdk/harness";
import type { Experimental_SandboxProcess } from "@ai-sdk/provider-utils";
import {
  createBroodsSandbox,
  type BroodsSandboxCommandOptions,
  type BroodsSandboxDriver,
  type BroodsSandboxDriverSession,
  type BroodsSandboxWriteFileOptions,
} from "../src/index.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("BroodsSandboxProvider", () => {
  test("maps create, bootstrap, network, and idempotent lifecycle operations", async () => {
    const calls: Array<{ operation: string; input?: unknown }> = [];
    let ports: ReadonlyArray<number> = [4_321];
    const session = fakeSession({
      get ports() {
        return ports;
      },
      async runCommand(options) {
        calls.push({ operation: "runCommand", input: options });
        return { exitCode: 0, stdout: "/workspace\n", stderr: "" };
      },
      async writeFile(options) {
        calls.push({ operation: "writeFile", input: options });
      },
      async getPortUrl(options) {
        calls.push({ operation: "getPortUrl", input: options });
        return `wss://sandbox.example.test:${options.port}`;
      },
      async setNetworkPolicy(policy) {
        calls.push({ operation: "setNetworkPolicy", input: policy });
      },
      async setPorts(nextPorts, options) {
        calls.push({ operation: "setPorts", input: { ports: nextPorts, options } });
        ports = [...nextPorts];
      },
      async stop() {
        calls.push({ operation: "stop" });
      },
      async destroy() {
        calls.push({ operation: "destroy" });
      },
    });
    const driver: BroodsSandboxDriver = {
      async createSession(options) {
        calls.push({ operation: "createSession", input: options });
        return { session, isFirstCreate: true };
      },
    };
    const provider = createBroodsSandbox({
      driver,
      providerId: "broods-test",
      bridgePorts: [4_321, 4_322],
    });
    const signal = new AbortController().signal;

    const networkSession = await provider.createSession({
      sessionId: "session-1",
      identity: "bootstrap-v1",
      abortSignal: signal,
      onFirstCreate: async (restricted, options) => {
        expect(options.abortSignal).toBe(signal);
        expect("stop" in restricted).toBe(false);
        await restricted.writeTextFile({ path: "/workspace/bootstrap.txt", content: "ready" });
        await restricted.run({ command: "pwd", workingDirectory: "/workspace" });
      },
    });

    expect(provider.specificationVersion).toBe("harness-sandbox-v1");
    expect(provider.providerId).toBe("broods-test");
    expect(provider.bridgePorts).toEqual([4_321, 4_322]);
    expect(networkSession.id).toBe("sandbox-1");
    expect(networkSession.description).toBe("Fake Broods sandbox");
    expect(networkSession.defaultWorkingDirectory).toBe("/workspace");
    expect(networkSession.ports).toEqual([4_321]);
    expect(calls[0]).toEqual({
      operation: "createSession",
      input: { sessionId: "session-1", identity: "bootstrap-v1", abortSignal: signal },
    });
    expect(calls[1]?.operation).toBe("writeFile");
    expect(decoder.decode((calls[1]?.input as BroodsSandboxWriteFileOptions).content)).toBe("ready");
    expect(calls[2]).toEqual({
      operation: "runCommand",
      input: { command: "pwd", workingDirectory: "/workspace" },
    });

    expect(await networkSession.getPortUrl({ port: 4_321, protocol: "ws" })).toBe(
      "wss://sandbox.example.test:4321",
    );
    const policy: HarnessV1NetworkPolicy = { mode: "custom", allowedHosts: ["example.com"] };
    await networkSession.setNetworkPolicy?.(policy);
    await networkSession.setPorts?.([8_080], { abortSignal: signal });
    expect(networkSession.ports).toEqual([8_080]);

    await Promise.all([networkSession.stop(), networkSession.stop()]);
    await Promise.all([networkSession.destroy?.(), networkSession.destroy?.()]);
    expect(calls.filter((call) => call.operation === "stop")).toHaveLength(1);
    expect(calls.filter((call) => call.operation === "destroy")).toHaveLength(1);
  });

  test("maps command, process, and file operations without changing driver failures", async () => {
    const commandCalls: BroodsSandboxCommandOptions[] = [];
    const writes: BroodsSandboxWriteFileOptions[] = [];
    const process = fakeProcess();
    const runFailure = new Error("command failed in driver");
    const session = fakeSession({
      async runCommand(options) {
        commandCalls.push(options);
        if (options.command === "fail") throw runFailure;
        return { exitCode: 7, stdout: "out", stderr: "err" };
      },
      async spawnCommand(options) {
        commandCalls.push(options);
        return process;
      },
      async readFile({ path }) {
        return path === "/missing" ? null : encoder.encode("one\ntwo\nthree\n");
      },
      async writeFile(options) {
        writes.push(options);
      },
    });
    const provider = createBroodsSandbox({
      driver: { createSession: async () => ({ session, isFirstCreate: true }) },
    });
    const sandbox = await provider.createSession();

    expect(await sandbox.run({ command: "exit 7", env: { MODE: "test" } })).toEqual({
      exitCode: 7,
      stdout: "out",
      stderr: "err",
    });
    expect(await sandbox.spawn({ command: "server", workingDirectory: "/workspace" })).toBe(process);
    expect(await sandbox.readTextFile({ path: "/file", startLine: 2, endLine: 3 })).toBe("two\nthree");
    expect(await sandbox.readBinaryFile({ path: "/missing" })).toBeNull();
    expect(await readStream(await sandbox.readFile({ path: "/file" }))).toBe("one\ntwo\nthree\n");

    await sandbox.writeBinaryFile({ path: "/binary", content: new Uint8Array([1, 2, 3]) });
    await sandbox.writeFile({ path: "/stream", content: byteStream("hello", " world") });
    await sandbox.writeTextFile({ path: "/text", content: "héllo" });
    expect([...writes[0]!.content]).toEqual([1, 2, 3]);
    expect(decoder.decode(writes[1]!.content)).toBe("hello world");
    expect(decoder.decode(writes[2]!.content)).toBe("héllo");

    await expect(sandbox.run({ command: "fail" })).rejects.toBe(runFailure);
  });

  test("maps resume only when the injected driver supports it", async () => {
    const resumeCalls: unknown[] = [];
    const resumed = fakeSession({ id: "resumed-sandbox" });
    const provider = createBroodsSandbox({
      driver: {
        createSession: async () => ({ session: fakeSession(), isFirstCreate: true }),
        async resumeSession(options) {
          resumeCalls.push(options);
          return resumed;
        },
      },
    });

    expect(provider.resumeSession).toBeDefined();
    const session = await provider.resumeSession!({ sessionId: "session-2" });
    expect(session.id).toBe("resumed-sandbox");
    expect(resumeCalls).toEqual([{ sessionId: "session-2" }]);

    const createOnly = createBroodsSandbox({
      driver: { createSession: async () => ({ session: fakeSession(), isFirstCreate: true }) },
    });
    expect(createOnly.resumeSession).toBeUndefined();
  });

  test("does not repeat one-time setup for an initialized identity", async () => {
    let bootstraps = 0;
    const provider = createBroodsSandbox({
      driver: {
        createSession: async () => ({ session: fakeSession(), isFirstCreate: false }),
      },
    });

    await provider.createSession({
      identity: "bootstrap-v1",
      onFirstCreate: async () => {
        bootstraps += 1;
      },
    });

    expect(bootstraps).toBe(0);
  });

  test("cleans up a fresh sandbox when one-time setup fails", async () => {
    const setupFailure = new Error("bootstrap failed");
    let destroys = 0;
    const session = fakeSession({
      async destroy() {
        destroys += 1;
      },
    });
    const provider = createBroodsSandbox({
      driver: { createSession: async () => ({ session, isFirstCreate: true }) },
    });

    await expect(
      provider.createSession({
        onFirstCreate: async () => {
          throw setupFailure;
        },
      }),
    ).rejects.toBe(setupFailure);
    expect(destroys).toBe(1);
  });

  test("preserves setup and cleanup failures in an AggregateError", async () => {
    const setupFailure = new Error("bootstrap failed");
    const cleanupFailure = new Error("cleanup failed");
    const session = fakeSession({
      async destroy() {
        throw cleanupFailure;
      },
    });
    const provider = createBroodsSandbox({
      driver: { createSession: async () => ({ session, isFirstCreate: true }) },
    });

    const error = await provider
      .createSession({
        onFirstCreate: async () => {
          throw setupFailure;
        },
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([setupFailure, cleanupFailure]);
    expect((error as Error).cause).toBe(setupFailure);
  });

  test("uses stop as cleanup fallback and reports unsupported port exposure", async () => {
    let stops = 0;
    const session = fakeSession({
      getPortUrl: undefined,
      destroy: undefined,
      async stop() {
        stops += 1;
      },
    });
    const provider = createBroodsSandbox({
      driver: { createSession: async () => ({ session, isFirstCreate: true }) },
      providerId: "broods-no-network",
    });
    const sandbox = await provider.createSession();

    await expect(sandbox.getPortUrl({ port: 3_000 })).rejects.toBeInstanceOf(
      HarnessCapabilityUnsupportedError,
    );
    await Promise.all([sandbox.destroy?.(), sandbox.destroy?.(), sandbox.stop()]);
    expect(stops).toBe(1);
  });
});

function fakeSession(overrides: Partial<BroodsSandboxDriverSession> = {}): BroodsSandboxDriverSession {
  const session: BroodsSandboxDriverSession = {
    id: "sandbox-1",
    description: "Fake Broods sandbox",
    defaultWorkingDirectory: "/workspace",
    ports: [],
    async runCommand() {
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async spawnCommand() {
      return fakeProcess();
    },
    async readFile() {
      return null;
    },
    async writeFile() {},
    async stop() {},
    async destroy() {},
  };
  Object.defineProperties(session, Object.getOwnPropertyDescriptors(overrides));
  return session;
}

function fakeProcess(): Experimental_SandboxProcess {
  return {
    pid: 123,
    stdout: byteStream("stdout"),
    stderr: byteStream("stderr"),
    async wait() {
      return { exitCode: 0 };
    },
    async kill() {},
  };
}

function byteStream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string | null> {
  if (stream === null) return null;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(bytes);
}
