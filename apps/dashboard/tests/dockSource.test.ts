import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import type { DockSession } from "../app/lib/agentDock";
import {
  draftChanges,
  onFolder,
  rebaseDraft,
  reseedConversation,
  revertPaths,
  type DockFile,
} from "../app/lib/dockSource";

const SEED: DockFile[] = [
  { path: "broods/a.ts", content: "a" },
  { path: "broods/b.ts", content: "b" },
];
const SESSION: DockSession = {
  agentId: "agent",
  expiresAt: 0,
  runtimeKey: "key",
  url: "http://core.test",
  userToken: "token",
};
const PUT_BODY = z.object({
  files: z.array(z.object({ path: z.string(), contentBase64: z.string() })),
});
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("dock source", () => {
  test("a draft's changes are its adds, edits and deletes against the seed, by path", () => {
    expect(
      draftChanges(
        [
          { path: "broods/a.ts", content: "a" },
          { path: "broods/gone.ts", content: "x" },
          { path: "package.json", content: "{}" },
        ],
        [
          { path: "broods/a.ts", content: "b" },
          { path: "broods/new.ts", content: "n" },
          { path: "package.json", content: "{}" },
        ],
      ),
    ).toEqual([
      { path: "broods/a.ts", change: "modify", before: "a", after: "b" },
      { path: "broods/gone.ts", change: "delete", before: "x", after: "" },
      { path: "broods/new.ts", change: "add", before: "", after: "n" },
    ]);
  });

  test("a newer revision keeps the draft's edits where it did not move, and names the rest", () => {
    const seed = [
      { path: "broods/a.ts", content: "a" },
      { path: "broods/b.ts", content: "b" },
      { path: "broods/gone.ts", content: "x" },
    ];
    const draft = [
      { path: "broods/a.ts", content: "a2" },
      { path: "broods/b.ts", content: "b2" },
      { path: "broods/new.ts", content: "n" },
    ];
    const reverted = [
      { path: "broods/a.ts", content: "a" },
      { path: "broods/b.ts", content: "b0" },
      { path: "broods/gone.ts", content: "x" },
    ];

    expect(rebaseDraft(seed, draft, reverted)).toEqual({
      files: [
        { path: "broods/a.ts", content: "a2" },
        { path: "broods/b.ts", content: "b0" },
        { path: "broods/new.ts", content: "n" },
      ],
      lost: ["broods/b.ts"],
    });
  });

  test("two quick drops each revert their own file", async () => {
    const folder = coreFolder([
      { path: "broods/a.ts", content: "a2" },
      { path: "broods/b.ts", content: "b2" },
      { path: "broods/new.ts", content: "n" },
    ]);
    await Promise.all([
      revertPaths(signedIn, "c", seeded, ["broods/a.ts"]),
      revertPaths(signedIn, "c", seeded, ["broods/new.ts"]),
    ]);

    expect(draftChanges(SEED, folder.files())).toEqual([
      { path: "broods/b.ts", change: "modify", before: "b", after: "b2" },
    ]);
  });

  test("a drop during an answer keeps what the agent wrote", async () => {
    const folder = coreFolder([
      { path: "broods/a.ts", content: "a2" },
      SEED[1],
    ]);
    const answer = onFolder(async (): Promise<void> => {
      await Bun.sleep(5);
      folder.write({ path: "broods/b.ts", content: "b3" });
    });
    await Promise.all([
      answer,
      revertPaths(signedIn, "c", seeded, ["broods/a.ts"]),
    ]);

    expect(
      draftChanges(SEED, folder.files()).map((change) => change.after),
    ).toEqual(["b3"]);
  });

  test("a drop with no dock session says so instead of skipping the revert", async () => {
    coreFolder([{ path: "broods/a.ts", content: "a2" }, SEED[1]]);

    await expect(
      revertPaths(async () => null, "c", seeded, ["broods/a.ts"]),
    ).rejects.toThrow("Signing in to the agent failed");
  });

  test("Stop ends an answer's slow folder request", async () => {
    slowCore();
    const controller = new AbortController();
    const reseed = reseedConversation(
      SESSION,
      "c",
      "http://core.test/source",
      SEED,
      controller.signal,
    );
    controller.abort();

    await expect(reseed).rejects.toThrow();
  });

  test("Stop ends an answer waiting behind a slow folder request", async () => {
    slowCore();
    const settled: string[] = [];
    const held = onFolder(() => fetch("http://core.test/files")).then(() =>
      settled.push("held"),
    );
    const controller = new AbortController();
    const answer = onFolder(async (): Promise<void> => {
      controller.signal.throwIfAborted();
    }, controller.signal).catch(() => settled.push("stopped"));
    controller.abort();
    await Promise.all([held, answer]);

    expect(settled).toEqual(["stopped", "held"]);
  });
});

async function signedIn(): Promise<DockSession> {
  return SESSION;
}

function seeded(): DockFile[] {
  return SEED;
}

/** A core that answers every request 300 ms late, unless the request is aborted first. */
function slowCore(): void {
  globalThis.fetch = Object.assign(
    (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(Response.json({ files: [] })),
          300,
        );
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        });
      }),
    { preconnect: realFetch.preconnect },
  );
}

/** Core's conversation folder: a GET reads it and a PUT replaces it, each a few ms late. */
function coreFolder(initial: readonly DockFile[]): {
  files: () => DockFile[];
  write: (file: DockFile) => void;
} {
  const files = new Map(initial.map((file) => [file.path, file.content]));
  globalThis.fetch = Object.assign(
    async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      await Bun.sleep(1);
      if (init?.method !== "PUT") {
        const listed = [...files].map(([path, content]) => ({
          path: path,
          contentBase64: Buffer.from(content).toString("base64"),
        }));
        await Bun.sleep(2);

        return Response.json({ files: listed });
      }
      files.clear();
      const body = typeof init.body === "string" ? init.body : "";
      for (const file of PUT_BODY.parse(JSON.parse(body)).files)
        files.set(
          file.path,
          Buffer.from(file.contentBase64, "base64").toString(),
        );

      return new Response(null, { status: 204 });
    },
    { preconnect: realFetch.preconnect },
  );

  return {
    files: (): DockFile[] =>
      [...files].map(([path, content]) => ({ path: path, content: content })),
    write: (file: DockFile): void => {
      files.set(file.path, file.content);
    },
  };
}
