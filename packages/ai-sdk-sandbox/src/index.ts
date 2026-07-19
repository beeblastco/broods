import { Buffer } from "node:buffer";
import {
  HarnessCapabilityUnsupportedError,
  type HarnessV1NetworkPolicy,
  type HarnessV1NetworkSandboxSession,
  type HarnessV1SandboxProvider,
} from "@ai-sdk/harness";
import {
  extractLines,
  type Experimental_SandboxProcess,
  type Experimental_SandboxSession,
} from "@ai-sdk/provider-utils";

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

/**
 * One live sandbox resource owned by an injected Broods driver.
 *
 * A future core-owned driver delegates provider credentials, reservation,
 * persistence, and cleanup to the existing sandbox runtime. This package only
 * adapts that resource to Harness v1.
 */
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
  /** Stop compute while retaining any driver-owned resumable resource. */
  stop(): PromiseLike<void>;
  /**
   * Permanently release the resource. When supplied, this must accept either a
   * running or already-stopped resource. The adapter invokes it at most once.
   */
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
  /**
   * Whether this is the first resource for the requested identity. Drivers
   * must report `true` at most once per identity so Harness one-time setup is
   * not repeated on a restored resource.
   */
  readonly isFirstCreate: boolean;
}

/**
 * The only boundary a future core integration needs to implement.
 *
 * That implementation should adapt core's `createSandboxExecutor()` and reuse
 * its existing reservation and cleanup paths, not introduce another provider
 * registry or persistence layer.
 */
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
  /** Ports pre-allocated by a caller that supplies a shared sandbox resource. */
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

/** Create a stable Harness v1 provider backed by an injected Broods driver. */
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
        await options.onFirstCreate(session.restricted(), {
          ...(options.abortSignal !== undefined
            ? { abortSignal: options.abortSignal }
            : {}),
        });
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
  readonly #session: BroodsSandboxDriverSession;

  constructor(session: BroodsSandboxDriverSession) {
    this.#session = session;
  }

  get description(): string {
    return this.#session.description;
  }

  async run(
    options: BroodsSandboxCommandOptions,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    options.abortSignal?.throwIfAborted();
    return await this.#session.runCommand(options);
  }

  async spawn(
    options: BroodsSandboxCommandOptions,
  ): Promise<Experimental_SandboxProcess> {
    options.abortSignal?.throwIfAborted();
    return await this.#session.spawnCommand(options);
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
    return await this.#session.readFile({
      path: options.path,
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
      text,
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
      content,
      abortSignal: options.abortSignal,
    });
  }

  async writeBinaryFile(options: BroodsSandboxWriteFileOptions): Promise<void> {
    options.abortSignal?.throwIfAborted();
    await this.#session.writeFile(options);
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
}

class BroodsNetworkSandboxSession
  extends BroodsSandboxSession
  implements HarnessV1NetworkSandboxSession
{
  readonly #driverSession: BroodsSandboxDriverSession;
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
    this.#driverSession = session;
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
    return this.#driverSession.id;
  }

  get defaultWorkingDirectory(): string {
    return this.#driverSession.defaultWorkingDirectory;
  }

  get ports(): ReadonlyArray<number> {
    return [...this.#driverSession.ports];
  }

  readonly getPortUrl = async (options: {
    port: number;
    protocol?: "http" | "https" | "ws";
  }): Promise<string> => {
    if (!this.#driverSession.getPortUrl) {
      throw new HarnessCapabilityUnsupportedError({
        harnessId: this.#providerId,
        message: `${this.#providerId} cannot expose a sandbox port URL.`,
      });
    }
    return await this.#driverSession.getPortUrl(options);
  };

  readonly stop = (): Promise<void> => {
    if (this.#destroyPromise) return this.#destroyPromise;
    this.#stopPromise ??= Promise.resolve().then(async () => {
      await this.#driverSession.stop();
    });
    return this.#stopPromise;
  };

  readonly destroy = (): Promise<void> => {
    if (this.#destroyPromise) return this.#destroyPromise;
    if (!this.#driverSession.destroy) {
      this.#destroyPromise = this.stop();
      return this.#destroyPromise;
    }

    this.#destroyPromise = Promise.resolve().then(async () => {
      await this.#driverSession.destroy!();
    });
    return this.#destroyPromise;
  };

  restricted(): Experimental_SandboxSession {
    return new BroodsSandboxSession(this.#driverSession);
  }
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
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
        try {
          const cancellation = reader.cancel(reason);
          void cancellation.catch(() => undefined);
        } catch {
          // Preserve the signal's abort reason even if stream cancellation fails.
        }
        try {
          reader.releaseLock();
        } catch {
          // Preserve the signal's abort reason even if the reader cannot unlock.
        }
        reject(reason);
      };

      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  }

  try {
    while (true) {
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
