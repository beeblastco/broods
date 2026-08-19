/**
 * Core-owned Workdir port for the runtime-unwired AI SDK Harness adapter.
 * Provider selection and reservations stay in the existing sandbox executor;
 * live HarnessAgent selection belongs in the later run-loop integration.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path/posix";
import type {
  BroodsSandboxCommandOptions,
  BroodsSandboxDriver,
  BroodsSandboxDriverCreateOptions,
  BroodsSandboxDriverCreateResult,
  BroodsSandboxDriverResumeOptions,
  BroodsSandboxDriverSession,
  BroodsSandboxFileOptions,
  BroodsSandboxWriteFileOptions,
} from "@broods/ai-sdk-sandbox";
import type { Sandbox } from "@mv37/workdir";
import { createSandboxExecutor } from "./index.ts";
import { optionalEnv } from "../../shared/env.ts";
import {
  HarnessShellProcess,
  type HarnessShellExecutor,
  readHarnessStream,
} from "./harness-shell-process.ts";
import type { SandboxExecutorConfig, SandboxReservationRef } from "./types.ts";
import { configString, shellQuote, stringRecord } from "./utils.ts";
import type { WorkdirHarnessReservation } from "./workdir-executor.ts";

const DEFAULT_WORKING_DIRECTORY = "/workspace";

export interface WorkdirHarnessDriverOptions {
  /** Existing core reservation identity, already scoped to its account/agent. */
  reservationKey: string;
  /** Optional exact bootstrap identity for callers that precompute one. */
  bootstrapIdentity?: string;
  config: SandboxExecutorConfig & { provider: "sandbox"; persistent: true };
  defaultWorkingDirectory?: string;
  ports?: ReadonlyArray<number>;
}

interface WorkdirHarnessExecutor {
  acquireHarnessReservation(request: {
    reservationKey: string;
    abortSignal?: AbortSignal;
  }): Promise<WorkdirHarnessReservation>;
  resumeHarnessReservation(request: {
    reservationKey: string;
    abortSignal?: AbortSignal;
  }): Promise<Sandbox>;
  suspend?(request: SandboxReservationRef): Promise<void>;
  release?(request: SandboxReservationRef): Promise<void>;
}

export function createWorkdirHarnessDriver(
  options: WorkdirHarnessDriverOptions,
): BroodsSandboxDriver {
  const executor = createSandboxExecutor(options.config);
  if (!isWorkdirHarnessExecutor(executor)) {
    throw new Error(
      "Workdir Harness driver requires the core sandbox executor",
    );
  }

  return new WorkdirHarnessDriver(options, executor);
}

export class WorkdirHarnessDriver implements BroodsSandboxDriver {
  readonly #options: WorkdirHarnessDriverOptions;
  readonly #executor: WorkdirHarnessExecutor;

  constructor(
    options: WorkdirHarnessDriverOptions,
    executor: WorkdirHarnessExecutor,
  ) {
    if (!options.reservationKey.trim()) {
      throw new Error("Workdir Harness driver requires a reservationKey");
    }
    if (
      options.config.provider !== "sandbox" ||
      options.config.persistent !== true
    ) {
      throw new Error(
        "Workdir Harness driver requires a persistent sandbox provider config",
      );
    }
    this.#options = options;
    this.#executor = executor;
  }

  async createSession(
    options: BroodsSandboxDriverCreateOptions,
  ): Promise<BroodsSandboxDriverCreateResult> {
    this.#assertBootstrapIdentity(options.identity);
    options.abortSignal?.throwIfAborted();

    let reservation: WorkdirHarnessReservation | undefined;
    try {
      reservation = await this.#executor.acquireHarnessReservation({
        reservationKey: this.#options.reservationKey,
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });
      options.abortSignal?.throwIfAborted();

