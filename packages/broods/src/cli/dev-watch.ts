import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { GENERATED_DIR } from "../config.ts";

const SYNC_DEBOUNCE_MS = 150;

// `everyFile`: a sync uploads skill files and imports of any extension, not only `.ts`/`.md`.
export async function collectSourceFiles(
  dir: string,
  files: string[],
  everyFile = false,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === GENERATED_DIR ||
        entry.name === "generated" ||
        entry.name === ".cache"
      )
        continue;
      await collectSourceFiles(full, files, everyFile);
      continue;
    }
    if (
      entry.isFile() &&
      (everyFile || entry.name.endsWith(".ts") || entry.name.endsWith(".md"))
    )
      files.push(full);
  }
}

// `broods dev`'s loop: a change under `root` runs `sync`, one at a time with one queued rerun,
// skipped while the source matches the last clean sync. Watches before the first sync.
export function watchSource(
  root: string,
  sync: () => Promise<void>,
): FSWatcher {
  let timer: NodeJS.Timeout | undefined;
  let syncing = false;
  let pending = false;
  let lastSourceSignature: string | undefined;
  let lastSyncFailed = false;
  // A change after the signature may be in what the child read, so that sync records none.
  // Any event counts: a folder rename names no file yet moves them all.
  let savedSinceSignature = false;
  const syncChanged = async (): Promise<void> => {
    savedSinceSignature = false;
    const signature = await sourceSignature(root);
    // A failed sync may have written part of the stage, so even an undo syncs again.
    if (signature === lastSourceSignature && !lastSyncFailed) return;
    lastSyncFailed = true;
    await sync();
    lastSyncFailed = false;
    lastSourceSignature = savedSinceSignature ? undefined : signature;
  };
  const runSync = (): void => {
    if (syncing) {
      pending = true;

      return;
    }
    syncing = true;
    syncChanged()
      .catch((error: unknown): void =>
        console.error(error instanceof Error ? error.message : String(error)),
      )
      .finally((): void => {
        syncing = false;
        if (pending) {
          pending = false;
          runSync();
        }
      });
  };

  const watcher = watch(root, { recursive: true }, (_event, filename): void => {
    if (filename && isGeneratedPath(filename)) return;
    savedSinceSignature = true;
    clearTimeout(timer);
    timer = setTimeout(runSync, SYNC_DEBOUNCE_MS);
  });
  runSync();

  return watcher;
}

function isGeneratedPath(path: string): boolean {
  return path
    .split(/[\\/]/)
    .some(
      (part): boolean =>
        part === GENERATED_DIR || part === "generated" || part === ".cache",
    );
}

async function sourceSignature(root: string): Promise<string> {
  const files: string[] = [];
  await collectSourceFiles(root, files, true);
  const hash = createHash("sha256");
  for (const file of files.sort()) {
    hash.update(relative(root, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }

  return hash.digest("hex");
}
