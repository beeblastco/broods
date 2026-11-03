import { Buffer } from "node:buffer";
import { isAbsolute, join } from "node:path/posix";
import {
  HarnessCapabilityUnsupportedError,
  type HarnessV1PortEndpoint,
  type HarnessV1NetworkPolicy,
  type HarnessV1NetworkSandboxSession,
  type HarnessV1SandboxProvider,
} from "@ai-sdk/harness";
import {
  extractLines,
  type Experimental_SandboxDirectoryEntry,
  type Experimental_SandboxFileStat,
  type Experimental_SandboxProcess,
  type Experimental_SandboxSession,
  type Experimental_SandboxSpawnOptions,
  type Experimental_SandboxSpawnOptionsWithStdin,
  type Experimental_SandboxSpawnOptionsWithoutStdin,
  type Experimental_WritableSandboxProcess,
} from "@ai-sdk/provider-utils";

// The path rides an env var so no method shell-quotes it; POSIX sh, test, wc and rm only.
const STAT_SCRIPT = `p=$BROODS_SANDBOX_PATH
if [ ! -e "$p" ]; then echo missing
elif [ -d "$p" ]; then echo directory 0
elif [ -f "$p" ]; then echo file $(wc -c < "$p")
else echo other 0; fi`;
// Names cannot hold "/", so "/" plus a newline ends each record even when a name has a newline.
const LIST_DIRECTORY_SCRIPT = `p=$BROODS_SANDBOX_PATH
if [ ! -e "$p" ]; then echo missing; exit 0; fi
if [ ! -d "$p" ]; then echo "not a directory: $p" >&2; exit 20; fi
echo ok
for e in "$p"/* "$p"/.[!.]* "$p"/..?*; do
  if [ ! -e "$e" ] && [ ! -L "$e" ]; then continue; fi
  if [ -L "$e" ]; then t=symlink; elif [ -d "$e" ]; then t=directory
  elif [ -f "$e" ]; then t=file; else t=other; fi
  printf '%s %s/\n' "$t" "\${e##*/}"
done`;
const DELETE_FILE_SCRIPT = `p=$BROODS_SANDBOX_PATH
if [ -d "$p" ] && [ ! -L "$p" ]; then echo "is a directory: $p" >&2; exit 21; fi
if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo missing; exit 0; fi
rm -f -- "$p" && echo deleted`;

export interface BroodsSandboxCommandOptions {
  command: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
}

export interface BroodsSandboxFileOptions {
  path: string;
  abortSignal?: AbortSignal;
}

export interface BroodsSandboxWriteFileOptions extends BroodsSandboxFileOptions {
  content: Uint8Array;
}

export interface BroodsSandboxDriverSession {
  readonly id: string;
  readonly description: string;
  readonly defaultWorkingDirectory: string;
  readonly ports: ReadonlyArray<number>;
  runCommand(options: BroodsSandboxCommandOptions): PromiseLike<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  spawnCommand(
    options: BroodsSandboxCommandOptions,
  ): PromiseLike<Experimental_SandboxProcess>;
  readFile(options: BroodsSandboxFileOptions): PromiseLike<Uint8Array | null>;
  writeFile(options: BroodsSandboxWriteFileOptions): PromiseLike<void>;
  getPortUrl?(options: {
    port: number;
    protocol?: "http" | "https" | "ws";
  }): PromiseLike<string>;
  setNetworkPolicy?(policy: HarnessV1NetworkPolicy): PromiseLike<void>;
  setPorts?(
    ports: ReadonlyArray<number>,
    options?: { abortSignal?: AbortSignal },
  ): PromiseLike<void>;
  /** Stop compute but keep any resumable resource. */
  stop(): PromiseLike<void>;
  /** Must accept a running or already-stopped resource; the adapter calls it at most once. */
  destroy?(): PromiseLike<void>;
}

export interface BroodsSandboxDriverCreateOptions {
  sessionId?: string;
  identity?: string;
  abortSignal?: AbortSignal;
}

export interface BroodsSandboxDriverResumeOptions {
  sessionId: string;
  abortSignal?: AbortSignal;
}

export interface BroodsSandboxDriverCreateResult {
  readonly session: BroodsSandboxDriverSession;
  /** `true` at most once per identity, or Harness reruns one-time setup on a restored one. */
  readonly isFirstCreate: boolean;
}

