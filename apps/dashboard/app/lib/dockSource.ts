import type { DockSession } from "@/app/lib/agentDock";
import { USER_TOKEN_HEADER } from "@broods/convex/model/userToken";
import { z } from "zod";

// The dock agent's own workspace, by its name in the broods-agent project.
const DOCK_WORKSPACE = "project";

const filesSchema = z.object({
  files: z.array(z.object({ path: z.string(), contentBase64: z.string() })),
});
const sourceSchema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })),
});

export interface DockFile {
  path: string;
  content: string;
}

export interface DockFileChange {
  path: string;
  change: "add" | "delete" | "modify";
  before: string;
  after: string;
}

/** What Apply would change: the draft against the source the conversation was seeded with. */
export function draftChanges(
  seed: readonly DockFile[],
  draft: readonly DockFile[],
): DockFileChange[] {
  const before = new Map(seed.map((file) => [file.path, file.content]));
  const after = new Map(draft.map((file) => [file.path, file.content]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();

  return paths.flatMap((path): DockFileChange[] => {
    const old = before.get(path);
    const next = after.get(path);
    if (old === next) return [];

    return [
      {
        path: path,
        change:
          old === undefined ? "add" : next === undefined ? "delete" : "modify",
        before: old ?? "",
        after: next ?? "",
      },
    ];
  });
}

/** The draft the agent left in this user's conversation folder. */
export async function readDraft(
  session: DockSession,
  conversationKey: string,
  signal?: AbortSignal,
): Promise<DockFile[]> {
  const response = await fetch(filesUrl(session, conversationKey), {
    headers: headers(session),
    ...(signal ? { signal: signal } : {}),
  });
  if (!response.ok)
    throw new Error(`Reading the draft failed: ${response.status}`);
  const decoder = new TextDecoder();

  return filesSchema.parse(await response.json()).files.map((file) => ({
    path: file.path,
    content: decoder.decode(
      Uint8Array.from(atob(file.contentBase64), (char) => char.charCodeAt(0)),
    ),
  }));
}

/** The stored source a `stageSources.latest` URL points at. */
export async function readSource(url: string): Promise<DockFile[]> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Reading the stage source failed: ${response.status}`);

  return sourceSchema.parse(await response.json()).files;
}

/** Puts the stage's source in the conversation's folder before the agent's first turn. */
export async function seedConversation(
  session: DockSession,
  conversationKey: string,
  files: readonly DockFile[],
): Promise<void> {
  const encoder = new TextEncoder();
  const response = await fetch(filesUrl(session, conversationKey), {
    method: "PUT",
    headers: { ...headers(session), "Content-Type": "application/json" },
    body: JSON.stringify({
      files: files.map((file) => ({
        path: file.path,
        contentBase64: btoa(
          Array.from(encoder.encode(file.content), (byte) =>
            String.fromCharCode(byte),
          ).join(""),
        ),
      })),
    }),
  });
  if (!response.ok)
    throw new Error(`Seeding the conversation failed: ${response.status}`);
}

function filesUrl(session: DockSession, conversationKey: string): string {
  const query = new URLSearchParams({
    agentId: session.agentId,
    conversationKey: conversationKey,
    workspace: DOCK_WORKSPACE,
  });

  return `${session.url}/files?${query.toString()}`;
}

function headers(session: DockSession): Record<string, string> {
  return {
    Authorization: `Bearer ${session.runtimeKey}`,
    [USER_TOKEN_HEADER]: session.userToken,
  };
}
