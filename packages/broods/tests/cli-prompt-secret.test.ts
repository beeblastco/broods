import { expect, test } from "bun:test";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixtures", "prompt-secret.ts");

/**
 * `broods env set` reads its value through promptSecret. Piped input that ends
 * without a newline (`printf '%s'`) once left the readline question unanswered,
 * so the CLI exited 0 having stored nothing.
 */

test.each([
  ["with a trailing newline", "abc\n", "abc"],
  ["with a trailing CRLF", "abc\r\n", "abc"],
  ["with a lone trailing CR", "abc\r", "abc"],
  ["without a trailing newline", "abc", "abc"],
  [
    "over several lines (a PEM key)",
    "-----BEGIN-----\nAAAA\n-----END-----\n",
    "-----BEGIN-----\nAAAA\n-----END-----",
  ],
])("a piped value %s is read whole", async (_name, stdin, value) => {
  const result = await run(stdin);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain(`value=${JSON.stringify(value)}`);
});

test("empty piped stdin fails instead of storing nothing", async () => {
  const result = await run("");

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("SECRET is required");
});

test("an optional prompt skips on an empty line but still stops when input ends", async () => {
  const skipped = await run("\n", ["--optional"]);
  const ended = await run("", ["--optional"]);

  expect(skipped.code).toBe(0);
  expect(skipped.stdout).toContain('value=""');
  // Ctrl+D or Ctrl+C ends the input without a line: the user is aborting.
  expect(ended.code).not.toBe(0);
  expect(ended.stderr).toContain("SECRET is required");
});

async function run(
  stdin: string,
  args: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, FIXTURE, ...args], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { code: code, stdout: stdout, stderr: stderr };
}
