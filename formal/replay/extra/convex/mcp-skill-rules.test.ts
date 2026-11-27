import { describe, expect, test } from "bun:test";

import {
  assertMcpRow,
  mcpBundleStorageKey,
  normalizeMcpInput,
} from "../../../../packages/convex/model/mcp";
import { remapKeys } from "../../../../packages/convex/model/objects";
import {
  contentTypeForSkillPath,
  normalizeBundlePath,
  parseGitHubSkillUrl,
  parseSkillMarkdown,
  validateSkillDescription,
  validateSkillName,
} from "../../../../packages/convex/model/skillRules";

type McpRow = Parameters<typeof assertMcpRow>[0];

const SHA = "a".repeat(64);
const SECRET_REF = "${TOKEN}";

const rejectedBodies: Array<[string, unknown, string]> = [
  ["array body", [], "Request body must be a JSON object"],
  ["null body", null, "Request body must be a JSON object"],
  ["bad name", { name: "Bad_Name" }, "name must be 1-32"],
  ["number name", { name: 1 }, "name must be 1-32"],
  ["long description", { description: "d".repeat(2001) }, "description must"],
  ["number description", { description: 1 }, "description must"],
  ["number url", { url: 1 }, "url must be a string"],
  ["long url", { url: `https://a.co/${"x".repeat(2048)}` }, "url must be a"],
  ["relative url", { url: "nope" }, "valid absolute URL"],
  ["ftp url", { url: "ftp://a.co" }, "url must use http or https"],
  ["credential url", { url: "https://u:p@a.co" }, "must not embed"],
  ["empty bundle", { bundle: "" }, "bundle must be a non-empty"],
  ["empty storage", { bundleStorageId: "" }, "bundleStorageId must be"],
  ["no sha", { bundleStorageId: "s1", sha256: "zz" }, "bundleStorageId needs"],
  ["empty sandbox", { sandbox: "" }, "sandbox must be the name"],
  ["bad runtime", { url: "https://a.co", runtime: "x" }, "runtime must be"],
  [
    "two connections",
    { url: "https://a.co", sandbox: "box" },
    "mutually exclusive",
  ],
  ["empty command", { sandbox: "box", command: [] }, "command must be 1-32"],
  ["blank arg", { sandbox: "box", command: [""] }, "command must be 1-32"],
  ["oauth array", { oauth: [] }, "oauth must be an object"],
  ["oauth number", { oauth: 1 }, "oauth must be an object"],
  [
    "oauth http token url",
    {
      oauth: {
        clientId: "c",
        clientSecret: SECRET_REF,
        refreshToken: SECRET_REF,
        tokenUrl: "http://a.co/t",
      },
    },
    "oauth.tokenUrl must use https",
  ],
  [
    "oauth missing client",
    { oauth: { clientSecret: SECRET_REF, refreshToken: SECRET_REF } },
    "oauth.clientId must be",
  ],
  [
    "oauth inline secret",
    { oauth: { clientId: "c", clientSecret: "raw", refreshToken: SECRET_REF } },
    "oauth.clientSecret must reference",
  ],
  ["tools not array", { allowedTools: "x" }, "allowedTools must be an array"],
  ["tool not string", { allowedTools: [1] }, "allowedTools must be an array"],
  [
    "too many tools",
    { allowedTools: Array.from({ length: 257 }, (): string => "t") },
    "at most 256",
  ],
  ["bad tool name", { allowedTools: ["a b"] }, "allowedTools entries"],
  ["disabled string", { disabled: "yes" }, "disabled must be a boolean"],
  [
    "machine headers",
    { sandbox: "box", headers: { "x-a": "b" } },
    "headers do not apply",
  ],
];

const acceptedBodies: Array<[string, Record<string, unknown>, object]> = [
  ["empty patch", {}, {}],
  [
    "http server",
    {
      name: "docs",
      description: "d",
      url: "http://a.co/mcp",
      allowedTools: ["read_file"],
      disabled: true,
    },
    {
      name: "docs",
      description: "d",
      url: "http://a.co/mcp",
      transport: "http",
      allowedTools: ["read_file"],
      disabled: true,
    },
  ],
  ["null description", { description: null, allowedTools: null }, {}],
  [
    "storage bundle",
    { bundleStorageId: "s1", sha256: SHA, runtime: "lambda" },
    {
      bundleStorageId: "s1",
      sha256: SHA,
      runtime: "lambda",
      transport: "hosted",
    },
  ],
  [
    "machine server",
    { sandbox: "box", command: ["obscura", "mcp"] },
    { sandbox: "box", command: ["obscura", "mcp"], transport: "machine" },
  ],
  [
    "oauth with token url",
    {
      oauth: {
        clientId: "c",
        clientSecret: SECRET_REF,
        refreshToken: SECRET_REF,
        tokenUrl: "https://a.co/t",
      },
    },
    {
      oauth: {
        clientId: "c",
        clientSecret: SECRET_REF,
        refreshToken: SECRET_REF,
        tokenUrl: "https://a.co/t",
      },
    },
  ],
  [
    "oauth without token url",
    {
      oauth: {
        clientId: "c",
        clientSecret: SECRET_REF,
        refreshToken: SECRET_REF,
      },
    },
    {
      oauth: {
        clientId: "c",
        clientSecret: SECRET_REF,
        refreshToken: SECRET_REF,
      },
    },
  ],
  ["null oauth", { oauth: null }, {}],
];

