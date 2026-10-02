/**
 * The custom provider against a real TLS server on loopback rather than a
 * stubbed `fetch`: `HttpSandboxExecutor` connects through the pinned guard,
 * which resolves the name itself and opens the socket to the address it
 * validated, so there is no global for a stub to replace.
 */

import { describe, expect, it } from "bun:test";
import { createServer as createHttpsServer, type Server } from "node:https";
import {
  HttpSandboxExecutor,
  type HttpSandboxExecutorSeams,
} from "../src/harness/sandbox/http-executor.ts";
import type {
  SandboxExecutorConfig,
  SandboxRunRequest,
} from "../src/harness/sandbox/types.ts";
import type { SandboxExecResponse } from "../src/shared/domain/sandbox-config.ts";
import { TLS_CERT, TLS_KEY } from "./helpers/tls.ts";

interface Received {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  path: string;
}

const OK_RESPONSE: SandboxExecResponse = {
  ok: true,
  runtime: "bash",
  exit_code: 0,
  timed_out: false,
  duration_ms: 12,
  stdout: "hello\n",
  stderr: "",
  cpu_usec: 4200,
};

describe("HttpSandboxExecutor", () => {
  it("posts the exec request with the bearer token and extra headers, and maps the answer", async () => {
    await withExecServer(OK_RESPONSE, async (endpoint, received) => {
      const executor = new HttpSandboxExecutor(
        config(endpoint, { token: "tok", headers: { "x-team": "ops" } }),
        seams(),
      );
      const result = await executor.run(
        run({ code: "echo hello", envVars: { FOO: "bar" } }),
      );

      expect(result).toEqual({
        ok: true,
        runtime: "bash",
        exitCode: 0,
        stdout: "hello\n",
        stderr: "",
        durationMs: 12,
        timedOut: false,
        truncated: false,
        provider: "custom",
        cpuUsec: 4200,
      });
      const [exec] = received;
      if (!exec) throw new Error("the server received nothing");
      expect(received).toHaveLength(1);
      expect(exec.path).toBe("/exec");
      expect(exec.headers.authorization).toBe("Bearer tok");
      expect(exec.headers["x-team"]).toBe("ops");
      expect(exec.headers["content-type"]).toBe("application/json");
      expect(JSON.parse(exec.body)).toEqual({
        runtime: "bash",
        code: "echo hello",
        timeout_ms: 5000,
        env: { BASE: "1", FOO: "bar" },
      });
    });
  });

  it("holds stdout and stderr to the request's output limit", async () => {
    await withExecServer(
      { ...OK_RESPONSE, stdout: "x".repeat(100), stderr: "y".repeat(100) },
      async (endpoint) => {
        const executor = new HttpSandboxExecutor(config(endpoint), seams());
        const result = await executor.run(run({ outputLimitBytes: 16 }));

        expect(result.truncated).toBe(true);
        expect(result.stdout).toBe(`${"x".repeat(16)}\n[output truncated]`);
        expect(result.stderr).toBe(`${"y".repeat(16)}\n[output truncated]`);
      },
    );
  });

  it("gives up on a server that never answers once the timeout and grace pass", async () => {
    await withExecServer(null, async (endpoint) => {
      const executor = new HttpSandboxExecutor(config(endpoint), {
        ...seams(),
        graceMs: 50,
      });

      await expect(executor.run(run({ timeoutSeconds: 0.1 }))).rejects.toThrow(
        /timed out/,
      );
    });
  });

  it("surfaces a non-2xx answer with its body", async () => {
    await withExecServer(OK_RESPONSE, async (endpoint) => {
      const executor = new HttpSandboxExecutor(config(endpoint), seams());

      await expect(executor.run(run({ code: "fail" }))).rejects.toThrow(
        "custom sandbox exec failed (401): bad token",
      );
    });
  });

  it("refuses an endpoint whose name resolves to a private address", async () => {
    const executor = new HttpSandboxExecutor(config("https://public.test"), {
      transport: {
        lookup: async (): Promise<{ address: string; family: number }[]> => [
          { address: "169.254.169.254", family: 4 },
        ],
      },
    });

    await expect(executor.run(run())).rejects.toThrow(
      /blocked private or metadata address/,
    );
  });

  it("refuses a literal private endpoint before resolving anything", async () => {
    const executor = new HttpSandboxExecutor(config("https://10.0.0.8"));

    await expect(executor.run(run())).rejects.toThrow(
      "custom sandbox endpoint must not point to a private or internal address",
    );
  });
});

function config(
  endpoint: string,
  options: Record<string, unknown> = {},
): SandboxExecutorConfig {
  return {
    provider: "custom",
    envVars: { BASE: "1" },
    options: { endpoint: endpoint, ...options },
  };
}

function run(overrides: Partial<SandboxRunRequest> = {}): SandboxRunRequest {
  return {
    code: "echo hello",
    timeoutSeconds: 5,
    outputLimitBytes: 4096,
    ...overrides,
  };
}

function seams(): HttpSandboxExecutorSeams {
  return {
    transport: {
      allowAddresses: ["127.0.0.1"],
      ca: TLS_CERT,
      lookup: async (
        hostname: string,
      ): Promise<{ address: string; family: number }[]> => {
        if (hostname !== "public.test") {
          throw new Error(`no test DNS entry for ${hostname}`);
        }

        return [{ address: "127.0.0.1", family: 4 }];
      },
    },
  };
}

// A null answer never responds, so the client deadline is what ends the call.
// A request whose code is "fail" is answered 401, like a server refusing a token.
async function withExecServer(
  answer: SandboxExecResponse | null,
  test: (endpoint: string, received: Received[]) => Promise<void>,
): Promise<void> {
  const received: Received[] = [];
  const server: Server = createHttpsServer(
    { cert: TLS_CERT, key: TLS_KEY },
    (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        received.push({
          body: body,
          headers: request.headers,
          path: request.url ?? "",
        });
        if (answer === null) return;
        if (body.includes('"code":"fail"')) {
          response.writeHead(401);
          response.end("bad token");

          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(answer));
      });
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") {
    throw new Error("test server has no port");
  }
  try {
    await test(`https://public.test:${address.port}/`, received);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}
