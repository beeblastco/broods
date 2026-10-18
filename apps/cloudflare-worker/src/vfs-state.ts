/**
 * A sandbox's files as bytes and back. just-bash keeps its disk in memory and
 * has no snapshot of its own, so the runtime walks the tree after each command
 * and the host stores the result in R2 under the sandbox id. Only what a
 * command wrote is kept; the shell's own layout (`/bin`, `/dev`, `/proc`) is
 * rebuilt by every fresh disk. A disk is one gzip of a JSON header (paths,
 * kinds, modes, file sizes) followed by the files' raw bytes in header order.
 */

import { gunzipSync, gzipSync } from "node:zlib";
import { Bash, InMemoryFs, type IFileSystem } from "just-bash/browser";

// What one disk may hold uncompressed: inside an isolate's memory, and with
// the header under the 32 MiB an RPC message may carry.
const MAX_FS_BYTES = 24 * 1024 * 1024;
// Paths every fresh disk already has once a shell starts on it, so they are never stored.
const DEFAULT_PATHS: ReadonlySet<string> = defaultPaths();
const HEADER_LENGTH_BYTES = 4;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

/** One stored path: a file with its size, a directory, or a symlink with its target. */
type StateEntry =
  | { path: string; kind: "dir"; mode: number }
  | { path: string; kind: "file"; mode: number; mtime: number; size: number }
  | { path: string; kind: "link"; target: string };

/** A disk and the uncompressed bytes it was built from, to tell a change from a read. */
export interface DecodedState {
  fs: InMemoryFs;
  packed: Uint8Array;
}

/** A packed disk as the bytes R2 stores. */
export function compressState(packed: Uint8Array): Uint8Array {
  return new Uint8Array(gzipSync(packed));
}

/** A disk holding what `packState` stored. */
export async function decodeState(bytes: Uint8Array): Promise<DecodedState> {
  const packed = new Uint8Array(gunzipSync(bytes));
  const headerLength = new DataView(
    packed.buffer,
    packed.byteOffset,
    HEADER_LENGTH_BYTES,
  ).getUint32(0);
  const entries: StateEntry[] = JSON.parse(
    UTF8_DECODER.decode(
      packed.subarray(HEADER_LENGTH_BYTES, HEADER_LENGTH_BYTES + headerLength),
    ),
  );
  const fs = emptyFs();
  let offset = HEADER_LENGTH_BYTES + headerLength;
  for (const entry of entries) {
    if (entry.kind === "dir") {
      fs.mkdirSync(entry.path, { recursive: true });
      await fs.chmod(entry.path, entry.mode);
    } else if (entry.kind === "file") {
      fs.writeFileSync(
        entry.path,
        packed.subarray(offset, offset + entry.size),
        undefined,
        { mode: entry.mode, mtime: new Date(entry.mtime) },
      );
      offset += entry.size;
    } else {
      await fs.symlink(entry.target, entry.path);
    }
  }

  return { fs: fs, packed: packed };
}

/** A fresh disk with nothing but the shell's own layout. */
export function emptyFs(): InMemoryFs {
  return new InMemoryFs(undefined, { maxTotalBytes: MAX_FS_BYTES });
}

/**
 * The disk's own entries, uncompressed; null when no command left anything
 * behind. The working directory the runtime created for the command counts
 * as the shell's own layout while it stays empty.
 */
export async function packState(
  fs: IFileSystem,
  cwd: string,
): Promise<Uint8Array | null> {
  const entries: StateEntry[] = [];
  const blobs: Uint8Array[] = [];
  // Parents sort before their children, so a restore creates them in order.
  const paths = fs
    .getAllPaths()
    .filter((path): boolean => !DEFAULT_PATHS.has(path))
    .sort();
  const cwdInUse = paths.some((path): boolean => path.startsWith(`${cwd}/`));
  for (const path of paths) {
    if (path === cwd && !cwdInUse) continue;
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
      const bytes = await fs.readFileBuffer(path);
      entries.push({
        path: path,
        kind: "file",
        mode: stat.mode,
        mtime: stat.mtime.getTime(),
        size: bytes.byteLength,
      });
      blobs.push(bytes);
    }
  }
  if (entries.length === 0) return null;
  const header = UTF8_ENCODER.encode(JSON.stringify(entries));
  const packed = new Uint8Array(
    HEADER_LENGTH_BYTES +
      header.byteLength +
      blobs.reduce((total, blob): number => total + blob.byteLength, 0),
  );
  new DataView(packed.buffer).setUint32(0, header.byteLength);
  packed.set(header, HEADER_LENGTH_BYTES);
  let offset = HEADER_LENGTH_BYTES + header.byteLength;
  for (const blob of blobs) {
    packed.set(blob, offset);
    offset += blob.byteLength;
  }

  return packed;
}

/** Whether two packed disks hold the same bytes; a read-only command leaves them equal. */
export function samePacked(
  a: Uint8Array | null,
  b: Uint8Array | null,
): boolean {
  if (a === null || b === null) return a === b;

  return (
    a.byteLength === b.byteLength &&
    a.every((byte, index): boolean => byte === b[index])
  );
}

// The layout just-bash lays down when a shell starts on an empty disk.
function defaultPaths(): ReadonlySet<string> {
  const fs = new InMemoryFs();
  new Bash({ fs: fs, cwd: "/" });

  return new Set(fs.getAllPaths());
}