export interface BroodsSandboxDriver {
  /** Rejecting after allocation must clean up that partial resource internally. */
  createSession(
    options: BroodsSandboxDriverCreateOptions,
  ): PromiseLike<BroodsSandboxDriverCreateResult>;
  resumeSession?(
    options: BroodsSandboxDriverResumeOptions,
  ): PromiseLike<BroodsSandboxDriverSession>;
}

export interface BroodsSandboxProviderOptions {
  driver: BroodsSandboxDriver;
  providerId?: string;
  bridgePorts?: ReadonlyArray<number>;
}

type CreateSessionOptions = {
  sessionId?: string;
  abortSignal?: AbortSignal;
  identity?: string;
  onFirstCreate?: (
    session: Experimental_SandboxSession,
    options: { abortSignal?: AbortSignal },
  ) => Promise<void>;
};

export function createBroodsSandbox(
  options: BroodsSandboxProviderOptions,
): BroodsSandboxProvider {
  return new BroodsSandboxProvider(options);
}

export class BroodsSandboxProvider implements HarnessV1SandboxProvider {
  readonly specificationVersion = "harness-sandbox-v1" as const;
  readonly providerId: string;
  readonly bridgePorts?: ReadonlyArray<number>;
  readonly resumeSession?: (
    options: BroodsSandboxDriverResumeOptions,
  ) => Promise<HarnessV1NetworkSandboxSession>;

  readonly #driver: BroodsSandboxDriver;

  constructor(options: BroodsSandboxProviderOptions) {
    this.#driver = options.driver;
    this.providerId = options.providerId ?? "broods-sandbox";
    if (options.bridgePorts?.length)
      this.bridgePorts = [...options.bridgePorts];

    const resumeSession = options.driver.resumeSession?.bind(options.driver);
    if (resumeSession) {
      this.resumeSession = async (resumeOptions) => {
        resumeOptions.abortSignal?.throwIfAborted();
        const driverSession = await resumeSession(resumeOptions);

        return new BroodsNetworkSandboxSession(driverSession, this.providerId);
      };
    }
  }

  readonly createSession = async (
    options: CreateSessionOptions = {},
  ): Promise<HarnessV1NetworkSandboxSession> => {
    options.abortSignal?.throwIfAborted();
    const { session: driverSession, isFirstCreate } =
      await this.#driver.createSession({
        ...(options.sessionId !== undefined
          ? { sessionId: options.sessionId }
          : {}),
        ...(options.identity !== undefined
          ? { identity: options.identity }
          : {}),
        ...(options.abortSignal !== undefined
          ? { abortSignal: options.abortSignal }
          : {}),
      });
    const session = new BroodsNetworkSandboxSession(
      driverSession,
      this.providerId,
    );

    if (options.onFirstCreate && isFirstCreate) {
      try {
        await options.onFirstCreate(
          session.restricted(),
          options.abortSignal !== undefined
            ? { abortSignal: options.abortSignal }
            : {},
        );
      } catch (setupError) {
        try {
          await session.destroy();
        } catch (cleanupError) {
          throw new AggregateError(
            [setupError, cleanupError],
            "Broods sandbox setup failed and cleanup also failed.",
            { cause: setupError },
          );
        }
        throw setupError;
      }
    }

    return session;
  };
}

class BroodsSandboxSession implements Experimental_SandboxSession {
  // Harness narrows leased ports with Object.create(session): state must read through it.
  protected readonly session: BroodsSandboxDriverSession;

  constructor(session: BroodsSandboxDriverSession) {
    this.session = session;
  }

  get description(): string {
    return this.session.description;
  }

  async deleteFile(options: BroodsSandboxFileOptions): Promise<boolean> {
    const stdout = await this.script(DELETE_FILE_SCRIPT, options);

    return stdout.trim() === "deleted";
  }

  async listDirectory(
    options: BroodsSandboxFileOptions,
  ): Promise<Experimental_SandboxDirectoryEntry[] | null> {
    const stdout = await this.script(LIST_DIRECTORY_SCRIPT, options);
    if (stdout.trim() === "missing") return null;

    return stdout
      .slice(stdout.indexOf("\n") + 1)
      .split("/\n")
      .filter(Boolean)
      .map((record): Experimental_SandboxDirectoryEntry => {
        const space = record.indexOf(" ");

        return {
          name: record.slice(space + 1),
          type: record.slice(
            0,
            space,
          ) as Experimental_SandboxDirectoryEntry["type"],
        };
      });
  }

