/**
 * Core-owned AWS Lambda MicroVM driver for the AI SDK Harness sandbox adapter.
 * Reservation ownership stays in MicrovmSandboxExecutor; bridge WebSockets pass
 * through a loopback proxy so AWS authentication never enters a URL or log.
 */

import { Buffer } from "node:buffer";
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
import { createSandboxExecutor } from "./index.ts";
import {
  HarnessShellProcess,
  type HarnessShellExecutor,
  readHarnessStream,
} from "./harness-shell-process.ts";
import type { MicrovmHarnessReservation } from "./microvm-executor.ts";
import { MicrovmWebSocketProxy } from "./microvm-websocket-proxy.ts";
import type { SandboxExecutorConfig, SandboxReservationRef } from "./types.ts";
import { shellQuote, stringRecord } from "./utils.ts";

const DEFAULT_WORKING_DIRECTORY = "/workspace";

export interface MicrovmHarnessDriverOptions {
  /** Existing core reservation identity, already scoped to its account/agent. */
  reservationKey: string;
  /** Optional exact bootstrap identity for callers that precompute one. */
  bootstrapIdentity?: string;
  config: SandboxExecutorConfig & { provider: "lambda"; persistent: true };
  defaultWorkingDirectory?: string;
  ports?: ReadonlyArray<number>;
}

interface MicrovmHarnessExecutor {
  acquireHarnessReservation(request: {
    reservationKey: string;
    abortSignal?: AbortSignal;
  }): Promise<MicrovmHarnessReservation>;
  resumeHarnessReservation(request: {
    reservationKey: string;
    abortSignal?: AbortSignal;
  }): Promise<Omit<MicrovmHarnessReservation, "isFirstCreate">>;
  runHarnessCommand(request: {
    microvmId: string;
    endpoint: string;
    code: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  createHarnessAuthToken(microvmId: string, port: number): Promise<string>;
  suspend?(request: SandboxReservationRef): Promise<void>;
  release?(request: SandboxReservationRef): Promise<void>;
}

export function createMicrovmHarnessDriver(
  options: MicrovmHarnessDriverOptions,
): BroodsSandboxDriver {
  const executor = createSandboxExecutor(options.config);
  if (!isMicrovmHarnessExecutor(executor)) {
    throw new Error(
      "MicroVM Harness driver requires the core MicroVM executor",
    );
  }
  return new MicrovmHarnessDriver(options, executor);
}

export class MicrovmHarnessDriver implements BroodsSandboxDriver {
  readonly #options: MicrovmHarnessDriverOptions;
  readonly #executor: MicrovmHarnessExecutor;

  constructor(
    options: MicrovmHarnessDriverOptions,
    executor: MicrovmHarnessExecutor,
  ) {
    if (!options.reservationKey.trim()) {
      throw new Error("MicroVM Harness driver requires a reservationKey");
    }
    if (
      options.config.provider !== "lambda" ||
      options.config.persistent !== true
    ) {
      throw new Error(
        "MicroVM Harness driver requires a persistent lambda provider config",
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

    let reservation: MicrovmHarnessReservation | undefined;
    try {
      reservation = await this.#executor.acquireHarnessReservation({
        reservationKey: this.#options.reservationKey,
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });
      options.abortSignal?.throwIfAborted();
      return {
        session: this.#session(reservation),
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
    const reservation = await this.#executor.resumeHarnessReservation({
      reservationKey: this.#options.reservationKey,
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
    options.abortSignal?.throwIfAborted();
    return this.#session(reservation);
  }

  #assertBootstrapIdentity(identity: string | undefined): void {
    if (identity === undefined || this.#options.bootstrapIdentity === undefined)
      return;
    if (identity !== this.#options.bootstrapIdentity) {
      throw new Error(
        "MicroVM Harness bootstrap identity does not match this reservation",
      );
    }
  }

  #session(
    reservation: Omit<MicrovmHarnessReservation, "isFirstCreate">,
  ): BroodsSandboxDriverSession {
    return new MicrovmHarnessSession({
      reservation,
      executor: this.#executor,
      reservationKey: this.#options.reservationKey,
      defaultWorkingDirectory:
        this.#options.defaultWorkingDirectory ?? DEFAULT_WORKING_DIRECTORY,
      env: stringRecord(this.#options.config.envVars),
      ports: this.#options.ports ?? [],
    });
  }
}

interface MicrovmHarnessSessionOptions {
  reservation: Omit<MicrovmHarnessReservation, "isFirstCreate">;
  executor: MicrovmHarnessExecutor;
  reservationKey: string;
  defaultWorkingDirectory: string;
  env: Record<string, string>;
  ports: ReadonlyArray<number>;
}

class MicrovmHarnessSession implements BroodsSandboxDriverSession {
  readonly #executor: MicrovmHarnessExecutor;
  readonly #reservation: Omit<MicrovmHarnessReservation, "isFirstCreate">;
  readonly #reservationKey: string;
  readonly #defaultWorkingDirectory: string;
  readonly #env: Record<string, string>;
  readonly #proxy: MicrovmWebSocketProxy;
  readonly #shell: HarnessShellExecutor;

  readonly id: string;
  readonly description: string;
  readonly ports: ReadonlyArray<number>;

  constructor(options: MicrovmHarnessSessionOptions) {
    this.#executor = options.executor;
    this.#reservation = options.reservation;
    this.#reservationKey = options.reservationKey;
    this.#defaultWorkingDirectory = options.defaultWorkingDirectory;
    this.#env = options.env;
    this.id = options.reservation.microvmId;
    this.description = `Broods Lambda MicroVM ${options.reservation.microvmId}`;
    this.ports = [...options.ports];
    this.#proxy = new MicrovmWebSocketProxy({
      endpoint: options.reservation.endpoint,
      microvmId: options.reservation.microvmId,
      allowedPorts: this.ports,
      createAuthToken: (microvmId, port) =>
        this.#executor.createHarnessAuthToken(microvmId, port),
    });
    this.#shell = {
      exec: (command, shellOptions) =>
        this.#executor.runHarnessCommand({
          microvmId: this.#reservation.microvmId,
          endpoint: this.#reservation.endpoint,
          code: command,
          ...(shellOptions?.env ? { env: shellOptions.env } : {}),
          ...(shellOptions?.abortSignal
            ? { abortSignal: shellOptions.abortSignal }
            : {}),
        }),
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
    return { exitCode: result.exitCode, stdout, stderr };
  }

