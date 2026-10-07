// The in-VM capture runs for real here: python3 walks a temporary root, a local
// server stands in for the presigned S3 URLs, and the uploaded zip is opened to
// check what the image build would see.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotCapture } from "../src/harness/sandbox/microvm-snapshot.ts";

const python = Bun.which("python3");
let root = "";
let work = "";
let server: ReturnType<typeof Bun.serve> | undefined;
let uploaded: Uint8Array | undefined;
let startedAt = new Date();

describe.skipIf(!python)("snapshotCapture", () => {
  beforeAll(async (): Promise<void> => {
    root = mkdtempSync(join(tmpdir(), "snapshot-root-"));
    work = mkdtempSync(join(tmpdir(), "snapshot-work-"));
    // Files from the image, written before the VM "started".
    write("etc/old.conf", "from the image");
    write("usr/bin/base-tool", "from the image");
    await Bun.sleep(1_200);
    startedAt = new Date();
    await Bun.sleep(1_200);
    // Changes made while the VM ran: kept, except where a snapshot never looks.
    write("usr/local/bin/new-tool", "installed later");
    write("root/.bashrc", "export EDITOR=vi");
    write("tmp/scratch", "scratch space");
    write("mnt/workspaces/ns/file", "lives in S3");
    write("proc/fake", "kernel tree");

    const source = join(work, "source.zip");
    runPython(
      `import zipfile\nwith zipfile.ZipFile(${JSON.stringify(source)}, "w") as z:\n    z.writestr("Dockerfile", "FROM runtime\\n")\n    z.writestr("src/main.rs", "fn main() {}\\n")`,
    );
    const sourceZip = await Bun.file(source).bytes();
    server = Bun.serve({
      port: 0,
      fetch: async (request: Request): Promise<Response> => {
        if (request.method === "GET") return new Response(sourceZip);
        uploaded = new Uint8Array(await request.arrayBuffer());

        return new Response(null, { status: 200 });
      },
    });
  });

  afterAll((): void => {
    void server?.stop(true);
    rmSync(root, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  it("uploads the source zip plus a tar of what changed since the VM started", async () => {
    const capture = snapshotCapture({
      snapshotId: "snap1",
      startedAt: startedAt,
      sourceUrl: `${server?.url}source.zip`,
      uploadUrl: `${server?.url}image.zip`,
      workspaceRoot: "/mnt/workspaces",
    });
    const run = await runCapture({
      cmd: ["bash", "-c", capture.script],
      env: {
        ...process.env,
        ...capture.env,
        BROODS_ROOT: root,
        BROODS_START_SLACK: "0",
      },
    });

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ files: 6 });
    const image = join(work, "image.zip");
    writeFileSync(image, uploaded ?? new Uint8Array());
    const listing = runPython(
      `import io, json, tarfile, zipfile\nz = zipfile.ZipFile(${JSON.stringify(image)})\ntar = tarfile.open(fileobj=io.BytesIO(z.read("broods-snapshot-snap1.tar")))\nprint(json.dumps({"entries": z.namelist(), "dockerfile": z.read("Dockerfile").decode(), "tar": sorted(m.name for m in tar.getmembers() if m.isfile())}))`,
    );

    expect(JSON.parse(listing)).toEqual({
      entries: ["Dockerfile", "src/main.rs", "broods-snapshot-snap1.tar"],
      dockerfile: "FROM runtime\n\nADD broods-snapshot-snap1.tar /\n",
      tar: ["root/.bashrc", "usr/local/bin/new-tool"],
    });
  });

  it("refuses a VM whose clock is too far off to trust file times", async () => {
    const capture = snapshotCapture({
      snapshotId: "snap2",
      startedAt: startedAt,
      sourceUrl: `${server?.url}source.zip`,
      uploadUrl: `${server?.url}image.zip`,
      workspaceRoot: "/mnt/workspaces",
    });
    const run = await runCapture({
      cmd: ["bash", "-c", capture.script],
      env: {
        ...process.env,
        ...capture.env,
        BROODS_ROOT: root,
        BROODS_NOW: String(Date.now() / 1000 - 3_600),
      },
    });

    expect(run.exitCode).not.toBe(0);
    expect(run.stderr).toContain("the VM clock is");
  });
});

// Write `relative` under the temporary root, creating its directories.
function write(relative: string, text: string): void {
  const path = join(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

// Run a short python program and return its stdout, failing on any error.
function runPython(program: string): string {
  const run = Bun.spawnSync({ cmd: [python ?? "python3", "-c", program] });
  if (run.exitCode !== 0) throw new Error(run.stderr.toString());

  return run.stdout.toString().trim();
}

// Run the capture without blocking the event loop the stand-in S3 server needs.
async function runCapture(options: {
  cmd: string[];
  env: Record<string, string | undefined>;
}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn({
    cmd: options.cmd,
    env: options.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { exitCode: exitCode, stdout: stdout, stderr: stderr };
}
