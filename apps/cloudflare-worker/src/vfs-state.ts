import { gunzipSync, gzipSync } from "node:zlib";
import { Bash, InMemoryFs, type IFileSystem } from "just-bash/browser";

// Fits an isolate's memory and keeps the header under the 32 MiB an RPC message may carry.
const MAX_FS_BYTES = 24 * 1024 * 1024;
const DEFAULT_PATHS: ReadonlySet<string> = defaultPaths();
const HEADER_LENGTH_BYTES = 4;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

type StateEntry =
  | { path: string; kind: "dir"; mode: number }
  | { path: string; kind: "file"; mode: number; mtime: number; size: number }
  | { path: string; kind: "link"; target: string };

export interface DecodedState {
  fs: InMemoryFs;
  packed: Uint8Array;
}

export function compressState(packed: Uint8Array): Uint8Array {
  return new Uint8Array(gzipSync(packed));
}

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

export function emptyFs(): InMemoryFs {
  return new InMemoryFs(undefined, { maxTotalBytes: MAX_FS_BYTES });
}

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

function defaultPaths(): ReadonlySet<string> {
  const fs = new InMemoryFs();
  new Bash({ fs: fs, cwd: "/" });

  return new Set(fs.getAllPaths());
}
