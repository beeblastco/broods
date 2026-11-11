import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import type { CliManifest } from "../src/contracts.ts";
import { compileProject } from "../src/manifest.ts";
import { BroodsSyncClient } from "../src/sync.ts";
import { requestUrl } from "./fixtures/request-url.ts";

const RESOURCES_MODULE = join(import.meta.dir, "..", "src", "resources.ts");
const MIB = 1024 * 1024;
const STAGE_URL =
  "https://convex.example.com/v1/account/projects/skills-app/stages/development";

type SkillConfig = { files: Array<Record<string, unknown>> } & Record<
  string,
  unknown
>;

let tempDirs: string[] = [];

afterEach(async (): Promise<void> => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  tempDirs = [];
});

test("a 6 MiB skill syncs through one upload, and an unchanged one re-syncs with none", async (): Promise<void> => {
  const { manifest } = await compileProject({
    cwd: await skillProject(),
    command: "dev",
  });
  let held: CliManifest | null = null;
  const sent: Array<{ method: string; url: string; bytes: number }> = [];
  const client = new BroodsSyncClient({
    baseUrl: "https://convex.example.com",
    token: "tok",
    fetch: async (input, init): Promise<Response> => {
      const url = requestUrl(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body;
      sent.push({
        method: method,
        url: url,
        bytes:
          typeof body === "string" || body instanceof Uint8Array
            ? body.length
            : 0,
      });
      if (url === `${STAGE_URL}/skill-uploads`) {
        return Response.json({ uploadUrl: "https://storage.example.com/up" });
      }
      if (url === "https://storage.example.com/up") {
        return Response.json({ storageId: "st_skill" });
      }
      if (method === "GET") {
        return held
          ? Response.json({ manifest: held, ids: {} })
          : new Response("not found", { status: 404 });
      }
      held = (JSON.parse(body as string) as { manifest: CliManifest }).manifest;

      return Response.json({ manifest: held, ids: {} });
    },
  });

  await client.putManifest(manifest, false);
  const first = sent.splice(0);
  expect(first.map(({ method, url }): string => `${method} ${url}`)).toEqual([
    `GET ${STAGE_URL}/manifest`,
    `POST ${STAGE_URL}/skill-uploads`,
    "POST https://storage.example.com/up",
    `PUT ${STAGE_URL}/manifest`,
  ]);
  expect(first[2]?.bytes).toBe(6 * MIB + "# big\n".length);
  const [big, small] =
    (held as CliManifest | null)?.resources.map(
      (resource): SkillConfig => resource.config as SkillConfig,
    ) ?? [];
  expect(big?.filesStorageId).toBe("st_skill");
  expect(big?.files.some((file): boolean => "contentBase64" in file)).toBe(
    false,
  );
  expect(small?.files[0]?.contentBase64).toBeString();

  await client.putManifest(manifest, false);
  expect(sent.splice(0).map(({ method }): string => method)).toEqual([
    "GET",
    "PUT",
  ]);

  const inline = {
    ...manifest,
    resources: manifest.resources.filter(
      (resource): boolean => resource.name === "small",
    ),
  };
  await client.putManifest(inline, false);
  expect(sent.map(({ method }): string => method)).toEqual(["PUT"]);
  expect((held as CliManifest | null)?.resources).toEqual(inline.resources);
});

async function skillProject(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "broods-skill-upload-"));
  tempDirs.push(cwd);
  await mkdir(join(cwd, "broods"), { recursive: true });
  await writeFile(
    join(cwd, "broods", "broods.config.ts"),
    `import { defineBroods } from "${RESOURCES_MODULE}";
export default defineBroods({ project: "skills-app", stages: { dev: "development" } });
`,
  );
  await writeFile(
    join(cwd, "broods", "skills.ts"),
    `import { defineSkill } from "${RESOURCES_MODULE}";
export const big = defineSkill({ name: "big", path: "skills/big" });
export const small = defineSkill({ name: "small", path: "skills/small" });
`,
  );
  for (const name of ["big", "small"]) {
    const root = join(cwd, "broods", "skills", name);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "SKILL.md"), `# ${name}\n`);
  }
  for (const part of ["a", "b"]) {
    await writeFile(
      join(cwd, "broods", "skills", "big", `${part}.txt`),
      Buffer.alloc(3 * MIB, part),
    );
  }

  return cwd;
}
