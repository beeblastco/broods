import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODULE = join(import.meta.dir, "local-stack-ports.ts");

let root: string | undefined;

afterEach((): void => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

test("two stacks starting at once get different port blocks", async (): Promise<void> => {
  root = mkdtempSync(join(tmpdir(), "local-stack-ports-"));
  const bases = await Promise.all(
    ["a", "b"].map((id): Promise<number> => reserveInChild(root!, id)),
  );

  expect(bases[0]).not.toBe(bases[1]);
});

// The claim sleeps before saving, as `up` does work before its state lands on disk.
async function reserveInChild(
  dir: string,
  instanceId: string,
): Promise<number> {
  const script = `
    import { mkdirSync, writeFileSync } from "node:fs";
    import { reservePortBase } from ${JSON.stringify(MODULE)};
    const dir = ${JSON.stringify(dir)};
    const base = reservePortBase(dir, (portBase) => {
      Bun.sleepSync(300);
      mkdirSync(dir + "/${instanceId}", { recursive: true });
      writeFileSync(dir + "/${instanceId}/state.json", JSON.stringify({ portBase: portBase }));
      return portBase;
    });
    console.log(base);
  `;
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", script],
    stdout: "pipe",
    stderr: "inherit",
  });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`child ${instanceId} failed`);

  return Number(output.trim());
}