const rejectedRows: Array<[string, McpRow, string]> = [
  ["machine no sandbox", { transport: "machine" }, "needs the sandbox"],
  [
    "command off machine",
    { transport: "http", command: ["a"] },
    "command applies",
  ],
  [
    "machine headers",
    { transport: "machine", sandbox: "b", headers: { a: "b" } },
    "headers do not apply",
  ],
  [
    "runtime on http",
    { transport: "http", runtime: "auto" },
    "runtime applies",
  ],
  [
    "oauth on hosted",
    {
      transport: "hosted",
      oauth: { clientId: "c", clientSecret: "s", refreshToken: "r" },
    },
    "oauth applies",
  ],
  [
    "oauth on http url",
    {
      transport: "http",
      url: "http://a.co",
      oauth: { clientId: "c", clientSecret: "s", refreshToken: "r" },
    },
    "oauth needs an https url",
  ],
  [
    "oauth with authorization",
    {
      transport: "http",
      url: "https://a.co",
      headers: { authorization: "x" },
      oauth: { clientId: "c", clientSecret: "s", refreshToken: "r" },
    },
    "drop the explicit authorization header",
  ],
];

const acceptedRows: Array<[string, McpRow]> = [
  ["plain http", { transport: "http", url: "https://a.co" }],
  ["hosted runtime", { transport: "hosted", runtime: "lambda" }],
  ["machine", { transport: "machine", sandbox: "b", command: ["a"] }],
  [
    "oauth https",
    {
      transport: "http",
      url: "https://a.co",
      oauth: { clientId: "c", clientSecret: "s", refreshToken: "r" },
    },
  ],
  [
    "oauth no url",
    {
      transport: "http",
      oauth: { clientId: "c", clientSecret: "s", refreshToken: "r" },
    },
  ],
];

const badSkillNames: Array<[string, unknown]> = [
  ["number", 1],
  ["empty", ""],
  ["too long", "a".repeat(65)],
  ["uppercase", "Abc"],
  ["reserved anthropic", "my-anthropic"],
  ["reserved claude", "claude-x"],
];

const badDescriptions: Array<[string, unknown]> = [
  ["number", 1],
  ["blank", "   "],
  ["too long", "d".repeat(1025)],
  ["xml", "uses <b>tags</b>"],
];

const badPaths: Array<[string, string]> = [
  ["blank", "  "],
  ["absolute", "/a"],
  ["backslash", "a\\b"],
  ["null byte", "a\0b"],
  ["traversal", "a/../b"],
  ["empty part", "a//b"],
];

const badMarkdown: Array<[string, string, string]> = [
  ["no frontmatter", "# hi", "must start with YAML"],
  ["empty frontmatter", "---\n\n---\n", "must start with YAML"],
  ["bad name", "---\nname: Bad\ndescription: d\n---\n", "Skill name must"],
  ["no description", "---\nname: ok\n---\n", "Skill description must"],
];

const goodMarkdown: Array<[string, string, string, string]> = [
  ["plain", "---\nname: ok\ndescription: does it\n---\nbody", "ok", "does it"],
  ["crlf", "---\r\nname: ok\r\ndescription: d\r\n---", "ok", "d"],
  ["double quoted", '---\nname: "ok"\ndescription: "d e"\n---\n', "ok", "d e"],
  ["single quoted", "---\nname: 'ok'\ndescription: 'd'\n---\n", "ok", "d"],
  ["junk line", "---\n# note\nname: ok\ndescription: d\n---\n", "ok", "d"],
];

const badGitHubUrls: Array<[string, unknown, string]> = [
  ["number", 1, "url must be a non-empty"],
  ["blank", " ", "url must be a non-empty"],
  ["http", "http://github.com/a/b/tree/c", "must use https://github.com"],
  [
    "other host",
    "https://gitlab.com/a/b/tree/c",
    "must use https://github.com",
  ],
  ["encoded dot", "https://github.com/a/b/tree/%2e", "path traversal"],
  ["dots", "https://github.com/a/b/tree/c/..x", "path traversal"],
  ["blob", "https://github.com/a/b/blob/c", "must be https://github.com/"],
  ["no ref", "https://github.com/a/b/tree", "must be https://github.com/"],
  ["bad owner", "https://github.com/a$/b/tree/c", "GitHub owner contains"],
  ["bad repo", "https://github.com/a/b$/tree/c", "GitHub repo contains"],
  ["bad ref", "https://github.com/a/b/tree/c$", "GitHub ref contains"],
];

