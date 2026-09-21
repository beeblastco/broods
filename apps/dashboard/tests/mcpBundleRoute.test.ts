/**
 * The bundle route may only inline the submitted source and the allowed
 * packages. Runs from apps/dashboard, so package.json is a file next to it.
 */
import { describe, expect, test } from "bun:test";
import { POST } from "../app/api/mcp/bundle/route";

describe("mcp bundle route", () => {
  test("bundles a literal import of an allowed package", async () => {
    const response = await post(
      'import { z } from "zod"; console.log(z.string());',
    );
    const body = (await response.json()) as { bundle?: string };

    expect(response.status).toBe(200);
    expect(body.bundle).toContain("console.log");
  });

  test("refuses a computed import path and returns no file contents", async () => {
    const response = await post(
      'const name = "package"; console.log(await import("./" + name + ".json"));',
    );
    const text = await response.text();

    expect(response.status).toBe(422);
    expect(text).not.toContain("bundle");
    expect(text).not.toContain("@broods/dashboard");
  });

  test("refuses a computed path into node_modules", async () => {
    const response = await post(
      'const name = "package"; console.log(require(`./node_modules/zod/${name}.json`));',
    );

    expect(response.status).toBe(422);
  });

  test("reports a syntax error in the submitted source", async () => {
    const response = await post("const x: = 1;");
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(422);
    expect(body.error).toContain("1:9 Unexpected");
  });

  test("requires a JSON content type", async () => {
    const response = await POST(
      new Request("http://localhost/api/mcp/bundle", {
        method: "POST",
        body: JSON.stringify({ sourceCode: "console.log(1)" }),
        headers: { "content-type": "text/plain" },
      }),
    );

    expect(response.status).toBe(415);
  });
});

function post(sourceCode: string): Promise<Response> {
  return POST(
    new Request("http://localhost/api/mcp/bundle", {
      method: "POST",
      body: JSON.stringify({ sourceCode: sourceCode }),
      headers: { "content-type": "application/json" },
    }),
  );
}
