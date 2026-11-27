import { gunzipSync } from "node:zlib";
import { z } from "zod";
import type { ResolvedWorkspace } from "../shared/workspaces.ts";
import { shellQuote } from "./sandbox/utils.ts";
import { runSandbox, toWorkspaceRelative } from "./tools/filesystem-utils.ts";

/** A seed is a project folder, not a dataset: base64 of about 4 MiB of files. */
export const MAX_CONVERSATION_FILES_BODY_BYTES = 6 * 1024 * 1024;

export const conversationFilesSchema = z.object({
  files: z.array(z.object({ path: z.string(), contentBase64: z.string() })),
});

export type ConversationFile = z.infer<
  typeof conversationFilesSchema
>["files"][number];

// Gzipped on the way out: the exec answer is capped at 1 MiB, and source compresses well.
export async function readConversationFiles(
  ws: ResolvedWorkspace & {
    sandbox: NonNullable<ResolvedWorkspace["sandbox"]>;
  },
): Promise<ConversationFile[]> {
  const result = await runSandbox(
    ws.sandbox,
    ws.namespace,
    `find . -type f | while IFS= read -r f; do printf '%s\\t' "$f"; base64 -w0 "$f"; printf '\\n'; done | gzip -c | base64 -w0`,
  );
  if (!result.ok)
    throw new Error(
      `${result.stderr}${result.stdout}`.trim() || "listing failed",
    );
  if (result.truncated)
    throw new Error(
      "The folder is over the sandbox's output limit to list in one read.",
    );
  const listing = gunzipSync(
    Buffer.from(result.stdout.trim(), "base64"),
  ).toString("utf8");

  return listing
    .split("\n")
    .filter((line) => line.includes("\t"))
    .map((line): ConversationFile => {
      const tab = line.indexOf("\t");

      return {
        path: line.slice(0, tab).replace(/^\.\//, ""),
        contentBase64: line.slice(tab + 1),
      };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Replaces everything in the folder with `files`, in one command. */
export async function writeConversationFiles(
  ws: ResolvedWorkspace & {
    sandbox: NonNullable<ResolvedWorkspace["sandbox"]>;
  },
  files: readonly ConversationFile[],
): Promise<void> {
  const writes = files.map((file) => {
    const q = shellQuote(`./${toWorkspaceRelative(file.path)}`);

    return `mkdir -p "$(dirname ${q})" && printf '%s' ${shellQuote(file.contentBase64)} | base64 -d > ${q}`;
  });
  const result = await runSandbox(
    ws.sandbox,
    ws.namespace,
    ["rm -rf ./* ./.[!.]* ./..?*", ...writes].join(" && "),
  );
  if (!result.ok)
    throw new Error(
      `${result.stderr}${result.stdout}`.trim() || "write failed",
    );
}