// Inputs here also feed the Lean twins: each row is a branch of the real function.
describe("mcp input rules", (): void => {
  test.each(rejectedBodies)(
    "rejects %s",
    async (_name: string, body: unknown, message: string): Promise<void> => {
      await expect(
        normalizeMcpInput(body, { requireConnection: false }),
      ).rejects.toThrow(message);
    },
  );

  test.each(acceptedBodies)(
    "accepts %s",
    async (
      _name: string,
      body: Record<string, unknown>,
      expected: object,
    ): Promise<void> => {
      expect(
        await normalizeMcpInput(body, { requireConnection: false }),
      ).toEqual(expected);
    },
  );

  test("hashes an inline bundle", async (): Promise<void> => {
    const input = await normalizeMcpInput(
      { bundle: "export default 1" },
      { requireConnection: false },
    );

    expect(input.transport).toBe("hosted");
    expect(input.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("requires a name and a connection when asked", async (): Promise<void> => {
    const strict = { requireConnection: true };

    await expect(normalizeMcpInput({}, strict)).rejects.toThrow(
      "name must be provided",
    );
    await expect(normalizeMcpInput({ name: "a" }, strict)).rejects.toThrow(
      "url must be provided",
    );
  });

  test.each(rejectedRows)(
    "refuses row: %s",
    (_name: string, row: McpRow, message: string): void => {
      expect((): void => assertMcpRow(row)).toThrow(message);
    },
  );

  test.each(acceptedRows)(
    "keeps row: %s",
    (_name: string, row: McpRow): void => {
      expect(assertMcpRow(row)).toBeUndefined();
    },
  );

  test("encodes the account in a bundle key", (): void => {
    expect(mcpBundleStorageKey("a/b", SHA)).toBe(
      `account-mcp/a%2Fb/bundles/${SHA}.mjs`,
    );
  });
});

describe("skill rules", (): void => {
  test.each(badSkillNames)(
    "rejects name: %s",
    (_n: string, v: unknown): void => {
      expect((): void => validateSkillName(v)).toThrow("Skill name must");
    },
  );

  test("accepts a valid name", (): void => {
    expect(validateSkillName("good-name-1")).toBeUndefined();
  });

  test.each(badDescriptions)(
    "rejects description: %s",
    (_n: string, v: unknown): void => {
      expect((): void => validateSkillDescription(v)).toThrow(
        "Skill description must",
      );
    },
  );

  test("accepts a valid description", (): void => {
    expect(validateSkillDescription("fine")).toBeUndefined();
  });

  test.each(badPaths)("rejects path: %s", (_n: string, v: string): void => {
    expect((): string => normalizeBundlePath(v)).toThrow(
      "Invalid skill file path",
    );
  });

  test("rejects a non-string path and trims a good one", (): void => {
    expect((): string => normalizeBundlePath(1 as unknown as string)).toThrow(
      "must be a string",
    );
    expect(normalizeBundlePath(" a/b.md ")).toBe("a/b.md");
  });

  test.each(badMarkdown)(
    "rejects markdown: %s",
    (_n: string, text: string, message: string): void => {
      expect((): object => parseSkillMarkdown(text)).toThrow(message);
    },
  );

  test.each(goodMarkdown)(
    "parses markdown: %s",
    (_n: string, text: string, name: string, description: string): void => {
      expect(parseSkillMarkdown(text)).toEqual({
        name: name,
        description: description,
      });
    },
  );

  test("picks a content type by extension", (): void => {
    expect(contentTypeForSkillPath("A.JSON")).toBe("application/json");
    expect(contentTypeForSkillPath("a.md")).toBe("text/plain; charset=utf-8");
  });

  test.each(badGitHubUrls)(
    "rejects url: %s",
    (_n: string, v: unknown, message: string): void => {
      expect((): object => parseGitHubSkillUrl(v)).toThrow(message);
    },
  );

  test("parses a GitHub tree url", (): void => {
    expect(
      parseGitHubSkillUrl(" https://github.com/o/r/tree/main/a/b "),
    ).toEqual({
      owner: "o",
      repo: "r",
      ref: "main",
      subdir: "a/b",
      archiveUrl: "https://codeload.github.com/o/r/tar.gz/main",
    });
  });
});

describe("remapKeys", (): void => {
  test("renames mapped keys and keeps the rest", (): void => {
    expect(remapKeys({ a: 1, b: 2 }, { a: "x" })).toEqual({ x: 1, b: 2 });
  });
});
