import { createHash } from "node:crypto";
import type { CliManifest } from "../../../packages/broods/src/contracts.ts";
import { BroodsSyncClient } from "../../../packages/broods/src/sync.ts";
import { MAX_SKILL_BUNDLE_BYTES } from "../../../packages/convex/model/skillLimits.ts";
import { assertStep, type VerifyContext } from "../harness.ts";

const MIB = 1024 * 1024;
// The stack has no skills bucket, so a skill past validation fails at the S3 write with a 500.
const BUCKET_WRITE = "Sync manifest failed: 500 CLI request failed";

export async function largeSkillSync(context: VerifyContext): Promise<void> {
  let uploads = 0;
  let tamper = false;
  const client = new BroodsSyncClient({
    baseUrl: context.edgeUrl,
    token: context.accountSecret,
    fetch: Object.assign(
      async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ): Promise<Response> => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.endsWith("/skill-uploads")) uploads += 1;
        const upload = !url.startsWith(context.edgeUrl);

        return await fetch(
          input,
          tamper && upload ? { ...init, body: Buffer.alloc(6 * MIB) } : init,
        );
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const sync = async (bytes: number): Promise<string> => {
    const manifest: CliManifest = {
      version: 1,
      project: `skills-${context.runId}`,
      stage: "development",
      resources: [skillResource("large-skill", bytes)],
    };
    try {
      await client.putManifest(manifest, false);

      return "synced";
    } catch (error) {
      return String(error);
    }
  };
  const env = context.convex(["env", "list"]).output;
  assertStep(
    "the stack has no skills bucket",
    !env.includes("SKILLS_BUCKET_NAME"),
    env,
  );

  const six = await context.measure("sync a 6 MiB skill", () => sync(6 * MIB));
  assertStep(
    "a 6 MiB skill reaches the skills bucket write through one upload",
    six.includes(BUCKET_WRITE) && uploads === 1,
    `${six}; uploads ${uploads}`,
  );
  const ceiling = await sync(MAX_SKILL_BUNDLE_BYTES);
  assertStep(
    "a 30 MiB skill, the server's limit, reaches the skills bucket write",
    ceiling.includes(BUCKET_WRITE),
    ceiling,
  );
  const over = await sync(MAX_SKILL_BUNDLE_BYTES + 1);
  assertStep(
    "a skill past 30 MiB is refused at the claim, before any read",
    over.includes("Uploaded file exceeds"),
    over,
  );
  tamper = true;
  const tampered = await sync(6 * MIB);
  assertStep(
    "uploaded bytes that do not match the manifest are refused",
    tampered.includes("does not match its sha256"),
    tampered,
  );
}

function skillResource(
  name: string,
  totalBytes: number,
): CliManifest["resources"][number] {
  const contents = [
    Buffer.from(`---\nname: ${name}\ndescription: Large skill.\n---\n`),
  ];
  let left = totalBytes - contents[0]!.byteLength;
  while (left > 0) {
    const size = Math.min(left, 5 * MIB);
    contents.push(Buffer.alloc(size, "x"));
    left -= size;
  }

  return {
    kind: "skill",
    name: name,
    config: {
      source: "files",
      path: `skills/${name}`,
      files: contents.map((bytes, index): Record<string, unknown> => ({
        path: index === 0 ? "SKILL.md" : `part-${index}.txt`,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        contentBase64: bytes.toString("base64"),
        contentType: "text/plain",
      })),
    },
  };
}