  async spawnCommand(
    options: BroodsSandboxCommandOptions,
  ): Promise<HarnessShellProcess> {
    return HarnessShellProcess.start({
      executor: this.#shell,
      command: options.command,
      workingDirectory:
        options.workingDirectory ?? this.#defaultWorkingDirectory,
      env: { ...this.#env, ...(options.env ?? {}) },
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    });
  }

  async readFile(
    options: BroodsSandboxFileOptions,
  ): Promise<Uint8Array | null> {
    options.abortSignal?.throwIfAborted();
    const path = shellQuote(options.path);
    const result = await this.#shell.exec(
      `if [ -f ${path} ]; then base64 < ${path} | tr -d '\\n'; elif [ ! -e ${path} ]; then exit 44; else exit 45; fi`,
      options.abortSignal ? { abortSignal: options.abortSignal } : undefined,
    );
    if (result.exitCode === 44) return null;
    if (result.exitCode !== 0) throw microvmError("read file", result);
    return new Uint8Array(Buffer.from(result.stdout.trim(), "base64"));
  }

  async writeFile(options: BroodsSandboxWriteFileOptions): Promise<void> {
    options.abortSignal?.throwIfAborted();
    const content = Buffer.from(options.content).toString("base64");
    const result = await this.#shell.exec(
      [
        `mkdir -p ${shellQuote(dirname(options.path))}`,
        `printf %s ${shellQuote(content)} | base64 -d > ${shellQuote(options.path)}`,
      ].join(" && "),
      options.abortSignal ? { abortSignal: options.abortSignal } : undefined,
    );
    if (result.exitCode !== 0) throw microvmError("write file", result);
  }

  async getPortUrl(options: {
    port: number;
    protocol?: "http" | "https" | "ws";
  }): Promise<string> {
    if (options.protocol !== undefined && options.protocol !== "ws") {
      throw new Error("MicroVM Harness proxy supports WebSocket ports only");
    }
    return this.#proxy.getPortUrl(options.port);
  }

  async stop(): Promise<void> {
    await this.#proxy.close();
    if (!this.#executor.suspend) {
      throw new Error("MicroVM Harness reservation cannot be suspended");
    }
    await this.#executor.suspend({ reservationKey: this.#reservationKey });
  }

  async destroy(): Promise<void> {
    await this.#proxy.close();
    if (!this.#executor.release) {
      throw new Error("MicroVM Harness reservation cannot be released");
    }
    await this.#executor.release({ reservationKey: this.#reservationKey });
  }
}

function isMicrovmHarnessExecutor(
  value: unknown,
): value is MicrovmHarnessExecutor {
  return (
    !!value &&
    typeof value === "object" &&
    "acquireHarnessReservation" in value &&
    typeof value.acquireHarnessReservation === "function" &&
    "resumeHarnessReservation" in value &&
    typeof value.resumeHarnessReservation === "function" &&
    "runHarnessCommand" in value &&
    typeof value.runHarnessCommand === "function" &&
    "createHarnessAuthToken" in value &&
    typeof value.createHarnessAuthToken === "function"
  );
}

function microvmError(
  operation: string,
  result: { stdout: string; stderr: string; exitCode: number },
): Error {
  return new Error(
    result.stderr ||
      result.stdout ||
      `MicroVM failed to ${operation} (exit ${result.exitCode})`,
  );
}