  async run(
    options: BroodsSandboxCommandOptions,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    options.abortSignal?.throwIfAborted();

    return await this.session.runCommand(this.command(options));
  }

  spawn(
    options: Experimental_SandboxSpawnOptionsWithStdin,
  ): Promise<Experimental_WritableSandboxProcess>;
  spawn(
    options: Experimental_SandboxSpawnOptionsWithoutStdin,
  ): Promise<Experimental_SandboxProcess>;
  spawn(
    options: Experimental_SandboxSpawnOptions,
  ): Promise<Experimental_SandboxProcess | Experimental_WritableSandboxProcess>;
  async spawn(
    options: Experimental_SandboxSpawnOptions,
  ): Promise<Experimental_SandboxProcess> {
    options.abortSignal?.throwIfAborted();
    if (options.stdin) {
      throw new HarnessCapabilityUnsupportedError({
        harnessId: "broods-sandbox",
        message: "Broods sandboxes cannot keep a process's stdin open.",
      });
    }
    const { stdin: _stdin, ...command } = options;

    return await this.session.spawnCommand(this.command(command));
  }

  async stat(
    options: BroodsSandboxFileOptions,
  ): Promise<Experimental_SandboxFileStat | null> {
    const [type, size] = (await this.script(STAT_SCRIPT, options))
      .trim()
      .split(" ");
    if (type === "missing") return null;

    return {
      type: type as Experimental_SandboxFileStat["type"],
      size: Number(size),
    };
  }

  async readFile(
    options: BroodsSandboxFileOptions,
  ): Promise<ReadableStream<Uint8Array> | null> {
    const bytes = await this.readBinaryFile(options);

    return bytes === null ? null : bytesToStream(bytes);
  }

  async readBinaryFile(
    options: BroodsSandboxFileOptions,
  ): Promise<Uint8Array | null> {
    options.abortSignal?.throwIfAborted();

    return await this.session.readFile({
      path: this.path(options.path),
      ...(options.abortSignal !== undefined
        ? { abortSignal: options.abortSignal }
        : {}),
    });
  }

  async readTextFile(
    options: BroodsSandboxFileOptions & {
      encoding?: string;
      startLine?: number;
      endLine?: number;
    },
  ): Promise<string | null> {
    const bytes = await this.readBinaryFile(options);
    if (bytes === null) return null;
    const text = Buffer.from(bytes).toString(
      (options.encoding ?? "utf-8") as BufferEncoding,
    );

    return extractLines({
      text: text,
      startLine: options.startLine,
      endLine: options.endLine,
    });
  }

  async writeFile(
    options: BroodsSandboxFileOptions & { content: ReadableStream<Uint8Array> },
  ): Promise<void> {
    const content = await collectStream(options.content, options.abortSignal);
    await this.writeBinaryFile({
      path: options.path,
      content: content,
      abortSignal: options.abortSignal,
    });
  }

  async writeBinaryFile(options: BroodsSandboxWriteFileOptions): Promise<void> {
    options.abortSignal?.throwIfAborted();
    await this.session.writeFile({
      ...options,
      path: this.path(options.path),
    });
  }

  async writeTextFile(
    options: BroodsSandboxFileOptions & { content: string; encoding?: string },
  ): Promise<void> {
    options.abortSignal?.throwIfAborted();
    const buffer = Buffer.from(
      options.content,
      (options.encoding ?? "utf-8") as BufferEncoding,
    );
    await this.writeBinaryFile({
      path: options.path,
      content: new Uint8Array(
        buffer.buffer,
        buffer.byteOffset,
        buffer.byteLength,
      ),
      abortSignal: options.abortSignal,
    });
  }

  private command(
    options: BroodsSandboxCommandOptions,
  ): BroodsSandboxCommandOptions {
    return options.workingDirectory === undefined
      ? options
      : { ...options, workingDirectory: this.path(options.workingDirectory) };
  }

