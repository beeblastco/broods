/**
 * Pinned fetch bridge tests for custom-tool isolate SSRF protection.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeniedAddress } from "../src/harness/tools/isolate-runner/pinned-fetch.mjs";

describe("isDeniedAddress", () => {
  it("denies private, metadata, carrier-grade NAT, and IPv4-mapped metadata ranges", () => {
    expect(isDeniedAddress("127.0.0.1")).toBe(true);
    expect(isDeniedAddress("10.1.2.3")).toBe(true);
    expect(isDeniedAddress("172.16.0.10")).toBe(true);
    expect(isDeniedAddress("192.168.1.10")).toBe(true);
    expect(isDeniedAddress("169.254.169.254")).toBe(true);
    expect(isDeniedAddress("100.64.0.1")).toBe(true);
    expect(isDeniedAddress("::ffff:169.254.169.254")).toBe(true);
  });

  it("denies IPv6 loopback, unspecified, link-local, and ULA addresses", () => {
    expect(isDeniedAddress("::")).toBe(true);
    expect(isDeniedAddress("::1")).toBe(true);
    expect(isDeniedAddress("fe80::1")).toBe(true);
    expect(isDeniedAddress("fe90::1")).toBe(true);
    expect(isDeniedAddress("febf::1")).toBe(true);
    expect(isDeniedAddress("fc00::1")).toBe(true);
    expect(isDeniedAddress("fd00::1")).toBe(true);
  });

  it("allows a normal public IP", () => {
    expect(isDeniedAddress("93.184.216.34")).toBe(false);
  });
});

describe("guardedFetch", () => {
  it("connects to a validated pinned IP and preserves the original Host header", async () => {
    const output = runNodeScenario("happy");

    expect(output.result).toMatchObject({
      status: 200,
      bodyText: "ok",
    });
    expect(output.result.headers["content-type"]).toBe("text/plain");
    expect(output.requests[0]).toContain("Host: public.test");
    expect(output.connections).toHaveLength(1);
    expect(output.connections[0].host).toBe("93.184.216.34");
  });

  it("blocks redirects to denied hosts by re-resolving and re-validating the Location", async () => {
    const output = runNodeScenario("redirect-denied");

    expect(output.error).toContain("blocked private or metadata address");
    expect(output.connections).toHaveLength(1);
    expect(output.connections[0].host).toBe("93.184.216.34");
  });

  it("rejects response bodies over 5MB", async () => {
    const output = runNodeScenario("large-body");

    expect(output.error).toContain("response body exceeded 5MB");
  });

  it("does not re-resolve after validation during DNS rebinding", async () => {
    const output = runNodeScenario("rebind");

    expect(output.result.bodyText).toBe("still public");
    expect(output.lookupCalls).toEqual(["rebind.test"]);
    expect(output.connections).toHaveLength(1);
    expect(output.connections[0].host).toBe("93.184.216.34");
    expect(output.connections[0].host).not.toBe("127.0.0.1");
  });
});

function runNodeScenario(scenario: string): any {
  const modulePath = fileURLToPath(
    new URL(
      "../src/harness/tools/isolate-runner/pinned-fetch.mjs",
      import.meta.url,
    ),
  );
  const script = `
    import { Duplex } from "node:stream";
    import { BODY_LIMIT_BYTES, guardedFetch } from ${JSON.stringify(pathToFileURL(modulePath).href)};

    const scenario = ${JSON.stringify(scenario)};
    const connections = [];
    const requests = [];
    const lookupCalls = [];

    function publicLookup(address) {
      return async () => [{ address, family: 4 }];
    }

    function scriptedConnection(responses) {
      return (options, oncreate) => {
        connections.push({ host: options.hostname ?? options.host, port: options.port });
        const response = responses.shift();
        if (!response) throw new Error("missing scripted response");
        let responded = false;
        const socket = new Duplex({
          read() {},
          write(chunk, _encoding, callback) {
            requests.push(Buffer.from(chunk).toString("utf8"));
            callback();
            if (responded) return;
            responded = true;
            queueMicrotask(() => {
              socket.push(response);
              socket.push(null);
            });
          },
        });
        socket.setKeepAlive = () => socket;
        socket.setNoDelay = () => socket;
        socket.setTimeout = () => socket;
        if (oncreate) queueMicrotask(oncreate);
        return socket;
      };
    }

    function httpResponse(status, headers, body) {
      const bodyBytes = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
      const headerLines = [
        \`HTTP/1.1 \${status} \${status === 200 ? "OK" : "Found"}\`,
        \`Content-Length: \${bodyBytes.byteLength}\`,
        ...Object.entries(headers).map(([key, value]) => \`\${key}: \${value}\`),
        "",
        "",
      ];
      return Buffer.concat([Buffer.from(headerLines.join("\\r\\n")), bodyBytes]);
    }

    async function run() {
      if (scenario === "happy") {
        const result = await guardedFetch("http://public.test/hello", undefined, {
          lookup: publicLookup("93.184.216.34"),
          createConnection: scriptedConnection([
            httpResponse(200, { "content-type": "text/plain" }, "ok"),
          ]),
        });
        return { result, connections, requests };
      }
      if (scenario === "redirect-denied") {
        const lookup = async (hostname) => {
          if (hostname === "metadata.test") return [{ address: "169.254.169.254", family: 4 }];
          return [{ address: "93.184.216.34", family: 4 }];
        };
        try {
          await guardedFetch("http://public.test/redirect", undefined, {
            lookup,
            createConnection: scriptedConnection([
              httpResponse(302, { location: "http://metadata.test/latest/meta-data" }, ""),
            ]),
          });
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error), connections, requests };
        }
        throw new Error("expected redirect denial");
      }
      if (scenario === "large-body") {
        try {
          await guardedFetch("http://large.test/large", undefined, {
            lookup: publicLookup("93.184.216.34"),
            createConnection: scriptedConnection([
              httpResponse(200, { "content-type": "text/plain" }, Buffer.alloc(BODY_LIMIT_BYTES + 1, "a")),
            ]),
          });
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error), connections, requests };
        }
        throw new Error("expected body limit error");
      }
      if (scenario === "rebind") {
        const lookup = async (hostname) => {
          lookupCalls.push(hostname);
          return lookupCalls.length === 1
            ? [{ address: "93.184.216.34", family: 4 }]
            : [{ address: "127.0.0.1", family: 4 }];
        };
        const result = await guardedFetch("http://rebind.test/", undefined, {
          lookup,
          createConnection: scriptedConnection([
            httpResponse(200, { "content-type": "text/plain" }, "still public"),
          ]),
        });
        return { result, connections, requests, lookupCalls };
      }
      throw new Error("unknown scenario");
    }

    console.log(JSON.stringify(await run()));
  `;
  const child = spawnSync("node", ["--input-type=module", "--eval", script], {
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    encoding: "utf8",
  });
  if (child.status !== 0) {
    throw new Error(
      (child.stderr || child.stdout || "node scenario failed").trim(),
    );
  }
  return JSON.parse(child.stdout);
}
