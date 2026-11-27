import type { DockSession } from "@/app/lib/agentDock";
import { USER_TOKEN_HEADER } from "@broods/convex/model/userToken";
import { z } from "zod";

// The dock agent's own workspace, by its name in the broods-agent project.
const DOCK_WORKSPACE = "project";
const FOLDER_TIMEOUT_MS = 30_000;

const filesSchema = z.object({
  files: z.array(z.object({ path: z.string(), contentBase64: z.string() })),
});
const sourceSchema = z.object({
  files: z.array(z.object({ path: z.string(), content: z.string() })),
});
// The tab has one dock conversation, so one queue covers every write to its folder.
let folderTail: Promise<unknown> = Promise.resolve();

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

/** The seed with the kept changes laid over it: what Apply deploys, every file in full. */
export function draftFiles(
  seed: readonly DockFile[],
  changes: readonly { content: string | null; path: string }[],
): DockFile[] {
  const files = new Map(seed.map((file) => [file.path, file.content]));
  for (const change of changes) {
    if (change.content === null) files.delete(change.path);
    else files.set(change.path, change.content);
  }

  return [...files].map(([path, content]) => ({
    content: content,
    path: path,
  }));
}

/** Runs the agent folder's reads and writes one at a time; an aborted `signal` skips the line. */
export function onFolder<T>(
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const turn = folderTail;
  const stopped = new Promise<void>((resolve): void => {
    if (signal?.aborted) resolve();
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  const run = Promise.race([turn, stopped]).then(task);
  folderTail = turn.then(() => run).catch((): void => undefined);

  return run;
}

/** The draft the agent left in this user's conversation folder. */
export async function readDraft(
  session: DockSession,
  conversationKey: string,
  signal?: AbortSignal,
): Promise<DockFile[]> {
  return withFolderSignal(signal, async (folder): Promise<DockFile[]> => {
    const response = await fetch(filesUrl(session, conversationKey), {
      headers: headers(session),
      signal: folder,
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
  });
}

/** The stored source a `stageSources.latest` URL points at. */
export async function readSource(
  url: string,
  signal?: AbortSignal,
): Promise<DockFile[]> {
  return withFolderSignal(signal, async (folder): Promise<DockFile[]> => {
    const response = await fetch(url, { signal: folder });
    if (!response.ok)
      throw new Error(`Reading the stage source failed: ${response.status}`);

    return sourceSchema.parse(await response.json()).files;
  });
}

/** A newer source with the draft's edits on top; `lost` are edited paths it also moved. */
export function rebaseDraft(
  seed: readonly DockFile[],
  draft: readonly DockFile[],
  source: readonly DockFile[],
): { files: DockFile[]; lost: string[] } {
  const before = new Map(seed.map((file) => [file.path, file.content]));
  const after = new Map(draft.map((file) => [file.path, file.content]));
  const files = new Map(source.map((file) => [file.path, file.content]));
  const lost: string[] = [];
  for (const { path } of draftChanges(seed, draft)) {
    const next = after.get(path);
    const base = files.get(path);
    if (base === next) continue;
    if (base !== before.get(path)) lost.push(path);
    else if (next === undefined) files.delete(path);
    else files.set(path, next);
  }

  return {
    files: [...files].map(([path, content]) => ({
      content: content,
      path: path,
    })),
    lost: lost,
  };
}

/** Seeds the folder with the source at `url`, the draft's edits on top when there is one. */
export async function reseedConversation(
  session: DockSession,
  conversationKey: string,
  url: string,
  seed: readonly DockFile[] | undefined,
  signal: AbortSignal,
): Promise<{ files: DockFile[]; lost: string[] }> {
  const files = await readSource(url, signal);
  const rebased = seed
    ? rebaseDraft(
        seed,
        await readDraft(session, conversationKey, signal),
        files,
      )
    : { files: files, lost: [] };
  await seedConversation(session, conversationKey, rebased.files, signal);

  return { files: files, lost: rebased.lost };
}

/** Puts `paths` back as the seed has them in the folder's turn, so a drop is not proposed again. */
export function revertPaths(
  session: () => Promise<DockSession | null>,
  conversationKey: string,
  seed: () => readonly DockFile[] | undefined,
  paths: readonly string[],
): Promise<void> {
  return onFolder(async (): Promise<void> => {
    const files = seed();
    if (!files) return;
    const live = await session();
    if (!live) throw new Error("Signing in to the agent failed");
    const reverted = new Set(paths);
    const draft = await readDraft(live, conversationKey);
    await seedConversation(live, conversationKey, [
      ...draft.filter((file) => !reverted.has(file.path)),
      ...files.filter((file) => reverted.has(file.path)),
    ]);
  });
}

/** Puts the stage's source in the conversation's folder before the agent's first turn. */
export async function seedConversation(
  session: DockSession,
  conversationKey: string,
  files: readonly DockFile[],
  signal?: AbortSignal,
): Promise<void> {
  const encoder = new TextEncoder();
  const body = JSON.stringify({
    files: files.map((file) => ({
      path: file.path,
      contentBase64: btoa(
        Array.from(encoder.encode(file.content), (byte) =>
          String.fromCharCode(byte),
        ).join(""),
      ),
    })),
  });
  await withFolderSignal(signal, async (folder): Promise<void> => {
    const response = await fetch(filesUrl(session, conversationKey), {
      method: "PUT",
      headers: { ...headers(session), "Content-Type": "application/json" },
      body: body,
      signal: folder,
    });
    if (!response.ok)
      throw new Error(`Seeding the conversation failed: ${response.status}`);
  });
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

// Not AbortSignal.any, which browsers in the build target (Safari 16.4, Chrome 111) lack.
async function withFolderSignal<T>(
  signal: AbortSignal | undefined,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const stop = (): void => controller.abort(signal?.reason);
  const timer = setTimeout(() => {
    controller.abort(
      new DOMException(
        `The agent's folder did not answer within ${FOLDER_TIMEOUT_MS / 1000} seconds`,
        "TimeoutError",
      ),
    );
  }, FOLDER_TIMEOUT_MS);
  signal?.addEventListener("abort", stop, { once: true });
  if (signal?.aborted) stop();
  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}
