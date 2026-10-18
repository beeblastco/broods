/**
 * A sandbox's files as bytes and back. just-bash keeps its disk in memory and
 * has no snapshot of its own, so the runtime walks the tree after each command
 * and the host stores the result in R2 under the sandbox id. Only what a
 * command wrote is kept; the shell's own layout (`/bin`, `/dev`, `/proc`) is
 * rebuilt by every fresh disk.
 */

import { Bash, InMemoryFs, type IFileSystem } from "just-bash/browser";

// What one disk may hold uncompressed, well inside an isolate's memory.
const MAX_FS_BYTES = 32 * 1024 * 1024;
// Paths every fresh disk already has once a shell starts on it, so they are never stored.
const DEFAULT_PATHS: ReadonlySet<string> = defaultPaths();
const BASE64_CHUNK = 0x8000;

/** One stored path: a file with its bytes, a directory, or a symlink with its target. */
type StateEntry =
  | { path: string; kind: "dir"; mode: number }
  | { path: string; kind: "file"; mode: number; mtime: number; base64: string }
  | { path: string; kind: "link"; target: string };

/** A fresh disk with nothing but the shell's own layout. */
export function emptyFs(): InMemoryFs {
  return new InMemoryFs(undefined, { maxTotalBytes: MAX_FS_BYTES });
}

/** A disk holding what `encodeState` stored. */
export async function decodeState(bytes: Uint8Array): Promise<InMemoryFs> {
  const entries: StateEntry[] = JSON.parse(
    new TextDecoder().decode(await gunzip(bytes)),
  );
  const fs = emptyFs();
  for (const entry of entries) {
    if (entry.kind === "dir") {
      fs.mkdirSync(entry.path, { recursive: true });
      await fs.chmod(entry.path, entry.mode);
    } else if (entry.kind === "file") {
      fs.writeFileSync(entry.path, fromBase64(entry.base64), undefined, {
        mode: entry.mode,
        mtime: new Date(entry.mtime),
      });
    } else {
      await fs.symlink(entry.target, entry.path);
    }
  }

  return fs;
}

/** The disk's own entries, compressed; null when a command left nothing behind. */
export async function encodeState(fs: IFileSystem): Promise<Uint8Array | null> {
  const entries: StateEntry[] = [];
  // Parents sort before their children, so a restore creates them in order.
  const paths = fs
    .getAllPaths()
    .filter((path): boolean => !DEFAULT_PATHS.has(path))
    .sort();
  for (const path of paths) {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink) {
      entries.push({
        path: path,
        kind: "link",
        target: await fs.readlink(path),
      });
    } else if (stat.isDirectory) {
      entries.push({ path: path, kind: "dir", mode: stat.mode });
    } else {
      entries.push({
        path: path,
        kind: "file",
        mode: stat.mode,
        mtime: stat.mtime.getTime(),
        base64: toBase64(await fs.readFileBuffer(path)),
      });
    }
  }
  if (entries.length === 0) return null;

  return await gzip(new TextEncoder().encode(JSON.stringify(entries)));
}

function defaultPaths(): ReadonlySet<string> {
  const fs = new InMemoryFs();
  new Bash({ fs: fs, cwd: "/" });

  return new Set(fs.getAllPaths());
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  return await piped(bytes, new DecompressionStream("gzip"));
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return await piped(bytes, new CompressionStream("gzip"));
}

async function piped(
  bytes: Uint8Array,
  through: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const stream = new Response(bytes).body!.pipeThrough(through);

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Chunked, so a large file does not spread into one giant argument list.
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + BASE64_CHUNK),
    );
  }

  return btoa(binary);
}