  private path(path: string): string {
    return isAbsolute(path)
      ? path
      : join(this.session.defaultWorkingDirectory, path);
  }

  private async script(
    command: string,
    options: BroodsSandboxFileOptions,
  ): Promise<string> {
    options.abortSignal?.throwIfAborted();
    const result = await this.session.runCommand({
      command: command,
      env: { BROODS_SANDBOX_PATH: this.path(options.path) },
      ...(options.abortSignal !== undefined
        ? { abortSignal: options.abortSignal }
        : {}),
    });
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim() || `sandbox command exited ${result.exitCode}`,
      );
    }

    return result.stdout;
  }
}

class BroodsNetworkSandboxSession
  extends BroodsSandboxSession
  implements HarnessV1NetworkSandboxSession
{
  readonly #providerId: string;
  #stopPromise: Promise<void> | undefined;
  #destroyPromise: Promise<void> | undefined;

  readonly setNetworkPolicy?: (policy: HarnessV1NetworkPolicy) => Promise<void>;
  readonly setPorts?: (
    ports: ReadonlyArray<number>,
    options?: { abortSignal?: AbortSignal },
  ) => Promise<void>;

  constructor(session: BroodsSandboxDriverSession, providerId: string) {
    super(session);
    this.#providerId = providerId;

    if (session.setNetworkPolicy) {
      this.setNetworkPolicy = async (policy) => {
        await session.setNetworkPolicy!(policy);
      };
    }
    if (session.setPorts) {
      this.setPorts = async (ports, options) => {
        options?.abortSignal?.throwIfAborted();
        await session.setPorts!(ports, options);
      };
    }
  }

  get id(): string {
    return this.session.id;
  }

  get defaultWorkingDirectory(): string {
    return this.session.defaultWorkingDirectory;
  }

  get ports(): ReadonlyArray<number> {
    return [...this.session.ports];
  }

  readonly getPortUrl = async (options: {
    port: number;
    protocol?: "http" | "https" | "ws";
  }): Promise<string> => {
    if (!this.session.getPortUrl) {
      throw new HarnessCapabilityUnsupportedError({
        harnessId: this.#providerId,
        message: `${this.#providerId} cannot expose a sandbox port URL.`,
      });
    }

    return await this.session.getPortUrl(options);
  };

  readonly getPortEndpoint = async (options: {
    port: number;
    protocol?: "http" | "https" | "ws";
  }): Promise<HarnessV1PortEndpoint> => {
    return { url: await this.getPortUrl(options) };
  };

  readonly stop = (): Promise<void> => {
    if (this.#destroyPromise) return this.#destroyPromise;
    this.#stopPromise ??= Promise.resolve().then(async () => {
      await this.session.stop();
    });

    return this.#stopPromise;
  };

  readonly destroy = (): Promise<void> => {
    if (this.#destroyPromise) return this.#destroyPromise;
    if (!this.session.destroy) {
      this.#destroyPromise = this.stop();

      return this.#destroyPromise;
    }

    this.#destroyPromise = Promise.resolve().then(async () => {
      await this.session.destroy!();
    });

    return this.#destroyPromise;
  };

  restricted(): Experimental_SandboxSession {
    return new BroodsSandboxSession(this.session);
  }
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start: function (controller): void {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function collectStream(
  stream: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let aborted = false;
  let onAbort: (() => void) | undefined;
  let abortPromise: Promise<never> | undefined;

  if (abortSignal) {
    abortPromise = new Promise((_, reject) => {
      onAbort = () => {
        aborted = true;
        const reason =
          abortSignal.reason ?? new DOMException("Aborted", "AbortError");
        // The abort reason must reach the caller even if cancel or unlock throws.
        try {
          const cancellation = reader.cancel(reason);
          void cancellation.catch(() => undefined);
        } catch {}
        try {
          reader.releaseLock();
        } catch {}
        reject(reason);
      };

      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  }

  try {
    for (;;) {
      abortSignal?.throwIfAborted();
      const read = reader.read();
      const { value, done } = abortPromise
        ? await Promise.race([read, abortPromise])
        : await read;
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    if (abortSignal && onAbort)
      abortSignal.removeEventListener("abort", onAbort);
    if (!aborted) reader.releaseLock();
  }

  const content = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return content;
}
