import { expect, test } from "bun:test";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixtures", "prompt-secret.ts");

/**
 * `broods env set` reads its value through promptSecret. Piped input that ends
 * without a newline (`printf '%s'`) once left the readline question unanswered,
 * so the CLI exited 0 having stored nothing.
 */

test.each([
  ["with a trailing newline", "abc\n"],
  ["with a trailing CRLF", "abc\r\n"],
  ["with a lone trailing CR", "abc\r"],
  ["without a trailing newline", "abc"],
])("a piped value %s is read", async (_name, stdin) => {
  const result = await run(stdin);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain('value="abc"');
});

test("empty piped stdin fails instead of storing nothing", async () => {
  const result = await run("");

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("SECRET is required");
});

// A producer that writes the secret and keeps its end of the pipe open must not
// block the CLI until it exits.
test("the first piped line answers while the pipe stays open", async () => {
  const child = Bun.spawn([process.execPath, FIXTURE], {
    stdin: "pipe",
    stdout: "pipe",
  });
  await child.stdin.write("abc\n");
  await child.stdin.flush();
  const stdout = await new Response(child.stdout).text();
  child.kill();

  expect(stdout).toContain('value="abc"');
});

async function run(
  stdin: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([process.execPath, FIXTURE], {
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