      return {
        session: this.#session(reservation.sandbox),
        isFirstCreate: reservation.isFirstCreate,
      };
    } catch (error) {
      if (reservation?.isFirstCreate) {
        await this.#executor
          .release?.({ reservationKey: this.#options.reservationKey })
          .catch(() => {});
      }
      throw error;
    }
  }

  async resumeSession(
    options: BroodsSandboxDriverResumeOptions,
  ): Promise<BroodsSandboxDriverSession> {
    options.abortSignal?.throwIfAborted();
    const sandbox = await this.#executor.resumeHarnessReservation({
      reservationKey: this.#options.reservationKey,
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
    options.abortSignal?.throwIfAborted();

    return this.#session(sandbox);
  }

  #assertBootstrapIdentity(identity: string | undefined): void {
    if (identity === undefined || this.#options.bootstrapIdentity === undefined)
      return;
    if (identity !== this.#options.bootstrapIdentity) {
      throw new Error(
        "Workdir Harness bootstrap identity does not match this reservation",
      );
    }
  }

  #session(sandbox: Sandbox): BroodsSandboxDriverSession {
    return new WorkdirHarnessSession({
      sandbox: sandbox,
      executor: this.#executor,
      reservationKey: this.#options.reservationKey,
      description: `Broods Workdir sandbox ${sandbox.id}`,
      defaultWorkingDirectory:
        this.#options.defaultWorkingDirectory ?? DEFAULT_WORKING_DIRECTORY,
      env: stringRecord(this.#options.config.envVars),
      ports: this.#options.ports ?? [],
      previewKey: workdirPreviewKey(this.#options.config),
    });
  }
}

interface WorkdirHarnessSessionOptions {
  sandbox: Sandbox;
  executor: WorkdirHarnessExecutor;
  reservationKey: string;
  description: string;
  defaultWorkingDirectory: string;
  env: Record<string, string>;
  ports: ReadonlyArray<number>;
  previewKey?: string;
}

class WorkdirHarnessSession implements BroodsSandboxDriverSession {
  readonly #sandbox: Sandbox;
  readonly #executor: WorkdirHarnessExecutor;
  readonly #reservationKey: string;
  readonly #defaultWorkingDirectory: string;
  readonly #env: Record<string, string>;
  readonly #previewKey: string | undefined;
  readonly #shell: HarnessShellExecutor;

  readonly id: string;
  readonly description: string;
  readonly ports: ReadonlyArray<number>;

  constructor(options: WorkdirHarnessSessionOptions) {
    this.#sandbox = options.sandbox;
    this.#executor = options.executor;
    this.#reservationKey = options.reservationKey;
    this.#defaultWorkingDirectory = options.defaultWorkingDirectory;
    this.#env = options.env;
    this.#previewKey = options.previewKey;
    this.id = options.sandbox.id;
    this.description = options.description;
    this.ports = [...options.ports];
    this.#shell = {
      exec: async (command, shellOptions) => {
        shellOptions?.abortSignal?.throwIfAborted();
        const result = await this.#sandbox.exec(
          command,
          shellOptions?.env ? { env: shellOptions.env } : {},
        );
        shellOptions?.abortSignal?.throwIfAborted();

        return {
          exitCode: result.exit_code,
          stdout: result.stdout,
          stderr: result.stderr,
        };
      },
    };
  }

  get defaultWorkingDirectory(): string {
    return this.#defaultWorkingDirectory;
  }

  async runCommand(options: BroodsSandboxCommandOptions): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }> {
    options.abortSignal?.throwIfAborted();
    const process = await this.spawnCommand(options);
    const [stdout, stderr, result] = await Promise.all([
      readHarnessStream(process.stdout),
      readHarnessStream(process.stderr),
      process.wait(),
    ]);

    return { exitCode: result.exitCode, stdout: stdout, stderr: stderr };
  }

  async spawnCommand(
    options: BroodsSandboxCommandOptions,
  ): Promise<HarnessShellProcess> {
    return HarnessShellProcess.start({
      executor: this.#shell,
      command: options.command,
      workingDirectory:
        options.workingDirectory ?? this.#defaultWorkingDirectory,
      env: { ...this.#env, ...options.env },
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
  }

  async readFile(
    options: BroodsSandboxFileOptions,
  ): Promise<Uint8Array | null> {
    options.abortSignal?.throwIfAborted();
    const path = shellQuote(options.path);
    const result = await this.#sandbox.exec(
      `if [ -f ${path} ]; then base64 < ${path} | tr -d '\\n'; elif [ ! -e ${path} ]; then exit 44; else exit 45; fi`,
    );
    options.abortSignal?.throwIfAborted();
    if (result.exit_code === 44) return null;
    if (result.exit_code !== 0) throw workdirError("read file", result);

    return new Uint8Array(Buffer.from(result.stdout.trim(), "base64"));
  }

  async writeFile(options: BroodsSandboxWriteFileOptions): Promise<void> {
    options.abortSignal?.throwIfAborted();
    const temporaryName = `.broods-harness-upload-${randomUUID()}`;
    const temporaryPath = `${DEFAULT_WORKING_DIRECTORY}/${temporaryName}`;
    try {
      await this.#sandbox.writeFile(
        temporaryName,
        Buffer.from(options.content).toString("base64"),
      );
      options.abortSignal?.throwIfAborted();
      const result = await this.#sandbox.exec(
        [
          `mkdir -p ${shellQuote(dirname(options.path))}`,
          `base64 -d ${shellQuote(temporaryPath)} > ${shellQuote(options.path)}`,
        ].join(" && "),
      );
      options.abortSignal?.throwIfAborted();
      if (result.exit_code !== 0) throw workdirError("write file", result);
    } finally {
      await this.#sandbox
        .exec(`rm -f ${shellQuote(temporaryPath)}`)
        .catch(() => {});
    }
  }

  async getPortUrl(options: {
    port: number;
    protocol?: "http" | "https" | "ws";
  }): Promise<string> {
    if (!this.#previewKey) {
      throw new Error("Workdir Harness port exposure requires an API key");
    }
    const exposed = new URL(await this.#sandbox.exposePort(options.port));
    exposed.searchParams.set("key", this.#previewKey);
    if (options.protocol === "ws") {
      exposed.protocol = exposed.protocol === "https:" ? "wss:" : "ws:";
    } else if (options.protocol) {
      exposed.protocol = `${options.protocol}:`;
    }

    return exposed.toString();
  }

  async stop(): Promise<void> {
    if (!this.#executor.suspend) {
      throw new Error("Workdir Harness reservation cannot be suspended");
    }
    await this.#executor.suspend({ reservationKey: this.#reservationKey });
  }

  async destroy(): Promise<void> {
    if (!this.#executor.release) {
      throw new Error("Workdir Harness reservation cannot be released");
    }
    await this.#executor.release({ reservationKey: this.#reservationKey });
  }
}

function isWorkdirHarnessExecutor(
  value: unknown,
): value is WorkdirHarnessExecutor {
  return (
    !!value &&
    typeof value === "object" &&
    "acquireHarnessReservation" in value &&
    typeof value.acquireHarnessReservation === "function" &&
    "resumeHarnessReservation" in value &&
    typeof value.resumeHarnessReservation === "function"
  );
}

function workdirError(
  operation: string,
  result: { stdout?: string; stderr?: string; exit_code: number },
): Error {
  return new Error(
    result.stderr ||
      result.stdout ||
      `Workdir failed to ${operation} (exit ${result.exit_code})`,
  );
}

function workdirPreviewKey(config: SandboxExecutorConfig): string | undefined {
  return configString(config.options?.apiKey) ?? optionalEnv("WORKDIR_API_KEY");
}
