import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";

// Test files run isolated from each other and each twin is checked alone, so both can run in
// separate processes at once. `--jobs=N` or SPEC_JOBS sets how many.
const ASKED = Number(
  process.argv.find((arg) => arg.startsWith("--jobs="))?.slice(7) ??
    process.env["SPEC_JOBS"],
);
export const JOBS =
  Number.isInteger(ASKED) && ASKED > 0 ? ASKED : availableParallelism();

export interface Finished {
  status: number | null;
  stdout: string;
}

// One child process, without blocking the others that run beside it.
export function launch(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeout?: number;
    quiet?: boolean;
  },
): Promise<Finished> {
  return new Promise((resolve): void => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout,
      killSignal: "SIGKILL",
      stdio: [
        "pipe",
        options.quiet ? "ignore" : "pipe",
        options.quiet ? "ignore" : "inherit",
      ],
    });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer): void => {
      chunks.push(chunk);
    });
    child.on("error", (): void => {
      resolve({ status: null, stdout: "" });
    });
    child.on("close", (status): void => {
      resolve({ status: status, stdout: Buffer.concat(chunks).toString() });
    });
    child.stdin.on("error", (): void => {});
    child.stdin.end(options.input ?? "");
  });
}

// Runs `work` over `items`, at most `limit` at once, and keeps the results in order. The first
// failure stops new work from starting and is thrown once the work under way has ended.
export async function pooled<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const failures: unknown[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && failures.length === 0) {
      const index = next;
      next += 1;
      try {
        results[index] = await work(items[index] as T);
      } catch (error) {
        failures.push(error);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  const failure = failures[0];
  if (failure !== undefined)
    throw failure instanceof Error
      ? failure
      : new Error("pooled work failed", { cause: failure });

  return results;
}
